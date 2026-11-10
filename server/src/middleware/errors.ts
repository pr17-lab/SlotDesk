import { STATUS_CODES } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import type { z } from 'zod';
import { logger } from '../logger.js';

export const notFoundHandler = (_req: Request, res: Response): void => {
  res.status(404).json({ error: 'Not found' });
};

// 400 for a request that failed Zod validation (D-030 error shape). Only the
// path and message of each issue are sent, never the rejected input.
export function sendValidationError(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: 'Bad Request',
    details: error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  });
}

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (res.headersSent) {
    return next(err);
  }

  // Express body-parser client errors (bad JSON, oversized body). Express sets
  // `status` (4xx) and `type` on these error objects. The `in` and `typeof`
  // checks let TypeScript treat err.status as a number inside this block,
  // without a cast.
  if (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof err.status === 'number' &&
    err.status >= 400 &&
    err.status <= 499
  ) {
    // Use the standard HTTP reason phrase; never expose parser message or stack.
    const phrase = STATUS_CODES[err.status] ?? 'Client Error';
    res.status(err.status).json({ error: phrase });
    return;
  }

  // Log unexpected errors with the error object; never expose message or stack in the response.
  logger.error({ err }, 'Unhandled error');

  res.status(500).json({ error: 'Internal server error' });
};
