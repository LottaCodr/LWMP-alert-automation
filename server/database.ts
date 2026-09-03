import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Keep the local demonstration data outside the generated TypeScript build directory.
const dataDirectory = path.resolve(process.cwd(), 'data');
fs.mkdirSync(dataDirectory, { recursive: true });

const dbPath = process.env.DATABASE_PATH || path.join(dataDirectory, 'living-water-alerts.db');
// SQLite is retained only for the local demo. The PostgreSQL adapter below is the production data boundary.
export const db: any = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

if (process.env.NODE_ENV === 'production') {
  const missing = ['DATABASE_URL', 'SESSION_SECRET', 'FIELD_ENCRYPTION_KEY', 'PHONE_HASH_KEY'].filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Refusing production startup: configure ${missing.join(', ')} through a secret manager.`);
  }
  throw new Error('The SQLite runtime is development-only. Start through server/entry.js so DATABASE_URL selects the PostgreSQL runtime.');
}

const encryptionMaterial = process.env.FIELD_ENCRYPTION_KEY || 'living-water-local-demo-key-change-before-production';
const hashMaterial = process.env.PHONE_HASH_KEY || 'living-water-local-demo-hash-key-change-before-production';
const encryptionKey = crypto.createHash('sha256').update(encryptionMaterial).digest();

export function encryptValue(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptValue(value) {
  if (!value) return null;
  const [version, ivEncoded, tagEncoded, encryptedEncoded] = String(value).split(':');
  if (version !== 'v1' || !ivEncoded || !tagEncoded || !encryptedEncoded) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivEncoded, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedEncoded, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

export function lookupHash(value) {
  return crypto.createHmac('sha256', hashMaterial).update(String(value || '').trim()).digest('hex');
}

export function newId(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function lagosDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
  };
}

export function toIsoDate({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','membership_officer','birthday_coordinator','auditor')),
      group_scope TEXT NOT NULL DEFAULT '[]',
      mfa_state TEXT NOT NULL DEFAULT 'required',
      mfa_required INTEGER NOT NULL DEFAULT 0,
      mfa_secret_encrypted TEXT,
      mfa_pending_secret_encrypted TEXT,
      mfa_pending_at TEXT,
      mfa_enrolled_at TEXT,
      passkey_enrolled_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff_invitations (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','membership_officer','birthday_coordinator','auditor')),
      group_scope TEXT NOT NULL DEFAULT '[]',
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      revoked_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_sent_at TEXT,
      delivery_provider TEXT,
      delivery_status TEXT,
      delivery_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_invitation_email ON staff_invitations(email, created_at DESC);

    CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON mfa_recovery_codes(user_id, used_at);

    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '[]',
      device_type TEXT,
      backed_up INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);

    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      member_code TEXT NOT NULL UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      preferred_name TEXT,
      phone_encrypted TEXT,
      phone_hash TEXT,
      birth_month INTEGER NOT NULL CHECK(birth_month BETWEEN 1 AND 12),
      birth_day INTEGER NOT NULL CHECK(birth_day BETWEEN 1 AND 31),
      birth_year INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','visitor','inactive','archived','deceased')),
      ministry_group TEXT NOT NULL DEFAULT 'General',
      birthday_alert_allowed INTEGER NOT NULL DEFAULT 1,
      consent_status TEXT NOT NULL DEFAULT 'recorded' CHECK(consent_status IN ('recorded','review_required','withdrawn')),
      consent_at TEXT,
      privacy_notice_version TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      archived_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_members_birthday ON members(status, birthday_alert_allowed, birth_month, birth_day);
    CREATE INDEX IF NOT EXISTS idx_members_phone_hash ON members(phone_hash);
    CREATE INDEX IF NOT EXISTS idx_members_name ON members(last_name, first_name);

    CREATE TABLE IF NOT EXISTS consent_records (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      lawful_basis TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('recorded','withdrawn','updated')),
      source TEXT NOT NULL,
      notice_version TEXT,
      recorded_at TEXT NOT NULL,
      recorded_by TEXT,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_consent_member ON consent_records(member_id, recorded_at DESC);

    CREATE TABLE IF NOT EXISTS admin_endpoints (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK(channel IN ('whatsapp','sms')),
      phone_encrypted TEXT NOT NULL,
      phone_hash TEXT NOT NULL,
      label TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      verified_at TEXT,
      opted_in_at TEXT,
      opted_out_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_endpoints_user ON admin_endpoints(user_id, enabled, priority);

    CREATE TABLE IF NOT EXISTS endpoint_verifications (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL REFERENCES admin_endpoints(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'endpoint_ownership',
      delivery_channel TEXT NOT NULL DEFAULT 'sms',
      provider TEXT,
      provider_message_id TEXT,
      requested_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_endpoint_verification_endpoint ON endpoint_verifications(endpoint_id, requested_at DESC);

    CREATE TABLE IF NOT EXISTS notification_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      digest_mode TEXT NOT NULL DEFAULT 'daily_digest' CHECK(digest_mode IN ('daily_digest','individual')),
      alert_time TEXT NOT NULL DEFAULT '07:30',
      timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
      days_before INTEGER NOT NULL DEFAULT 0 CHECK(days_before BETWEEN 0 AND 14),
      primary_channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK(primary_channel IN ('whatsapp','sms')),
      sms_fallback INTEGER NOT NULL DEFAULT 1,
      feb29_policy TEXT NOT NULL DEFAULT 'feb28' CHECK(feb29_policy IN ('feb28','mar1')),
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      notification_key TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint_id TEXT NOT NULL REFERENCES admin_endpoints(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK(channel IN ('whatsapp','sms')),
      notification_type TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      message_preview TEXT NOT NULL,
      member_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('scheduled','queued','provider_accepted','sent','delivered','read','failed','retrying','dead_letter')),
      provider TEXT,
      provider_message_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      delivered_at TEXT,
      read_at TEXT,
      last_event_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_provider_message ON notifications(provider_message_id);

    CREATE TABLE IF NOT EXISTS provider_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_hash TEXT NOT NULL UNIQUE,
      notification_id TEXT REFERENCES notifications(id) ON DELETE SET NULL,
      event_type TEXT,
      payload_summary TEXT,
      received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','processing','completed','failed','dead_letter')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox_jobs(status, due_at);

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      actor_name TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      summary TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
  `);
}

function ensureColumn(table, column, definition) {
  const existingColumns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!existingColumns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function ensureSchemaUpgrades() {
  // SQLite demo migrations. The production PostgreSQL migration is kept in migrations/.
  ensureColumn('users', 'mfa_required', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'mfa_secret_encrypted', 'TEXT');
  ensureColumn('users', 'mfa_pending_secret_encrypted', 'TEXT');
  ensureColumn('users', 'mfa_pending_at', 'TEXT');
  ensureColumn('users', 'mfa_enrolled_at', 'TEXT');
  ensureColumn('users', 'passkey_enrolled_at', 'TEXT');
  ensureColumn('endpoint_verifications', 'provider', 'TEXT');
}

function audit({ actorId = null, actorName = 'System', action, entityType, entityId = null, summary, metadata = null }) {
  db.prepare(`
    INSERT INTO audit_events (id, actor_id, actor_name, action, entity_type, entity_id, summary, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId('audit_'), actorId, actorName, action, entityType, entityId, summary, metadata ? JSON.stringify(metadata) : null, nowIso());
}

export { audit };

function addDays(parts, amount) {
  const cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  return { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate() };
}

function seedDatabase() {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (existing > 0) return;

  const timestamp = nowIso();
  const defaultPassword = bcrypt.hashSync('LivingWater@2026', 12);
  const users = [
    { id: 'usr_owner', name: 'Pastor Grace Nwosu', email: 'owner@livingwater.demo', role: 'owner', scope: [] },
    { id: 'usr_membership', name: 'Tosin Adeyemi', email: 'membership@livingwater.demo', role: 'membership_officer', scope: [] },
    { id: 'usr_birthdays', name: 'Ruth Okafor', email: 'birthdays@livingwater.demo', role: 'birthday_coordinator', scope: ['Welcome', 'Young Adults', 'General'] },
    { id: 'usr_auditor', name: 'Daniel Eze', email: 'audit@livingwater.demo', role: 'auditor', scope: [] },
  ];

  const insertUser = db.prepare(`
    INSERT INTO users (id, full_name, email, password_hash, role, group_scope, mfa_state, active, created_at, updated_at)
    VALUES (@id, @name, @email, @password, @role, @scope, 'demo_not_configured', 1, @createdAt, @createdAt)
  `);
  for (const user of users) {
    insertUser.run({ ...user, password: defaultPassword, scope: JSON.stringify(user.scope), createdAt: timestamp });
  }

  const insertEndpoint = db.prepare(`
    INSERT INTO admin_endpoints (id, user_id, channel, phone_encrypted, phone_hash, label, priority, enabled, verified_at, opted_in_at, created_at, updated_at)
    VALUES (@id, @userId, @channel, @phoneEncrypted, @phoneHash, @label, @priority, 1, @timestamp, @timestamp, @timestamp, @timestamp)
  `);
  const endpoints = [
    { id: 'endpoint_owner_wa', userId: 'usr_owner', channel: 'whatsapp', phone: '+2348035550100', label: 'Pastor Grace — WhatsApp', priority: 1 },
    { id: 'endpoint_owner_sms', userId: 'usr_owner', channel: 'sms', phone: '+2348035550100', label: 'Pastor Grace — SMS fallback', priority: 2 },
    { id: 'endpoint_birthday_wa', userId: 'usr_birthdays', channel: 'whatsapp', phone: '+2348055550101', label: 'Ruth — WhatsApp', priority: 1 },
    { id: 'endpoint_membership_sms', userId: 'usr_membership', channel: 'sms', phone: '+2348065550102', label: 'Tosin — SMS', priority: 1 },
  ];
  for (const endpoint of endpoints) {
    insertEndpoint.run({
      id: endpoint.id,
      userId: endpoint.userId,
      channel: endpoint.channel,
      phoneEncrypted: encryptValue(endpoint.phone),
      phoneHash: lookupHash(endpoint.phone),
      label: endpoint.label,
      priority: endpoint.priority,
      timestamp,
    });
  }

  db.prepare(`
    INSERT INTO notification_rules (id, name, enabled, digest_mode, alert_time, timezone, days_before, primary_channel, sms_fallback, feb29_policy, updated_at, updated_by)
    VALUES ('rule_daily_birthday', 'Daily birthday care digest', 1, 'daily_digest', '07:30', 'Africa/Lagos', 0, 'whatsapp', 1, 'feb28', ?, 'usr_owner')
  `).run(timestamp);

  db.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at, updated_by)
    VALUES ('parish_profile', ?, ?, 'usr_owner')
  `).run(JSON.stringify({
    parishName: 'Living Water Mega Parish – RCCG',
    timezone: 'Africa/Lagos',
    environment: 'demo',
  }), timestamp);

  const today = lagosDateParts();
  const dates = [
    { ...today, offset: 0 },
    { ...today, offset: 0 },
    { ...addDays(today, 1), offset: 1 },
    { ...addDays(today, 2), offset: 2 },
    { ...addDays(today, 3), offset: 3 },
    { ...addDays(today, 5), offset: 5 },
    { ...addDays(today, 7), offset: 7 },
    { ...addDays(today, 11), offset: 11 },
    { ...addDays(today, 15), offset: 15 },
  ];

  const memberSeed = [
    ['LW-1001', 'Chiamaka', 'Okoro', 'Chi', '+2348031111001', 'Welcome', 1992],
    ['LW-1002', 'David', 'Ifeanyi', 'David', '+2348031111002', 'Young Adults', 1989],
    ['LW-1003', 'Miriam', 'Afolabi', 'Miriam', '+2348031111003', 'Children', 2015],
    ['LW-1004', 'Tomiwa', 'Bello', 'Tomi', '+2348031111004', 'General', 1996],
    ['LW-1005', 'Emeka', 'Onyema', 'Emeka', '+2348031111005', 'Men', 1983],
    ['LW-1006', 'Esther', 'Danladi', 'Esther', '+2348031111006', 'Women', 1987],
    ['LW-1007', 'Favour', 'Wosu', 'Favour', '+2348031111007', 'Young Adults', 2000],
    ['LW-1008', 'Joseph', 'Akpan', 'Joe', '+2348031111008', 'General', 1978],
    ['LW-1009', 'Mercy', 'Obinna', 'Mercy', '+2348031111009', 'Welcome', 1991],
  ];

  const insertMember = db.prepare(`
    INSERT INTO members (
      id, member_code, first_name, last_name, preferred_name, phone_encrypted, phone_hash,
      birth_month, birth_day, birth_year, status, ministry_group, birthday_alert_allowed,
      consent_status, consent_at, privacy_notice_version, created_at, created_by, updated_at, updated_by
    ) VALUES (
      @id, @code, @firstName, @lastName, @preferredName, @phoneEncrypted, @phoneHash,
      @month, @day, @year, 'active', @groupName, 1, 'recorded', @timestamp, 'v1.0', @timestamp, 'usr_membership', @timestamp, 'usr_membership'
    )
  `);
  const insertConsent = db.prepare(`
    INSERT INTO consent_records (id, member_id, purpose, lawful_basis, action, source, notice_version, recorded_at, recorded_by, details)
    VALUES (?, ?, 'Membership care and birthday reminders', 'Recorded church membership purpose', 'recorded', 'Seeded demo record', 'v1.0', ?, 'usr_membership', 'Demo data only')
  `);

  memberSeed.forEach((member, index) => {
    const [code, firstName, lastName, preferredName, phone, groupName, year] = member;
    const date = dates[index];
    const memberId = `mem_${String(index + 1).padStart(4, '0')}`;
    insertMember.run({
      id: memberId,
      code,
      firstName,
      lastName,
      preferredName,
      phoneEncrypted: encryptValue(phone),
      phoneHash: lookupHash(phone),
      month: date.month,
      day: date.day,
      year,
      groupName,
      timestamp,
    });
    insertConsent.run(newId('consent_'), memberId, timestamp);
  });

  const yesterday = addDays(today, -1);
  const yesterdayDate = toIsoDate(yesterday);
  const insertNotification = db.prepare(`
    INSERT INTO notifications (
      id, notification_key, user_id, endpoint_id, channel, notification_type, scheduled_for,
      message_preview, member_count, status, provider, provider_message_id, attempts, created_at, sent_at, delivered_at, last_event_at
    ) VALUES (?, ?, ?, ?, ?, 'birthday_digest', ?, ?, ?, ?, 'mock', ?, 1, ?, ?, ?, ?)
  `);
  insertNotification.run(
    'notif_seed_1', `birthday-digest:${yesterdayDate}:usr_owner:whatsapp`, 'usr_owner', 'endpoint_owner_wa', 'whatsapp', yesterdayDate,
    '2 authorised birthdays were due. Open the secure dashboard to view them.', 2, 'delivered', 'mock_wa_seed_1', timestamp, timestamp, timestamp, timestamp,
  );
  insertNotification.run(
    'notif_seed_2', `birthday-digest:${yesterdayDate}:usr_birthdays:whatsapp`, 'usr_birthdays', 'endpoint_birthday_wa', 'whatsapp', yesterdayDate,
    '1 authorised birthday was due. Open the secure dashboard to view it.', 1, 'failed', 'mock_wa_seed_2', timestamp, timestamp, null, timestamp,
  );
  db.prepare('UPDATE notifications SET error_code = ?, error_message = ? WHERE id = ?').run('DEVICE_UNAVAILABLE', 'Demo delivery failure requiring fallback review.', 'notif_seed_2');

  audit({ actorId: 'system', actorName: 'System', action: 'seeded_demo', entityType: 'system', entityId: null, summary: 'Created safe demonstration parish data.' });
}

createSchema();
ensureSchemaUpgrades();
seedDatabase();

export function safeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    groupScope: JSON.parse(row.group_scope || '[]'),
    mfaState: row.mfa_state,
    mfaRequired: Boolean(row.mfa_required),
    mfaEnrolledAt: row.mfa_enrolled_at || null,
    passkeyEnrolledAt: row.passkey_enrolled_at || null,
    active: Boolean(row.active),
  };
}

export function memberDto(row, { revealPhone = false } = {}) {
  if (!row) return null;
  const phone = decryptValue(row.phone_encrypted);
  return {
    id: row.id,
    memberCode: row.member_code,
    firstName: row.first_name,
    lastName: row.last_name,
    preferredName: row.preferred_name,
    fullName: `${row.first_name} ${row.last_name}`,
    phone: revealPhone ? phone : phone ? `•••• ${phone.slice(-4)}` : null,
    phoneMasked: phone ? `•••• ${phone.slice(-4)}` : null,
    birthMonth: row.birth_month,
    birthDay: row.birth_day,
    birthYear: row.birth_year,
    status: row.status,
    ministryGroup: row.ministry_group,
    birthdayAlertAllowed: Boolean(row.birthday_alert_allowed),
    consentStatus: row.consent_status,
    consentAt: row.consent_at,
    privacyNoticeVersion: row.privacy_notice_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export function endpointDto(row, { revealPhone = false } = {}) {
  if (!row) return null;
  const phone = decryptValue(row.phone_encrypted);
  return {
    id: row.id,
    userId: row.user_id,
    channel: row.channel,
    label: row.label,
    phone: revealPhone ? phone : phone ? `•••• ${phone.slice(-4)}` : null,
    phoneMasked: phone ? `•••• ${phone.slice(-4)}` : null,
    priority: row.priority,
    enabled: Boolean(row.enabled),
    verifiedAt: row.verified_at,
    verificationRequired: !row.verified_at && !row.opted_out_at,
    optedInAt: row.opted_in_at,
    optedOutAt: row.opted_out_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function isValidMonthDay(month, day) {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1) return false;
  const maxDays = [31, isLeapYear(2000) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= maxDays;
}

export function daysFromLagosToday(amount) {
  return addDays(lagosDateParts(), amount);
}
