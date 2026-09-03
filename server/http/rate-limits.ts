import rateLimit from 'express-rate-limit';

/**
 * Rate limits for the endpoints that are worth brute-forcing.
 * Messages match the API error envelope so the client can render them directly.
 */

const envelope = (code: string, message: string): { error: { code: string; message: string } } => ({
  error: { code, message },
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: envelope('LOGIN_RATE_LIMIT', 'Too many sign-in attempts. Please wait 15 minutes and try again.'),
});

export const mfaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: envelope('MFA_RATE_LIMIT', 'Too many verification attempts. Wait 15 minutes and try again.'),
});

export const endpointVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: envelope(
    'ENDPOINT_VERIFICATION_RATE_LIMIT',
    'Too many verification messages have been requested. Try again in an hour.',
  ),
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: envelope('RATE_LIMITED', 'Too many requests. Please slow down and try again.'),
});
