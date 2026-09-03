import crypto from 'node:crypto';
import session from 'express-session';
import type { Session, SessionData } from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { Request, RequestHandler } from 'express';
import { config, sessionSecret } from '../config.js';
import { ApiError } from '../errors.js';
import { pool } from '../database-pg.js';
import { ALLOWED_HEADERS, ALLOWED_METHODS, isCrossOriginDeployment, originFor } from './cors.js';

const SESSION_COOKIE_NAME = 'lwmp.sid';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const WEBHOOK_PATHS = new Set(['/webhooks/whatsapp', '/webhooks/sms']);

function createSessionStore(): session.Store | undefined {
  // The in-memory demo runtime has no persistent session table; MemoryStore is fine there.
  if (config.DATABASE_URL === 'pgmem://' || config.DATABASE_URL === 'pgmem:') return undefined;
  const PgSessionStore = connectPgSimple(session);
  return new PgSessionStore({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
    pruneSessionInterval: 900,
  });
}

export function createSessionMiddleware(): RequestHandler {
  const store = createSessionStore();
  const secureCookies = config.isProduction || isCrossOriginDeployment;
  return session({
    ...(store ? { store } : {}),
    name: SESSION_COOKIE_NAME,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: secureCookies,
      // Split hosting (Vercel frontend + Render API) requires SameSite=None.
      sameSite: isCrossOriginDeployment ? 'none' : 'lax',
      maxAge: 1000 * 60 * 60 * 8,
    },
  });
}

export function issueCsrfToken(req: Request): string {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  return req.session.csrfToken;
}

export const csrfTokenHandler: RequestHandler = (req, res, next) => {
  try {
    const csrfToken = issueCsrfToken(req);
    req.session.save((error) => (error ? next(error) : res.json({ csrfToken })));
  } catch (error) {
    next(error);
  }
};

/**
 * Double-submit CSRF protection. Provider webhooks are exempt because they are
 * authenticated with HMAC signatures instead of a session cookie.
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (!UNSAFE_METHODS.has(req.method) || WEBHOOK_PATHS.has(req.path)) return next();
  const expected = req.session?.csrfToken;
  const supplied = req.get('x-csrf-token');
  const valid =
    typeof expected === 'string' &&
    typeof supplied === 'string' &&
    Buffer.byteLength(expected) === Buffer.byteLength(supplied) &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  if (valid) return next();
  return next(
    new ApiError(
      403,
      'Your secure session token is missing or expired. Refresh the page and try again.',
      'CSRF_INVALID',
    ),
  );
};

/** CORS + preflight handling for the configured origin allowlist. */
export const corsMiddleware: RequestHandler = (req, res, next) => {
  const origin = originFor(req.get('origin'));
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
};

function sessionError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export function saveRequestSession(req: Request): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    req.session.save((error) => (error ? reject(sessionError(error, 'Could not save the session.')) : resolve())),
  );
}

/** Regenerate the session id (session-fixation protection) and apply new values. */
export function regenerateSession(
  req: Request,
  mutate: (updated: Session & Partial<SessionData>) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    req.session.regenerate((error) => {
      if (error) return reject(sessionError(error, 'Could not regenerate the session.'));
      mutate(req.session);
      req.session.save((saveError) =>
        saveError ? reject(sessionError(saveError, 'Could not save the session.')) : resolve(),
      );
    }),
  );
}

export function destroySession(req: Request): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    req.session.destroy((error) => (error ? reject(sessionError(error, 'Could not destroy the session.')) : resolve())),
  );
}

export { SESSION_COOKIE_NAME };
