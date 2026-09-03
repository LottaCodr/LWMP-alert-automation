/**
 * A single error type for every predictable API failure.
 *
 * Handlers throw `ApiError`; the error middleware maps it to a stable
 * `{ error: { code, message, details } }` envelope that the client can render
 * without guessing at HTTP status codes.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, message: string, code = 'REQUEST_ERROR', details: unknown = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, code = 'BAD_REQUEST', details?: unknown): ApiError {
    return new ApiError(400, message, code, details);
  }

  static unauthorized(message: string, code = 'AUTH_REQUIRED', details?: unknown): ApiError {
    return new ApiError(401, message, code, details);
  }

  static forbidden(message = 'You do not have permission to perform this action.', code = 'FORBIDDEN'): ApiError {
    return new ApiError(403, message, code);
  }

  static notFound(message: string, code = 'NOT_FOUND'): ApiError {
    return new ApiError(404, message, code);
  }

  static conflict(message: string, code = 'CONFLICT', details?: unknown): ApiError {
    return new ApiError(409, message, code, details);
  }

  static unprocessable(message: string, code = 'VALIDATION_FAILED', details?: unknown): ApiError {
    return new ApiError(422, message, code, details);
  }

  static unavailable(message: string, code = 'SERVICE_UNAVAILABLE'): ApiError {
    return new ApiError(503, message, code);
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Normalise anything thrown into a printable message without leaking internals. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
