/**
 * Minimal, dependency-free HTTP client for the parish API.
 *
 * Responsibilities:
 *  - one place that knows the API origin (`VITE_API_BASE_URL` for split hosting);
 *  - double-submit CSRF handling, including one transparent retry after the
 *    session-bound token has been refreshed;
 *  - the `{ error: { code, message, details } }` envelope from `server/errors.ts`;
 *  - a single `session:expired` event so the shell can redirect to sign-in.
 */

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
    requestId?: string;
  };
}

/** Raised for every non-2xx API response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, message: string, code = 'API_ERROR', details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** True when the server rejected the credentials/session rather than the input. */
  get isAuthenticationError(): boolean {
    return this.status === 401;
  }
}

export const SESSION_EXPIRED_EVENT = 'lwmp:session-expired';

let csrfToken: string | null = null;
let csrfRequest: Promise<string> | null = null;

function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

async function readError(response: Response): Promise<ApiError> {
  let code = 'API_ERROR';
  let message = `Request failed with status ${response.status}.`;
  let details: unknown;
  try {
    const text = await response.text();
    if (text) {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const body = (parsed as ApiErrorBody).error;
        code = body?.code ?? code;
        message = body?.message ?? message;
        details = body?.details;
      } else {
        message = text.slice(0, 200);
      }
    }
  } catch {
    /* A non-JSON body (for example the Express HTML 500 page) keeps the default message. */
  }
  return new ApiError(response.status, message, code, details);
}

/** Fetch (and cache) the CSRF token bound to the current session cookie. */
export async function ensureCsrfToken(force = false): Promise<string> {
  if (csrfToken && !force) return csrfToken;
  if (csrfRequest && !force) return csrfRequest;

  csrfRequest = (async () => {
    const response = await fetch(apiUrl('/api/auth/csrf'), {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw await readError(response);
    const body = (await response.json()) as { csrfToken?: string };
    if (typeof body.csrfToken !== 'string' || !body.csrfToken) {
      throw new ApiError(500, 'The server did not issue a secure session token.', 'CSRF_INVALID');
    }
    csrfToken = body.csrfToken;
    return csrfToken;
  })();

  try {
    return await csrfRequest;
  } finally {
    csrfRequest = null;
  }
}

/** Drop the cached token (used after sign-out or a CSRF rejection). */
export function clearCsrfToken(): void {
  csrfToken = null;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the automatic CSRF preflight (no unsafe method) or the retry. */
  retryOnCsrf?: boolean;
}

async function perform(path: string, options: RequestOptions, token: string | null): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['x-csrf-token'] = token;

  return fetch(apiUrl(path), {
    method,
    credentials: 'include',
    headers,
    signal: options.signal,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/**
 * Perform a JSON request. Unsafe methods carry the CSRF token and are retried
 * once when the token in the browser cache no longer matches the session.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const unsafe = method !== 'GET';
  const token = unsafe ? await ensureCsrfToken() : null;

  let response = await perform(path, options, token);

  if (unsafe && response.status === 403 && options.retryOnCsrf !== false) {
    const rejection = await readError(response.clone()).catch(() => null);
    if (rejection?.code === 'CSRF_INVALID') {
      const refreshed = await ensureCsrfToken(true);
      response = await perform(path, options, refreshed);
    }
  }

  if (response.status === 401) {
    clearCsrfToken();
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { path } }));
  }

  if (response.status === 204) return undefined as T;
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
}

export function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'GET', signal });
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body });
}

export function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body });
}

export function patch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body });
}

export function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}
