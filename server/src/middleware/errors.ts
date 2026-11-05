import { STATUS_CODES } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

// A typed shape for Express body-parser client errors (bad JSON, oversized body).
// Express sets `status` (4xx) and `type` on these error objects.
interface ClientError {
  status: number;
}

function isClientError(err: unknown): err is ClientError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as Record<string, unknown>).status === 'number' &&
    (err as ClientError).status >= 400 &&
    (err as ClientError).status <= 499
  );
}

export const notFoundHandler = (_req: Request, res: Response): void => {
  res.status(404).json({ error: 'Not found' });
};

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (res.headersSent) {
    return next(err);
  }

  if (isClientError(err)) {
    // Use the standard HTTP reason phrase; never expose parser message or stack.
    const phrase = STATUS_CODES[err.status] ?? 'Client Error';
    res.status(err.status).json({ error: phrase });
    return;
  }

  // Log unexpected errors with the error object; never expose message or stack in the response.
  logger.error({ err }, 'Unhandled error');

  res.status(500).json({ error: 'Internal server error' });
};
