import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config, exposesDemoHints } from '../config.js';
import { ApiError } from '../errors.js';
import { audit, db, safeUser } from '../database-pg.js';
import {
  establishPreMfaSession,
  establishSession,
  preMfaUser,
  requireAuth,
  requireMfaSetup,
  sessionUser,
} from '../http/guards.js';
import { csrfTokenHandler, destroySession, SESSION_COOKIE_NAME } from '../http/session.js';
import { loginLimiter, mfaLimiter } from '../http/rate-limits.js';
import {
  beginTotpEnrollment,
  confirmTotpEnrollment,
  getMfaStatus,
  hasEnrolledMfa,
  mfaMethodsForUser,
  regenerateRecoveryCodes,
  useRecoveryCode,
  verifyTotpCode,
} from '../auth-pg.js';
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  completePasskeyAuthentication,
  completePasskeyRegistration,
} from '../services/passkeys.js';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { ROLE_LABELS, type UserRow, type UserRole } from '../types.js';

export const authRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const totpSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});
const mfaVerifySchema = z.object({ method: z.enum(['totp', 'recovery']), code: z.string().trim().min(6).max(40) });
authRouter.get('/csrf', csrfTokenHandler);

authRouter.get('/demo-accounts', async (_req, res) => {
  if (config.isProduction || config.SEED_DEMO_DATA !== 'true') {
    throw ApiError.notFound('Not found.');
  }
  const accounts = await db.all<{ full_name: string; email: string; role: UserRole }>(
    `SELECT full_name, email, role FROM users WHERE active = TRUE AND email LIKE '%@livingwater.demo' ORDER BY role, full_name`,
  );
  res.json({
    password: 'LivingWater@2026',
    accounts: accounts.map((row) => ({
      name: row.full_name,
      email: row.email,
      role: row.role,
      roleLabel: ROLE_LABELS[row.role],
    })),
  });
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) throw ApiError.unprocessable('Enter your email address and password.', 'INVALID_LOGIN');

  const user = await db.one<UserRow>(
    'SELECT * FROM users WHERE email = ? AND active = TRUE',
    parsed.data.email.toLowerCase().trim(),
  );
  const passwordMatches = user ? await bcrypt.compare(parsed.data.password, user.password_hash) : false;
  if (!user || !passwordMatches) {
    await audit({
      actorName: 'Anonymous',
      action: 'login_failed',
      entityType: 'authentication',
      summary: 'A sign-in attempt failed.',
    });
    throw ApiError.unauthorized('The email or password is incorrect.', 'INVALID_CREDENTIALS');
  }

  const methods = mfaMethodsForUser(user);
  if (methods.required) {
    await establishPreMfaSession(req, user);
    await audit({
      actorId: user.id,
      actorName: user.full_name,
      action: hasEnrolledMfa(user) ? 'password_verified_mfa_challenge' : 'password_verified_mfa_enrollment_required',
      entityType: 'authentication',
      entityId: user.id,
      summary: hasEnrolledMfa(user)
        ? 'Password accepted; MFA verification is required.'
        : 'Password accepted; initial MFA enrollment is required.',
    });
    res.json({
      requiresMfa: true,
      enrollmentRequired: !hasEnrolledMfa(user),
      methods,
      user: safeUser(user),
      demoMode: exposesDemoHints,
    });
    return;
  }

  await establishSession(req, user);
  await audit({
    actorId: user.id,
    actorName: user.full_name,
    action: 'login_succeeded',
    entityType: 'authentication',
    entityId: user.id,
    summary: 'Signed in to the parish dashboard.',
  });
  res.json({ user: safeUser(user), demoMode: exposesDemoHints });
});

authRouter.post('/logout', requireAuth, async (req, res) => {
  const actor = sessionUser(req);
  await destroySession(req);
  await audit({
    actorId: actor.id,
    actorName: actor.fullName,
    action: 'logout',
    entityType: 'authentication',
    entityId: actor.id,
    summary: 'Signed out of the parish dashboard.',
  });
  res.clearCookie(SESSION_COOKIE_NAME);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  const user = sessionUser(req);
  res.json({ user, demoMode: exposesDemoHints, roleLabel: ROLE_LABELS[user.role] });
});

/* ------------------------------------------------------------------ *
 * Multi-factor authentication
 * ------------------------------------------------------------------ */

authRouter.get('/mfa/status', requireMfaSetup, async (req, res) => {
  const user = sessionUser(req);
  res.json({ ...(await getMfaStatus(user.id)), preMfaChallenge: Boolean(req.session?.preMfaUserId) });
});

authRouter.post('/mfa/totp/start', requireMfaSetup, async (req, res) => {
  res.json({ enrollment: await beginTotpEnrollment(sessionUser(req)._row) });
});

authRouter.post('/mfa/totp/confirm', requireMfaSetup, mfaLimiter, async (req, res) => {
  const parsed = totpSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.unprocessable(
      'Enter the six-digit code from your authenticator app.',
      'INVALID_TOTP_CODE',
      parsed.error.issues,
    );
  }
  const user = sessionUser(req);
  const result = await confirmTotpEnrollment(user._row, parsed.data.code);
  const refreshed = await db.one<UserRow>('SELECT * FROM users WHERE id = ?', user.id);
  if (!refreshed) throw ApiError.unauthorized('This staff account is no longer active.');
  if (req.session?.preMfaUserId) await establishSession(req, refreshed);
  res.json({
    user: safeUser(refreshed),
    recoveryCodes: result.recoveryCodes,
    message: 'Authenticator app enrolled. Save the recovery codes somewhere safe now; they will not be shown again.',
  });
});

authRouter.post('/mfa/verify', mfaLimiter, async (req, res) => {
  const user = await preMfaUser(req);
  if (!user) throw ApiError.unauthorized('Your MFA challenge has expired. Sign in again.', 'MFA_CHALLENGE_EXPIRED');

  const parsed = mfaVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.unprocessable('Enter your authenticator or recovery code.', 'INVALID_MFA_CODE', parsed.error.issues);
  }
  const valid =
    parsed.data.method === 'totp'
      ? await verifyTotpCode(user, parsed.data.code)
      : await useRecoveryCode(user.id, parsed.data.code);
  if (!valid) {
    await audit({
      actorId: user.id,
      actorName: user.full_name,
      action: 'mfa_verification_failed',
      entityType: 'authentication',
      entityId: user.id,
      summary: 'An MFA code verification failed.',
    });
    throw ApiError.unauthorized('That verification code is not valid.', 'INVALID_MFA_CODE');
  }

  await establishSession(req, user);
  await audit({
    actorId: user.id,
    actorName: user.full_name,
    action: 'mfa_verification_succeeded',
    entityType: 'authentication',
    entityId: user.id,
    summary: `Completed ${parsed.data.method === 'totp' ? 'authenticator' : 'recovery code'} MFA verification.`,
  });
  res.json({ user: safeUser(user), demoMode: exposesDemoHints });
});

authRouter.post('/mfa/recovery-codes', requireAuth, mfaLimiter, async (req, res) => {
  const parsed = totpSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.unprocessable('Enter a current authenticator code.', 'INVALID_TOTP_CODE', parsed.error.issues);
  }
  const user = sessionUser(req);
  const recoveryCodes = await regenerateRecoveryCodes(user._row, parsed.data.code);
  res.json({ recoveryCodes, message: 'New recovery codes have replaced all prior unused recovery codes.' });
});

/* ------------------------------------------------------------------ *
 * Passkeys (WebAuthn)
 * ------------------------------------------------------------------ */

authRouter.post('/passkey/options', loginLimiter, async (req, res) => {
  const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.unprocessable('Enter the email address associated with your passkey.', 'INVALID_LOGIN');
  }
  const user = await db.one<UserRow>(
    'SELECT * FROM users WHERE email = ? AND active = TRUE',
    parsed.data.email.trim().toLowerCase(),
  );
  if (!user) throw ApiError.unauthorized('The requested passkey sign-in is not available.', 'PASSKEY_NOT_AVAILABLE');
  res.json({ options: await beginPasskeyAuthentication(req, user) });
});

authRouter.post('/passkey/verify', loginLimiter, async (req, res) => {
  const response = (req.body as { response?: AuthenticationResponseJSON })?.response;
  const user = await completePasskeyAuthentication(req, response);
  await establishSession(req, user);
  await audit({
    actorId: user.id,
    actorName: user.full_name,
    action: 'passkey_login_succeeded',
    entityType: 'authentication',
    entityId: user.id,
    summary: 'Signed in with a verified passkey.',
  });
  res.json({ user: safeUser(user), demoMode: exposesDemoHints });
});

authRouter.post('/mfa/passkey/options', requireMfaSetup, mfaLimiter, async (req, res) => {
  if (!req.session?.preMfaUserId) {
    throw ApiError.conflict(
      'Start with password sign-in before using a passkey as your second factor.',
      'MFA_CHALLENGE_REQUIRED',
    );
  }
  res.json({ options: await beginPasskeyAuthentication(req, sessionUser(req)._row, 'passkeyMfaAuthentication') });
});

authRouter.post('/mfa/passkey/verify', mfaLimiter, async (req, res) => {
  const response = (req.body as { response?: AuthenticationResponseJSON })?.response;
  const user = await completePasskeyAuthentication(req, response, 'passkeyMfaAuthentication');
  if (req.session?.preMfaUserId !== user.id) {
    throw ApiError.unauthorized(
      'This passkey challenge does not match the sign-in request.',
      'PASSKEY_VERIFICATION_FAILED',
    );
  }
  await establishSession(req, user);
  await audit({
    actorId: user.id,
    actorName: user.full_name,
    action: 'passkey_mfa_succeeded',
    entityType: 'authentication',
    entityId: user.id,
    summary: 'Completed MFA with a verified passkey.',
  });
  res.json({ user: safeUser(user), demoMode: exposesDemoHints });
});

authRouter.post('/passkeys/registration/options', requireMfaSetup, async (req, res) => {
  res.json({ options: await beginPasskeyRegistration(req, sessionUser(req)._row) });
});

authRouter.post('/passkeys/registration/verify', requireMfaSetup, async (req, res) => {
  const response = (req.body as { response?: RegistrationResponseJSON })?.response;
  const current = sessionUser(req);
  const user = await completePasskeyRegistration(req, response, current.id);
  if (req.session?.preMfaUserId) await establishSession(req, user);
  res.status(201).json({
    user: safeUser(user),
    message: 'Passkey enrolled successfully. It can now be used for secure sign-in.',
  });
});
