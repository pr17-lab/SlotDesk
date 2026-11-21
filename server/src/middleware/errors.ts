import { STATUS_CODES } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import pg from 'pg';
import type { z } from 'zod';
import { logger } from '../logger.js';

// One body for every 404, so a missing route, a missing row and another
// organization's row all look the same (D-030).
const NOT_FOUND_BODY = { error: 'Not found' };

export const notFoundHandler = (_req: Request, res: Response): void => {
  res.status(404).json(NOT_FOUND_BODY);
};

// What each PostgreSQL error code becomes in the API (D-033). Anything not
// listed stays a 500. Deadlocks (40P01) and serialization failures (40001)
// aren't retried: with the resource row locked first we don't expect them,
// and a 503 tells the client to try again.
const DATABASE_ERRORS: Record<string, { status: number; body: object }> = {
  '23P01': { status: 409, body: { error: 'Conflict' } }, // exclusion: slot taken
  '23505': { status: 409, body: { error: 'Conflict' } }, // unique: duplicate
  '23503': { status: 404, body: NOT_FOUND_BODY }, // foreign key: bad reference
  '23514': { status: 400, body: { error: 'Bad Request' } }, // check: bad value
  '40P01': { status: 503, body: { error: 'Service Unavailable' } },
  '40001': { status: 503, body: { error: 'Service Unavailable' } },
};

// 400 for a request that failed Zod validation. We send each issue's path
// and message, never the rejected input.
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

  // Body-parser errors (bad JSON, body too big) carry a 4xx `status`. The
  // `in` and `typeof` checks let TypeScript see it as a number, no cast.
  if (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof err.status === 'number' &&
    err.status >= 400 &&
    err.status <= 499
  ) {
    // Just the standard reason phrase; never the parser's message or stack.
    const phrase = STATUS_CODES[err.status] ?? 'Client Error';
    res.status(err.status).json({ error: phrase });
    return;
  }

  // Known database errors. pg wraps every PostgreSQL error in a
  // pg.DatabaseError with the code, constraint and table.
  if (err instanceof pg.DatabaseError && err.code !== undefined) {
    const mapped = DATABASE_ERRORS[err.code];
    if (mapped !== undefined) {
      // Never log err.detail or the whole error: that's where PostgreSQL puts
      // the rejected values, like a customer's email.
      logger.warn(
        { code: err.code, constraint: err.constraint, table: err.table },
        'Database error mapped to a client response',
      );
      if (mapped.status === 503) {
        res.set('Retry-After', '1');
      }
      res.status(mapped.status).json(mapped.body);
      return;
    }
  }

  // Any other database error is a 500. Log only the fields that say which
  // rule and where. Never the whole error: detail holds the rejected row, and
  // even the message (so the stack too) can hold a value.
  if (err instanceof pg.DatabaseError) {
    logger.error(
      {
        code: err.code,
        constraint: err.constraint,
        table: err.table,
        column: err.column,
        routine: err.routine,
      },
      'Unhandled database error',
    );
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  // Log the whole error, but never send its message or stack to the client.
  logger.error({ err }, 'Unhandled error');

  res.status(500).json({ error: 'Internal server error' });
};
