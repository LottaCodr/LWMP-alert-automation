import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';
import { ApiError } from '../errors.js';
import { db, nowIso, safeUser } from '../database-pg.js';
import { regenerateSession } from './session.js';
import type { MemberRow, SafeUser, UserRow, UserRole } from '../types.js';

const PRE_MFA_LIFETIME_MS = 15 * 60 * 1000;

/** The session user, guaranteed to be attached by `requireAuth`. */
export type SessionUser = SafeUser & { _row: UserRow };

export async function getUserById(id: string): Promise<UserRow | null> {
  return db.one<UserRow>('SELECT * FROM users WHERE id = ? AND active = TRUE', id);
}

export function establishSession(req: Request, user: UserRow): Promise<void> {
  const csrfToken = req.session?.csrfToken;
  return regenerateSession(req, (updated) => {
    updated.userId = user.id;
    if (csrfToken) updated.csrfToken = csrfToken;
    updated.authenticatedAt = nowIso();
    updated.mfaSatisfiedAt = nowIso();
  });
}

export function establishPreMfaSession(req: Request, user: UserRow): Promise<void> {
  const csrfToken = req.session?.csrfToken;
  return regenerateSession(req, (updated) => {
    updated.preMfaUserId = user.id;
    updated.preMfaStartedAt = nowIso();
    if (csrfToken) updated.csrfToken = csrfToken;
  });
}

/** A password-verified but MFA-pending user, valid for 15 minutes. */
export async function preMfaUser(req: Request): Promise<UserRow | null> {
  const startedAt = req.session?.preMfaStartedAt ? new Date(req.session.preMfaStartedAt).getTime() : 0;
  if (!req.session?.preMfaUserId || !startedAt || Date.now() - startedAt > PRE_MFA_LIFETIME_MS) return null;
  return getUserById(req.session.preMfaUserId);
}

function attachUser(req: Request, user: UserRow): void {
  const safe = safeUser(user);
  if (!safe) throw ApiError.unauthorized('Please sign in to continue.');
  req.user = { ...safe, _row: user };
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const user = req.session?.userId ? await getUserById(req.session.userId) : null;
    if (!user) return next(ApiError.unauthorized('Please sign in to continue.'));
    attachUser(req, user);
    return next();
  } catch (error) {
    return next(error);
  }
};

/** Allows either a fully authenticated user or an MFA-pending one (for enrolment flows). */
export const requireMfaSetup: RequestHandler = async (req, _res, next) => {
  try {
    const user = req.session?.userId ? await getUserById(req.session.userId) : await preMfaUser(req);
    if (!user)
      return next(
        ApiError.unauthorized(
          'Start with your invitation or sign in before configuring MFA.',
          'MFA_SETUP_AUTH_REQUIRED',
        ),
      );
    attachUser(req, user);
    return next();
  } catch (error) {
    return next(error);
  }
};

export function requireRoles(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(ApiError.forbidden());
    }
    return next();
  };
}

/** Narrows `req.user` after `requireAuth`; throws if the guard chain is misconfigured. */
export function sessionUser(req: Request): SessionUser {
  const user = req.user as SessionUser | undefined;
  if (!user?._row) throw ApiError.unauthorized('Please sign in to continue.');
  return user;
}

export function canRevealPhone(user: SafeUser): boolean {
  return user.role === 'owner' || user.role === 'membership_officer';
}

export function canViewMember(user: SafeUser, member: MemberRow): boolean {
  if (user.role === 'owner' || user.role === 'membership_officer') return true;
  if (user.role === 'birthday_coordinator') {
    return user.groupScope.length === 0 || user.groupScope.includes(member.ministry_group);
  }
  return false;
}

export function applicationBaseUrl(req: Request): string {
  const base = config.APP_ORIGIN ?? config.RENDER_EXTERNAL_URL ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`;
  return base.replace(/\/$/, '');
}

export interface WebAuthnSettings {
  origin: string;
  rpID: string;
}

export function webAuthnConfiguration(req: Request): WebAuthnSettings {
  const origin = config.WEBAUTHN_ORIGIN ?? applicationBaseUrl(req);
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw ApiError.unavailable('The passkey origin is not configured correctly.', 'PASSKEY_CONFIGURATION_ERROR');
  }
  const rpID = config.WEBAUTHN_RP_ID ?? parsed.hostname;
  if (config.isProduction && (!config.WEBAUTHN_ORIGIN || !config.WEBAUTHN_RP_ID)) {
    throw ApiError.unavailable(
      'Passkeys are not ready yet. Configure WEBAUTHN_ORIGIN and WEBAUTHN_RP_ID before enabling passkeys.',
      'PASSKEY_CONFIGURATION_REQUIRED',
    );
  }
  if (config.isProduction && parsed.protocol !== 'https:') {
    throw ApiError.unavailable('Passkeys require an HTTPS application origin.', 'PASSKEY_HTTPS_REQUIRED');
  }
  return { origin, rpID };
}

export type { NextFunction, Request, Response };
