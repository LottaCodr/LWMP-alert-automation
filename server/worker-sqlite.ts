import cron from 'node-cron';
import { lagosDateParts, toIsoDate } from './database.js';
import { getNotificationRuleDto, processOutboxJobs, runBirthdayNotifications } from './notification-service.js';

function lagosClock() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('hour')}:${get('minute')}`;
}

let lastRunMinute = null;
async function tick() {
  try {
    const rule = getNotificationRuleDto();
    const nowMinute = lagosClock();
    const minuteKey = `${toIsoDate(lagosDateParts())}:${nowMinute}`;
    if (rule?.enabled && rule.alertTime === nowMinute && lastRunMinute !== minuteKey) {
      lastRunMinute = minuteKey;
      const outcome = await runBirthdayNotifications();
      console.log(`Birthday care schedule evaluated: ${JSON.stringify({ date: outcome.date, created: outcome.created, skipped: outcome.skipped })}`);
    }
    processOutboxJobs();
  } catch (error) { console.error('Birthday care worker tick failed', error); }
}

await tick();
cron.schedule('* * * * *', tick, { timezone: 'Africa/Lagos' });
console.log('Living Water SQLite birthday-care worker is running (Africa/Lagos).');
