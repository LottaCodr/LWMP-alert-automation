import cron from 'node-cron';
import { closeDatabase, lagosDateParts, toIsoDate } from './database-pg.js';
import { getNotificationRuleDto, processOutboxJobs, runBirthdayNotifications } from './notification-pg.js';

function lagosClock() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('hour')}:${get('minute')}`;
}

let lastRunMinute = null;
async function tick() {
  try {
    const rule = await getNotificationRuleDto();
    const nowMinute = lagosClock();
    const minuteKey = `${toIsoDate(lagosDateParts())}:${nowMinute}`;
    if (rule?.enabled && rule.alertTime === nowMinute && lastRunMinute !== minuteKey) {
      lastRunMinute = minuteKey;
      const outcome = await runBirthdayNotifications();
      console.log(`Birthday care schedule evaluated: ${JSON.stringify({ date: outcome.date, created: outcome.created, skipped: outcome.skipped })}`);
    }
    await processOutboxJobs();
  } catch (error) {
    console.error('Birthday care worker tick failed', error);
  }
}

await tick();
cron.schedule('* * * * *', tick, { timezone: 'Africa/Lagos' });
console.log('Living Water PostgreSQL birthday-care worker is running (Africa/Lagos).');

async function close(signal) {
  console.log(`${signal} received; closing worker.`);
  await closeDatabase().catch(() => {});
  process.exit(0);
}
process.once('SIGTERM', () => close('SIGTERM'));
process.once('SIGINT', () => close('SIGINT'));
