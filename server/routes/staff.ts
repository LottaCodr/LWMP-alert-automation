import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { requireAuth, requireRoles, sessionUser } from '../http/guards.js';
import { applicationBaseUrl } from '../http/guards.js';
import { createStaffInvitation, deactivateStaffAccount, listStaffAccess, revokeInvitation } from '../auth-pg.js';

export const staffRouter = Router();

const staffInvitationSchema = z.object({
  fullName: z.string().trim().min(3).max(120),
  email: z.string().trim().email(),
  role: z.enum(['owner', 'membership_officer', 'birthday_coordinator', 'auditor']),
  groupScope: z.array(z.string().trim().min(2).max(80)).max(30).default([]),
});

staffRouter.use(requireAuth, requireRoles('owner'));

staffRouter.get('/access', async (_req, res) => {
  res.json(await listStaffAccess());
});

staffRouter.post('/invitations', async (req, res) => {
  const parsed = staffInvitationSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.unprocessable(
      'Check the staff invitation details.',
      'INVALID_STAFF_INVITATION',
      parsed.error.issues,
    );
  }
  const result = await createStaffInvitation(
    { ...parsed.data, groupScope: [...new Set(parsed.data.groupScope)] },
    sessionUser(req),
    applicationBaseUrl(req),
  );
  res.status(201).json({
    ...result,
    message:
      result.delivery.status === 'delivered'
        ? 'Staff invitation created and email delivery was accepted.'
        : 'Staff invitation was created, but email delivery failed. Check the configured email provider before inviting again.',
  });
});

staffRouter.post('/invitations/:id/revoke', async (req, res) => {
  await revokeInvitation(String(req.params.id), sessionUser(req));
  res.status(204).end();
});

staffRouter.post('/:id/deactivate', async (req, res) => {
  await deactivateStaffAccount(String(req.params.id), sessionUser(req));
  res.status(204).end();
});
