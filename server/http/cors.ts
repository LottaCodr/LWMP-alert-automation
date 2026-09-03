import { config } from '../config.js';

/**
 * Cross-origin support for split hosting (for example a Vercel frontend calling
 * a Render API). The allowlist is explicit: a credentialed request is only
 * answered for origins the parish has configured.
 */
export const allowedOrigins: string[] = (config.CORS_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

/** True when the browser and API are on different origins, which requires SameSite=None. */
export const isCrossOriginDeployment = allowedOrigins.length > 0;

export const ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
export const ALLOWED_HEADERS = 'Content-Type,X-CSRF-Token,X-Requested-With';

export function originFor(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const origin = headerValue.replace(/\/$/, '');
  return allowedOrigins.includes(origin) ? origin : null;
}
