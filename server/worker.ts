import cron from 'node-cron';
import { logger } from './logger.js';
import { scheduledTick } from './scheduler.js';
import { closeDatabase } from './database-pg.js';

/**
 * Dedicated delivery worker.
 *
 * Runs the daily Africa/Lagos birthday rule and drains the durable outbox every
 * minute. Deploy exactly one worker; the outbox uses `FOR UPDATE SKIP LOCKED`, so
 * a second worker is safe but redundant.
 */

await scheduledTick();
cron.schedule('* * * * *', () => void scheduledTick(), { timezone: 'Africa/Lagos' });
logger.info('Living Water birthday-care worker running', { timezone: 'Africa/Lagos' });

let closing = false;
async function close(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  logger.info('Worker shutting down', { signal });
  await closeDatabase().catch(() => undefined);
  process.exit(0);
}

process.once('SIGTERM', () => void close('SIGTERM'));
process.once('SIGINT', () => void close('SIGINT'));
