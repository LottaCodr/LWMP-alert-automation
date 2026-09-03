import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

// The script may run from TypeScript output under build/scripts; migrations remain at the repository root.
const migrationsDirectory = path.resolve(process.cwd(), 'migrations');
// A direct, administration-only URL can be supplied for migrations (for example
// Supabase's direct endpoint), while the long-lived application uses a pooler.
const connectionString = process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    'DATABASE_URL or MIGRATIONS_DATABASE_URL is required. Keep either value in encrypted deployment configuration.',
  );
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl:
    process.env.PGSSLMODE === 'require' || /render\.(com|internal)|supabase\.co/.test(connectionString)
      ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : undefined,
});

function checksum(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

try {
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const files = (await fs.readdir(migrationsDirectory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  for (const filename of files) {
    const content = await fs.readFile(path.join(migrationsDirectory, filename), 'utf8');
    const hash = checksum(content);
    const applied = await client.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE filename = $1',
      [filename],
    );
    const recorded = applied.rows[0];
    if (recorded) {
      if (recorded.checksum !== hash) {
        throw new Error(`Migration ${filename} was changed after application. Add a new migration instead.`);
      }
      console.log(`skip ${filename}`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(content);
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [filename, hash]);
      await client.query('COMMIT');
      console.log(`applied ${filename}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  console.log('PostgreSQL migrations are current.');
} catch (error) {
  console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
