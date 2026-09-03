import { Router } from 'express';
import { config } from '../config.js';
import { ApiError } from '../errors.js';
import { db, nowIso } from '../database-pg.js';

export const healthRouter = Router();

/** Liveness: answers without touching the database. Safe for cold-start probes. */
healthRouter.get('/live', (_req, res) => {
  res.json({ ok: true, time: nowIso() });
});

/** Readiness: verifies the database connection before accepting traffic. */
healthRouter.get('/', async (_req, res) => {
  try {
    await db.ping();
  } catch {
    throw ApiError.unavailable('Database connection is unavailable.', 'DATABASE_UNHEALTHY');
  }
  res.json({
    ok: true,
    database: 'postgresql',
    mode: config.MESSAGE_MODE,
    scheduler: config.SCHEDULER_ENABLED === 'true',
    time: nowIso(),
  });
});
