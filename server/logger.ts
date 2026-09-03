import { config } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const DEFAULT_THRESHOLD = config.isProduction ? LEVEL_WEIGHT.info : LEVEL_WEIGHT.debug;

function threshold(): number {
  return config.LOG_LEVEL ? LEVEL_WEIGHT[config.LOG_LEVEL] : DEFAULT_THRESHOLD;
}

/**
 * Dependency-free structured logger.
 *
 * Production emits one JSON object per line so a log aggregator can index
 * fields; development prints a compact, human-readable line. Member data,
 * phone numbers, codes and provider secrets must never be logged.
 */
export const logger = {
  debug(message: string, fields: Record<string, unknown> = {}): void {
    emit('debug', message, fields);
  },
  info(message: string, fields: Record<string, unknown> = {}): void {
    emit('info', message, fields);
  },
  warn(message: string, fields: Record<string, unknown> = {}): void {
    emit('warn', message, fields);
  },
  error(message: string, fields: Record<string, unknown> = {}): void {
    emit('error', message, fields);
  },
};

function emit(level: Level, message: string, fields: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] < threshold()) return;
  const timestamp = new Date().toISOString();
  if (config.isProduction) {
    const { error, ...rest } = fields;
    const payload: Record<string, unknown> = { level, timestamp, message, ...rest };
    if (error) payload.error = serialiseError(error);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  const suffix = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${timestamp} ${level.toUpperCase().padEnd(5)} ${message}${suffix}\n`);
}

function serialiseError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  return { name: error.name, message: error.message, stack: error.stack };
}
