// Select the durable PostgreSQL runtime whenever DATABASE_URL is configured.
// SQLite remains intentionally limited to local demonstration use.
if (process.env.DATABASE_URL) {
  await import('./index-pg.js');
} else {
  await import('./index.js');
}
