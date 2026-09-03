import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import pg from 'pg';
// Type-only, so the runtime keeps pg-mem as an optional dev dependency.
import type { newDb as pgMemNewDb } from 'pg-mem';
import { config, fieldEncryptionMaterial, phoneHashMaterial } from './config.js';
import { logger } from './logger.js';
import { lagosDateParts } from './domain/calendar.js';
import { maskPhone } from './domain/phone.js';
import type { AdminEndpointRow, CountRow, EndpointDto, MemberDto, MemberRow, SafeUser, UserRow } from './types.js';

if (!config.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required. Set it to a managed PostgreSQL connection string, or use `pgmem://` for the seeded in-memory demo.',
  );
}

const connectionString: string = config.DATABASE_URL;
const isInMemoryDemo = connectionString === 'pgmem://' || connectionString === 'pgmem:';

/** Render and Supabase both require TLS for hosted PostgreSQL connections. */
const isManagedHostedUrl = /render\.(com|internal)|supabase\.co|neon\.tech|postgres\.dev/.test(connectionString);

async function createInMemoryPool(): Promise<pg.Pool> {
  let newDb: typeof pgMemNewDb;
  try {
    ({ newDb } = await import('pg-mem'));
  } catch {
    throw new Error(
      'DATABASE_URL=pgmem:// needs the pg-mem dev dependency. Run `npm install` (which includes dev dependencies) or point DATABASE_URL at a real PostgreSQL instance.',
    );
  }
  const memoryDatabase = newDb({ autoCreateForeignKeyIndices: true });
  const pgMemory = memoryDatabase.adapters.createPg() as unknown as { Pool: typeof pg.Pool };
  const memoryPool = new pgMemory.Pool();
  // Resolve migrations from the repository root so this also works after compilation.
  const migrationsDirectory = path.resolve(process.cwd(), 'migrations');
  const migrationFiles = (await fs.readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
  for (const migrationFile of migrationFiles) {
    await memoryPool.query(await fs.readFile(path.join(migrationsDirectory, migrationFile), 'utf8'));
  }
  return memoryPool;
}

export const pool: pg.Pool = isInMemoryDemo
  ? await createInMemoryPool()
  : new pg.Pool({
      connectionString,
      max: config.PG_POOL_MAX,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      ssl:
        config.PGSSLMODE === 'require' || isManagedHostedUrl
          ? { rejectUnauthorized: config.PG_SSL_REJECT_UNAUTHORIZED !== 'false' }
          : undefined,
    });

/** Translate the portable `?` placeholders used across the codebase into `$n`. */
function convertPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

export interface RunResult {
  changes: number;
}

export interface QueryClient {
  one<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<RunResult>;
}

export interface DatabaseClient extends QueryClient {
  transaction<T>(callback: (client: QueryClient) => Promise<T>): Promise<T>;
  ping(): Promise<true>;
}

type AnyPoolClient = pg.Pool | pg.PoolClient;

function adapter(client: AnyPoolClient): QueryClient {
  return {
    async one<T>(sql: string, ...params: unknown[]): Promise<T | null> {
      const result = await client.query(convertPlaceholders(sql), params as never[]);
      return (result.rows[0] as T | undefined) ?? null;
    },
    async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      const result = await client.query(convertPlaceholders(sql), params as never[]);
      return result.rows as T[];
    },
    async run(sql: string, ...params: unknown[]): Promise<RunResult> {
      const result = await client.query(convertPlaceholders(sql), params as never[]);
      return { changes: Number(result.rowCount ?? 0) };
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
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },
  async ping(): Promise<true> {
    await pool.query('SELECT 1');
    return true;
  },
};

/* ------------------------------------------------------------------ *
 * Field-level cryptography
 * ------------------------------------------------------------------ */

const encryptionKey = crypto.createHash('sha256').update(fieldEncryptionMaterial).digest();

/** AES-256-GCM with a random IV and an embedded auth tag per value. */
export function encryptValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const [version, ivEncoded, tagEncoded, encryptedEncoded] = String(value).split(':');
  if (version !== 'v1' || !ivEncoded || !tagEncoded || !encryptedEncoded) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivEncoded, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedEncoded, 'base64url')), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    return null;
  }
}

/** Deterministic HMAC used for equality lookups on encrypted columns. */
export function lookupHash(value: string | null | undefined): string {
  return crypto
    .createHmac('sha256', phoneHashMaterial)
    .update(String(value ?? '').trim())
    .digest('hex');
}

export function newId(prefix = ''): string {
  return `${prefix}${crypto.randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ *
 * Row -> DTO mappers
 * ------------------------------------------------------------------ */

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

export function safeUser(row: UserRow | null): SafeUser | null {
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    groupScope: parseJsonArray(row.group_scope),
    mfaState: row.mfa_state,
    mfaRequired: Boolean(row.mfa_required),
    mfaEnrolledAt: row.mfa_enrolled_at ?? null,
    passkeyEnrolledAt: row.passkey_enrolled_at ?? null,
    active: Boolean(row.active),
  };
}

export interface RevealOptions {
  revealPhone?: boolean;
}

export function memberDto(row: MemberRow, { revealPhone = false }: RevealOptions = {}): MemberDto {
  const phone = decryptValue(row.phone_encrypted);
  return {
    id: row.id,
    memberCode: row.member_code,
    firstName: row.first_name,
    lastName: row.last_name,
    preferredName: row.preferred_name,
    fullName: `${row.first_name} ${row.last_name}`,
    phone: revealPhone ? phone : maskPhone(phone),
    phoneMasked: maskPhone(phone),
    birthMonth: Number(row.birth_month),
    birthDay: Number(row.birth_day),
    birthYear: row.birth_year ? Number(row.birth_year) : null,
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

export function endpointDto(row: AdminEndpointRow, { revealPhone = false }: RevealOptions = {}): EndpointDto {
  const phone = decryptValue(row.phone_encrypted);
  return {
    id: row.id,
    userId: row.user_id,
    channel: row.channel,
    label: row.label,
    phone: revealPhone ? phone : maskPhone(phone),
    phoneMasked: maskPhone(phone),
    priority: Number(row.priority),
    enabled: Boolean(row.enabled),
    verifiedAt: row.verified_at,
    verificationRequired: !row.verified_at && !row.opted_out_at,
    optedInAt: row.opted_in_at,
    optedOutAt: row.opted_out_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------------ *
 * Audit trail
 * ------------------------------------------------------------------ */

export interface AuditInput {
  actorId?: string | null;
  actorName?: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  metadata?: Record<string, unknown> | null;
}

export async function audit(
  { actorId = null, actorName = 'System', action, entityType, entityId = null, summary, metadata = null }: AuditInput,
  client: QueryClient = db,
): Promise<void> {
  await client.run(
    `INSERT INTO audit_events (id, actor_id, actor_name, action, entity_type, entity_id, summary, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('audit_'),
    actorId,
    actorName,
    action,
    entityType,
    entityId,
    summary,
    metadata ? JSON.stringify(metadata) : null,
    nowIso(),
  );
}

export async function countUsers(): Promise<number> {
  const row = await db.one<CountRow>('SELECT COUNT(*)::int AS count FROM users');
  return Number(row?.count ?? 0);
}

/* ------------------------------------------------------------------ *
 * In-memory demo seed (never runs in production)
 * ------------------------------------------------------------------ */

const DEMO_PASSWORD = 'LivingWater@2026';

async function seedInMemoryDemo(): Promise<void> {
  if (!isInMemoryDemo || config.SEED_DEMO_DATA !== 'true') return;
  if ((await countUsers()) > 0) return;

  const timestamp = nowIso();
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const today = lagosDateParts();
  const users: Array<[string, string, string, UserRow['role'], string]> = [
    ['usr_owner', 'Pastor Grace Nwosu', 'owner@livingwater.demo', 'owner', '[]'],
    ['usr_membership', 'Tosin Adeyemi', 'membership@livingwater.demo', 'membership_officer', '[]'],
    [
      'usr_birthdays',
      'Ruth Okafor',
      'birthdays@livingwater.demo',
      'birthday_coordinator',
      '["Welcome","Young Adults","General"]',
    ],
    ['usr_auditor', 'Daniel Eze', 'audit@livingwater.demo', 'auditor', '[]'],
  ];
  const endpoints: Array<[string, string, AdminEndpointRow['channel'], string, string, number]> = [
    ['endpoint_owner_wa', 'usr_owner', 'whatsapp', '+2348035550100', 'Pastor Grace — WhatsApp', 1],
    ['endpoint_owner_sms', 'usr_owner', 'sms', '+2348035550100', 'Pastor Grace — SMS fallback', 2],
    ['endpoint_birthday_wa', 'usr_birthdays', 'whatsapp', '+2348055550101', 'Ruth — WhatsApp', 1],
    ['endpoint_membership_sms', 'usr_membership', 'sms', '+2348065550102', 'Tosin — SMS', 1],
  ];
  const members: Array<[string, string, string, string, string, string, number, number, number]> = [
    ['LW-1001', 'Chiamaka', 'Okoro', 'Chi', '+2348031111001', 'Welcome', 1992, today.month, today.day],
    ['LW-1002', 'David', 'Ifeanyi', 'David', '+2348031111002', 'Young Adults', 1989, today.month, today.day],
    [
      'LW-1003',
      'Miriam',
      'Afolabi',
      'Miriam',
      '+2348031111003',
      'Children',
      2015,
      today.month,
      Math.min(today.day + 1, 28),
    ],
  ];

  await db.transaction(async (tx) => {
    for (const [id, fullName, email, role, scope] of users) {
      await tx.run(
        `INSERT INTO users (id, full_name, email, password_hash, role, group_scope, mfa_state, mfa_required, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'demo_not_configured', FALSE, TRUE, ?, ?)`,
        id,
        fullName,
        email,
        passwordHash,
        role,
        scope,
        timestamp,
        timestamp,
      );
    }
    await tx.run(
      `INSERT INTO notification_rules (id, name, enabled, digest_mode, alert_time, timezone, days_before, primary_channel, sms_fallback, feb29_policy, updated_at, updated_by)
       VALUES ('rule_daily_birthday', 'Daily birthday care digest', TRUE, 'daily_digest', '07:30', 'Africa/Lagos', 0, 'whatsapp', TRUE, 'feb28', ?, 'usr_owner')`,
      timestamp,
    );
    await tx.run(
      `INSERT INTO app_settings (setting_key, setting_value, updated_at, updated_by)
       VALUES ('parish_profile', ?, ?, 'usr_owner')`,
      JSON.stringify({
        parishName: 'Living Water Mega Parish – RCCG',
        timezone: 'Africa/Lagos',
        environment: 'pgmem-demo',
      }),
      timestamp,
    );
    for (const [id, userId, channel, phone, label, priority] of endpoints) {
      await tx.run(
        `INSERT INTO admin_endpoints (id, user_id, channel, phone_encrypted, phone_hash, label, priority, enabled, verified_at, opted_in_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?, ?, ?)`,
        id,
        userId,
        channel,
        encryptValue(phone),
        lookupHash(phone),
        label,
        priority,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      );
    }
    for (const [
      index,
      [code, firstName, lastName, preferredName, phone, group, year, month, day],
    ] of members.entries()) {
      const id = `mem_pg_${index + 1}`;
      await tx.run(
        `INSERT INTO members (id, member_code, first_name, last_name, preferred_name, phone_encrypted, phone_hash, birth_month, birth_day, birth_year, status, ministry_group, birthday_alert_allowed, consent_status, consent_at, privacy_notice_version, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, TRUE, 'recorded', ?, 'v1.0', ?, 'usr_membership', ?, 'usr_membership')`,
        id,
        code,
        firstName,
        lastName,
        preferredName,
        encryptValue(phone),
        lookupHash(phone),
        month,
        day,
        year,
        group,
        timestamp,
        timestamp,
        timestamp,
      );
      await tx.run(
        `INSERT INTO consent_records (id, member_id, purpose, lawful_basis, action, source, notice_version, recorded_at, recorded_by, details)
         VALUES (?, ?, 'Membership care and birthday reminders', 'Demo basis', 'recorded', 'pg-mem demo', 'v1.0', ?, 'usr_membership', 'Test data only')`,
        newId('consent_'),
        id,
        timestamp,
      );
    }
    await tx.run("SELECT setval('member_code_sequence', 1003, true)");
  });

  await audit({
    actorId: 'system',
    actorName: 'System',
    action: 'seeded_demo_data',
    entityType: 'system',
    summary: 'Created in-memory demonstration data.',
  });
  logger.info('Seeded in-memory demo data', { users: users.length, members: members.length });
}

await seedInMemoryDemo();

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
