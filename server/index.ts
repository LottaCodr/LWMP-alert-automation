import cron from 'node-cron';
import { config } from './config.js';
import { logger } from './logger.js';
import { createApp } from './app.js';
import { scheduledTick } from './scheduler.js';
import { closeDatabase } from './database-pg.js';

/**
 * HTTP entry point.
 *
 * The birthday schedule normally runs in the dedicated worker (`npm run worker`).
 * Free hosting tiers cannot run a separate worker, so `SCHEDULER_ENABLED=true`
 * lets a single web service own both roles. Never enable it on more than one
 * instance: the database outbox is idempotent, but duplicate evaluation is waste.
 */

const app = createApp();
let shutdownStarted = false;

if (config.SCHEDULER_ENABLED === 'true') {
  cron.schedule('* * * * *', () => void scheduledTick(), { timezone: 'Africa/Lagos' });
  logger.info('In-process birthday scheduler enabled (Africa/Lagos)');
}

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info('Living Water Birthday Care API listening', {
    url: `http://${config.HOST}:${config.PORT}`,
    environment: config.NODE_ENV,
    messageMode: config.MESSAGE_MODE,
    scheduler: config.SCHEDULER_ENABLED === 'true' ? 'in-process' : 'external worker',
  });
});

async function shutdown(signal: string): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.info('Shutdown started', { signal });

  const timer = setTimeout(() => {
    logger.warn('Graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 10_000);
  timer.unref();

  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await closeDatabase().catch(() => undefined);
  clearTimeout(timer);
  logger.info('Shutdown complete');
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection', { error: reason }));
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  void shutdown('uncaughtException');
});

export { app, server };
