import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';
import { ApiError, errorMessage, isApiError } from '../errors.js';
import { logger } from '../logger.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new ApiError(404, 'API endpoint not found.', 'API_NOT_FOUND'));
};

interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

/**
 * The single place where failures become HTTP responses.
 *
 * Predictable `ApiError`s keep their message and code. Anything else is logged
 * with a correlation id and reported to the client as a generic 500, so internal
 * details never leak into a browser.
 */
export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const requestId = cryptoRequestId(req);
  const known = isApiError(error);
  const status = known ? error.status : 500;
  const code = known ? error.code : 'INTERNAL_ERROR';
  const message = known ? error.message : 'An unexpected error occurred. The parish team has been notified.';

  if (!known || status >= 500) {
    logger.error('Request failed', {
      requestId,
      method: req.method,
      path: req.originalUrl,
      status,
      code,
      error,
    });
  } else {
    logger.debug('Request rejected', { requestId, method: req.method, path: req.originalUrl, status, code });
  }

  if (!req.path.startsWith('/api/') && !req.originalUrl.startsWith('/api/')) {
    res.status(status).send(message);
    return;
  }

  const body: ErrorEnvelope = {
    error: {
      code,
      message,
      ...(known && error.details !== undefined ? { details: error.details } : {}),
      ...(config.isProduction ? {} : { requestId }),
    },
  };
  res.status(status).json(body);
};

function cryptoRequestId(req: Request): string {
  const existing = req.get('x-request-id');
  if (existing) return existing.slice(0, 64);
  const generated = (req as Request & { _requestId?: string })._requestId;
  if (generated) return generated;
  const value = `req_${Math.random().toString(36).slice(2, 10)}`;
  (req as Request & { _requestId?: string })._requestId = value;
  return value;
}

export { errorMessage };
