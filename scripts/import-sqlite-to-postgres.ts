// One-time, operator-run migration helper. It copies encrypted application values; it never decrypts phones.
// Run only after a tested backup and `npm run migrate:postgres`.
import Database from 'better-sqlite3';
import pg from 'pg';
import process from 'node:process';

const sourcePath = process.env.SOURCE_SQLITE_PATH;
const connectionString = process.env.DATABASE_URL;
if (!sourcePath || !connectionString) {
  console.error('Set SOURCE_SQLITE_PATH and DATABASE_URL in your terminal. Do not add either to .env.example or git.');
  process.exit(1);
}

const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
const target = new pg.Client({
  connectionString,
  ssl:
    process.env.PGSSLMODE === 'require' || /render\.(com|internal)|supabase\.co/.test(connectionString)
      ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : undefined,
});

const tables = [
  'users',
  'staff_invitations',
  'mfa_recovery_codes',
  'passkeys',
  'members',
  'consent_records',
  'admin_endpoints',
  'endpoint_verifications',
  'notification_rules',
  'notifications',
  'provider_events',
  'outbox_jobs',
  'audit_events',
  'app_settings',
];
const booleanColumns = new Set([
  'mfa_required',
  'active',
  'backed_up',
  'birthday_alert_allowed',
  'enabled',
  'sms_fallback',
]);

try {
  await target.connect();
  const existing = await target.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM users');
  if ((existing.rows[0]?.count ?? 0) > 0 && process.env.ALLOW_NONEMPTY_TARGET !== 'yes') {
    throw new Error(
      'The target users table is not empty. Refusing to merge data. Set ALLOW_NONEMPTY_TARGET=yes only after a reviewed reconciliation plan.',
    );
  }
  await target.query('BEGIN');
  for (const table of tables) {
    const columns = (source.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    if (!columns.length) continue;
    const rows = source.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    if (!rows.length) {
      console.log(`skip ${table} (empty)`);
      continue;
    }
    const quotedColumns = columns.map((column) => `"${column}"`).join(', ');
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    const sql = `INSERT INTO "${table}" (${quotedColumns}) VALUES (${placeholders})`;
    for (const row of rows) {
      const values = columns.map((column) =>
        booleanColumns.has(column) && row[column] !== null ? Boolean(row[column]) : row[column],
      );
      await target.query(sql, values);
    }
    console.log(`copied ${rows.length} ${table} row(s)`);
  }
  const memberCodes = source
    .prepare(`SELECT member_code FROM members WHERE member_code GLOB 'LW-[0-9]*'`)
    .all() as Array<{ member_code: string }>;
  const highestMemberCode = memberCodes.reduce<number>(
    (highest, row) => Math.max(highest, Number(String(row.member_code).slice(3)) || 0),
    1000,
  );
  await target.query(`SELECT setval('member_code_sequence', $1, true)`, [highestMemberCode]);
  await target.query('COMMIT');
  console.log(
    `SQLite-to-PostgreSQL import completed; next member code will follow LW-${highestMemberCode}. Validate counts, a test sign-in, and a restore before cutover.`,
  );
} catch (error) {
  await target.query('ROLLBACK').catch(() => {});
  console.error(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  source.close();
  await target.end().catch(() => {});
}
