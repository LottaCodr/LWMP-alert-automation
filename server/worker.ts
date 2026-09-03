if (process.env.DATABASE_URL) {
  await import('./worker-pg.js');
} else {
  await import('./worker-sqlite.js');
}
