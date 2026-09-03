import { Router } from 'express';
import { ApiError } from '../errors.js';
import { requireAuth, requireRoles, sessionUser } from '../http/guards.js';
import { lagosDateParts, parseIsoDate, toIsoDate } from '../domain/calendar.js';
import { processOutboxJobs, runBirthdayNotifications, sendTestNotification } from '../notification-pg.js';
import { getNotifications } from '../services/dashboard.js';

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get('/', async (req, res) => {
  const limit = typeof req.query.limit === 'string' ? req.query.limit : '';
  res.json({ items: await getNotifications(sessionUser(req), limit) });
});

notificationsRouter.post(
  '/test',
  requireRoles('owner', 'membership_officer', 'birthday_coordinator'),
  async (req, res) => {
    const result = await sendTestNotification(sessionUser(req));
    res.status(201).json({ result, message: `Test ${result.channel} alert processed in ${result.mode} mode.` });
  },
);

notificationsRouter.post('/run', requireRoles('owner'), async (req, res) => {
  const requested = (req.body as { date?: unknown })?.date;
  const date = typeof requested === 'string' && requested ? requested : toIsoDate(lagosDateParts());
  if (!parseIsoDate(date))
    throw ApiError.unprocessable('Choose a valid date in YYYY-MM-DD format.', 'INVALID_RUN_DATE');

  const result = await runBirthdayNotifications({ date, actor: sessionUser(req) });
  const jobsProcessed = await processOutboxJobs();
  res.json({
    result: { ...result, jobsProcessed },
    message: `Birthday rule evaluated for ${date}. Durable delivery jobs were queued and processed; duplicate delivery is automatically suppressed.`,
  });
});
