import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { db } from '../database-pg.js';
import { establishPreMfaSession } from '../http/guards.js';
import { loginLimiter } from '../http/rate-limits.js';
import { acceptStaffInvitation, findInvitation, mfaMethodsForUser, publicInvitationDto } from '../auth-pg.js';
import type { UserRow } from '../types.js';

export const invitationsRouter = Router();

const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine((value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value));

invitationsRouter.get('/:token', async (req, res) => {
  const token = String(req.params.token ?? '');
  if (token.length < 32) throw ApiError.notFound('This staff invitation is not available.', 'INVITATION_NOT_FOUND');
  const invitation = await findInvitation(token);
  if (!invitation) {
    throw ApiError.notFound(
      'This staff invitation is invalid, expired, revoked, or already used.',
      'INVITATION_NOT_FOUND',
    );
  }
  res.json({ invitation: publicInvitationDto(invitation) });
});

invitationsRouter.post('/:token/accept', loginLimiter, async (req, res) => {
  const parsed = z.object({ password: passwordSchema }).safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.unprocessable(
      'Choose a stronger password before creating your staff account.',
      'WEAK_PASSWORD',
      parsed.error.issues,
    );
  }
  const user = await acceptStaffInvitation(String(req.params.token ?? ''), parsed.data.password);
  if (!user) throw ApiError.notFound('Staff account could not be created.', 'INVITATION_NOT_FOUND');

  const rawUser = await db.one<UserRow>('SELECT * FROM users WHERE id = ?', user.id);
  if (!rawUser) throw ApiError.notFound('Staff account could not be re-read.', 'INVITATION_NOT_FOUND');
  await establishPreMfaSession(req, rawUser);

  res.status(201).json({
    user,
    requiresMfa: true,
    enrollmentRequired: true,
    methods: mfaMethodsForUser(rawUser),
    message: 'Account created. Set up an authenticator app or passkey before entering the dashboard.',
  });
});
