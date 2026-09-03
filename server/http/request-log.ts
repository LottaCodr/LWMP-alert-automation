import type { RequestHandler } from 'express';
import { logger } from '../logger.js';

/**
 * One structured access-log line per request.
 *
 * Query strings are omitted: they can carry search terms and invitation tokens.
 */
export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = process.hrtime.bigint();
  const pathOnly = req.originalUrl.split('?')[0] ?? req.path;
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const fields = {
      method: req.method,
      path: pathOnly,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ...(req.user ? { actorId: req.user.id } : {}),
    };
    if (res.statusCode >= 500) logger.error('Request completed', fields);
    else if (res.statusCode >= 400) logger.warn('Request completed', fields);
    else logger.info('Request completed', fields);
  });
  next();
};
