import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { ApiError } from '../errors.js';
import { requireAuth, requireRoles, sessionUser } from '../http/guards.js';
import { getNotificationRuleDto, updateNotificationRule } from '../notification-pg.js';
import { listUserEndpoints } from '../notification-pg.js';

export const settingsRouter = Router();

const ruleSchema = z.object({
  enabled: z.boolean(),
  digestMode: z.literal('daily_digest'),
  alertTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  daysBefore: z.coerce.number().int().min(0).max(14),
  primaryChannel: z.enum(['whatsapp', 'sms']),
  smsFallback: z.boolean(),
  feb29Policy: z.enum(['feb28', 'mar1']),
});

settingsRouter.use(requireAuth);

settingsRouter.get('/', async (req, res) => {
  const user = sessionUser(req);
  res.json({
    rule: await getNotificationRuleDto(),
    canManageRule: user.role === 'owner',
    endpoints: await listUserEndpoints(user, { revealPhone: true }),
    providerMode: config.MESSAGE_MODE,
  });
});

settingsRouter.put('/rule', requireRoles('owner'), async (req, res) => {
  const parsed = ruleSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.unprocessable('Check the notification rule values.', 'INVALID_RULE', parsed.error.issues);
  }
  res.json({ rule: await updateNotificationRule(parsed.data, sessionUser(req)) });
});
