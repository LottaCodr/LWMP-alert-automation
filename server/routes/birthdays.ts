import { Router } from 'express';
import { lagosDateParts, toIsoDate } from '../domain/calendar.js';
import { requireAuth, requireRoles, sessionUser } from '../http/guards.js';
import { upcomingBirthdays } from '../services/members.js';

export const birthdaysRouter = Router();

birthdaysRouter.use(requireAuth, requireRoles('owner', 'membership_officer', 'birthday_coordinator'));

birthdaysRouter.get('/today', async (req, res) => {
  res.json({ date: toIsoDate(lagosDateParts()), items: await upcomingBirthdays(sessionUser(req), 0) });
});

birthdaysRouter.get('/upcoming', async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  res.json({ items: await upcomingBirthdays(sessionUser(req), days), days });
});
