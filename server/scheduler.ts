import { lagosClock, lagosDateParts, toIsoDate } from './domain/calendar.js';
import { logger } from './logger.js';
import { getNotificationRuleDto, processOutboxJobs, runBirthdayNotifications } from './notification-pg.js';

/**
 * The birthday-care schedule, shared by the web service (when
 * `SCHEDULER_ENABLED=true`) and the dedicated worker.
 *
 * `lastRunMinute` guarantees the rule is evaluated at most once per Lagos
 * minute, and the notification key in the database guarantees at most one digest
 * per user per day even if two processes race.
 */
let lastRunMinute: string | null = null;

export async function scheduledTick(now: Date = new Date()): Promise<void> {
  try {
    const rule = await getNotificationRuleDto();
    const clock = lagosClock(now);
    const minuteKey = `${toIsoDate(lagosDateParts(now))}:${clock}`;

    if (rule?.enabled && rule.alertTime === clock && lastRunMinute !== minuteKey) {
      lastRunMinute = minuteKey;
      const outcome = await runBirthdayNotifications();
      logger.info('Birthday rule evaluated', {
        date: outcome.date,
        created: outcome.created,
        skipped: outcome.skipped,
      });
    }
    await processOutboxJobs();
  } catch (error) {
    logger.error('Scheduled tick failed', { error });
  }
}

/** Reset the per-minute dedupe key (used by tests). */
export function resetSchedulerState(): void {
  lastRunMinute = null;
}
