import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import type { SafeUser } from './types.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the PostgreSQL runtime.');
if (process.env.NODE_ENV === 'production') {
  const missing = ['SESSION_SECRET', 'FIELD_ENCRYPTION_KEY', 'PHONE_HASH_KEY', 'APP_ORIGIN', 'WEBAUTHN_ORIGIN', 'WEBAUTHN_RP_ID']
    .filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Refusing PostgreSQL production startup: configure ${missing.join(', ')} through Render encrypted environment variables.`);
  if (process.env.EMAIL_MODE !== 'resend' || !process.env.RESEND_API_KEY || !process.env.INVITE_FROM_EMAIL) {
    throw new Error('Refusing PostgreSQL production startup: configure Resend staff-invitation email (EMAIL_MODE=resend, RESEND_API_KEY, and INVITE_FROM_EMAIL).');
  }
  const messageMode = process.env.MESSAGE_MODE || 'mock';
  if (!['mock', 'live'].includes(messageMode)) throw new Error('MESSAGE_MODE must be mock or live.');
  if (messageMode === 'live') {
    const deliveryMissing = ['META_WHATSAPP_TOKEN', 'META_PHONE_NUMBER_ID', 'META_BIRTHDAY_TEMPLATE', 'META_APP_SECRET', 'TERMII_API_KEY', 'TERMII_SENDER_ID', 'TERMII_WEBHOOK_SECRET'].filter((name) => !process.env[name]);
    if (deliveryMissing.length) throw new Error(`Refusing live delivery startup: configure ${deliveryMissing.join(', ')} or keep MESSAGE_MODE=mock.`);
  }
}

const connectionString = process.env.DATABASE_URL;
// Render and Supabase both require TLS for hosted PostgreSQL connections.
const isManagedHostedUrl = /render\.(com|internal)|supabase\.co/.test(connectionString);
let poolInstance;
if (connectionString === 'pgmem://') {
  // Test-only in-memory PostgreSQL mode. pg-mem is a dev dependency and is never used on Render.
  const { newDb } = await import('pg-mem');
  const memoryDatabase = newDb({ autoCreateForeignKeyIndices: true });
  const pgMemory = memoryDatabase.adapters.createPg();
  poolInstance = new pgMemory.Pool();
  // Production uses managed PostgreSQL; pg-mem is test-only. Resolve migrations from the repository root so this also works after TypeScript compilation.
  const migrationsDirectory = path.resolve(process.cwd(), 'migrations');
  const migrationFiles = (await fs.readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
  for (const migrationFile of migrationFiles) {
    await poolInstance.query(await fs.readFile(path.join(migrationsDirectory, migrationFile), 'utf8'));
  }
} else {
  poolInstance = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    ssl: process.env.PGSSLMODE === 'require' || isManagedHostedUrl ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
  });
}
export const pool = poolInstance;

function convertPlaceholders(sql) {
  let index = 0;
  return String(sql).replace(/\?/g, () => `$${++index}`);
}

export type SqlRow = Record<string, any>;
export interface QueryClient {
  one<T extends SqlRow = SqlRow>(sql: string, ...params: any[]): Promise<T | null>;
  all<T extends SqlRow = SqlRow>(sql: string, ...params: any[]): Promise<T[]>;
  run(sql: string, ...params: any[]): Promise<{ changes: number }>;
}
export interface DatabaseClient extends QueryClient {
  transaction<T>(callback: (client: QueryClient) => Promise<T>): Promise<T>;
  ping(): Promise<true>;
}

function adapter(client: any): QueryClient {
  return {
    async one<T extends SqlRow = SqlRow>(sql: string, ...params: any[]): Promise<T | null> {
      const result = await client.query(convertPlaceholders(sql), params);
      return (result.rows[0] as T | undefined) || null;
    },
    async all<T extends SqlRow = SqlRow>(sql: string, ...params: any[]): Promise<T[]> {
      const result = await client.query(convertPlaceholders(sql), params);
      return result.rows as T[];
    },
    async run(sql: string, ...params: any[]): Promise<{ changes: number }> {
      const result = await client.query(convertPlaceholders(sql), params);
      return { changes: result.rowCount || 0 };
    },
  };
}

export const db: DatabaseClient = {
  ...adapter(pool),
  async transaction<T>(callback: (client: QueryClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(adapter(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },
  async ping() {
    await pool.query('SELECT 1');
    return true;
  },
};

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
    return Buffer.concat([decipher.update(Buffer.from(encryptedEncoded, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return null; }
}

export function lookupHash(value) {
  return crypto.createHmac('sha256', hashMaterial).update(String(value || '').trim()).digest('hex');
}
export function newId(prefix = '') { return `${prefix}${crypto.randomUUID()}`; }
export function nowIso() { return new Date().toISOString(); }
export function lagosDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')) };
}
export function toIsoDate({ year, month, day }) { return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }
export function isLeapYear(year) { return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); }
export function isValidMonthDay(month, day) {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1) return false;
  return day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function addDays(parts, amount) {
  const cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  return { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate() };
}
export function daysFromLagosToday(amount) { return addDays(lagosDateParts(), amount); }

export function safeUser(row: SqlRow | null): SafeUser | null {
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

export function memberDto(row: SqlRow | null, { revealPhone = false }: { revealPhone?: boolean } = {}) {
  if (!row) return null;
  const phone = decryptValue(row.phone_encrypted);
  return {
    id: row.id, memberCode: row.member_code, firstName: row.first_name, lastName: row.last_name,
    preferredName: row.preferred_name, fullName: `${row.first_name} ${row.last_name}`,
    phone: revealPhone ? phone : phone ? `•••• ${phone.slice(-4)}` : null,
    phoneMasked: phone ? `•••• ${phone.slice(-4)}` : null,
    birthMonth: Number(row.birth_month), birthDay: Number(row.birth_day), birthYear: row.birth_year ? Number(row.birth_year) : null,
    status: row.status, ministryGroup: row.ministry_group, birthdayAlertAllowed: Boolean(row.birthday_alert_allowed),
    consentStatus: row.consent_status, consentAt: row.consent_at, privacyNoticeVersion: row.privacy_notice_version,
    createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at,
  };
}

export function endpointDto(row: SqlRow | null, { revealPhone = false }: { revealPhone?: boolean } = {}) {
  if (!row) return null;
  const phone = decryptValue(row.phone_encrypted);
  return {
    id: row.id, userId: row.user_id, channel: row.channel, label: row.label,
    phone: revealPhone ? phone : phone ? `•••• ${phone.slice(-4)}` : null,
    phoneMasked: phone ? `•••• ${phone.slice(-4)}` : null,
    priority: Number(row.priority), enabled: Boolean(row.enabled), verifiedAt: row.verified_at,
    verificationRequired: !row.verified_at && !row.opted_out_at, optedInAt: row.opted_in_at,
    optedOutAt: row.opted_out_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function audit({ actorId = null, actorName = 'System', action, entityType, entityId = null, summary, metadata = null }, client = db) {
  await client.run(`
    INSERT INTO audit_events (id, actor_id, actor_name, action, entity_type, entity_id, summary, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, newId('audit_'), actorId, actorName, action, entityType, entityId, summary, metadata ? JSON.stringify(metadata) : null, nowIso());
}

async function seedPgMemoryDemo() {
  if (connectionString !== 'pgmem://' || process.env.SEED_DEMO_DATA !== 'true') return;
  const existing = await db.one('SELECT COUNT(*)::int AS count FROM users');
  if (Number(existing?.count || 0) > 0) return;
  const timestamp = nowIso();
  const passwordHash = await bcrypt.hash('LivingWater@2026', 10);
  const users = [
    ['usr_owner', 'Pastor Grace Nwosu', 'owner@livingwater.demo', 'owner', '[]'],
    ['usr_membership', 'Tosin Adeyemi', 'membership@livingwater.demo', 'membership_officer', '[]'],
    ['usr_birthdays', 'Ruth Okafor', 'birthdays@livingwater.demo', 'birthday_coordinator', '["Welcome","Young Adults","General"]'],
    ['usr_auditor', 'Daniel Eze', 'audit@livingwater.demo', 'auditor', '[]'],
  ];
  await db.transaction(async (tx) => {
    for (const [id, fullName, email, role, scope] of users) await tx.run(`INSERT INTO users (id, full_name, email, password_hash, role, group_scope, mfa_state, mfa_required, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'demo_not_configured', FALSE, TRUE, ?, ?)`, id, fullName, email, passwordHash, role, scope, timestamp, timestamp);
    await tx.run(`INSERT INTO notification_rules (id, name, enabled, digest_mode, alert_time, timezone, days_before, primary_channel, sms_fallback, feb29_policy, updated_at, updated_by) VALUES ('rule_daily_birthday', 'Daily birthday care digest', TRUE, 'daily_digest', '07:30', 'Africa/Lagos', 0, 'whatsapp', TRUE, 'feb28', ?, 'usr_owner')`, timestamp);
    await tx.run(`INSERT INTO app_settings (setting_key, setting_value, updated_at, updated_by) VALUES ('parish_profile', ?, ?, 'usr_owner')`, JSON.stringify({ parishName: 'Living Water Mega Parish – RCCG', timezone: 'Africa/Lagos', environment: 'pgmem-test' }), timestamp);
    const endpoints = [['endpoint_owner_wa','usr_owner','whatsapp','+2348035550100','Pastor Grace — WhatsApp',1],['endpoint_owner_sms','usr_owner','sms','+2348035550100','Pastor Grace — SMS fallback',2],['endpoint_birthday_wa','usr_birthdays','whatsapp','+2348055550101','Ruth — WhatsApp',1],['endpoint_membership_sms','usr_membership','sms','+2348065550102','Tosin — SMS',1]];
    for (const [id,userId,channel,phone,label,priority] of endpoints) await tx.run(`INSERT INTO admin_endpoints (id, user_id, channel, phone_encrypted, phone_hash, label, priority, enabled, verified_at, opted_in_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?, ?, ?)`, id, userId, channel, encryptValue(phone), lookupHash(phone), label, priority, timestamp, timestamp, timestamp, timestamp);
    const today = lagosDateParts(); const sample = [['LW-1001','Chiamaka','Okoro','Chi','+2348031111001','Welcome',1992,today.month,today.day],['LW-1002','David','Ifeanyi','David','+2348031111002','Young Adults',1989,today.month,today.day],['LW-1003','Miriam','Afolabi','Miriam','+2348031111003','Children',2015,today.month,Math.min(today.day + 1, 28)]];
    for (let index = 0; index < sample.length; index += 1) { const [code,first,last,preferred,phone,group,year,month,day] = sample[index]; const id = `mem_pg_${index + 1}`; await tx.run(`INSERT INTO members (id, member_code, first_name, last_name, preferred_name, phone_encrypted, phone_hash, birth_month, birth_day, birth_year, status, ministry_group, birthday_alert_allowed, consent_status, consent_at, privacy_notice_version, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, TRUE, 'recorded', ?, 'v1.0', ?, 'usr_membership', ?, 'usr_membership')`, id, code, first, last, preferred, encryptValue(phone), lookupHash(phone), month, day, year, group, timestamp, timestamp, timestamp); await tx.run(`INSERT INTO consent_records (id, member_id, purpose, lawful_basis, action, source, notice_version, recorded_at, recorded_by, details) VALUES (?, ?, 'Membership care and birthday reminders', 'Demo basis', 'recorded', 'pg-mem test', 'v1.0', ?, 'usr_membership', 'Test data only')`, newId('consent_'), id, timestamp); }
    await tx.run("SELECT setval('member_code_sequence', 1003, true)");
  });
  await audit({ actorId: 'system', actorName: 'System', action: 'seeded_pgmem_demo', entityType: 'system', summary: 'Created PostgreSQL test demonstration data.' });
}
await seedPgMemoryDemo();

export async function closeDatabase() { await pool.end(); }
