import { STATUS_CODES } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import pg from 'pg';
import type { z } from 'zod';
import { logger } from '../logger.js';

// One body for every 404, so a missing route, a missing row and another
// organization's row cannot be told apart (D-030).
const NOT_FOUND_BODY = { error: 'Not found' };

export const notFoundHandler = (_req: Request, res: Response): void => {
  res.status(404).json(NOT_FOUND_BODY);
};

// What each PostgreSQL error code becomes in the API (D-033, Trade-off
// Record 4.3). A code not listed here is unexpected and stays a 500.
// 40P01 (deadlock) and 40001 (serialization failure) are not retried: with
// the resource row locked first they are not expected, and a 503 tells the
// client to try again.
const DATABASE_ERRORS: Record<string, { status: number; body: object }> = {
  '23P01': { status: 409, body: { error: 'Conflict' } }, // exclusion: slot taken
  '23505': { status: 409, body: { error: 'Conflict' } }, // unique: duplicate
  '23503': { status: 404, body: NOT_FOUND_BODY }, // foreign key: bad reference
  '23514': { status: 400, body: { error: 'Bad Request' } }, // check: bad value
  '40P01': { status: 503, body: { error: 'Service Unavailable' } },
  '40001': { status: 503, body: { error: 'Service Unavailable' } },
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

  // Known database errors. pg turns every error PostgreSQL sends back into a
  // pg.DatabaseError carrying the code, constraint and table.
  if (err instanceof pg.DatabaseError && err.code !== undefined) {
    const mapped = DATABASE_ERRORS[err.code];
    if (mapped !== undefined) {
      // Never log err.detail or the whole error: PostgreSQL puts the rejected
      // values there (for 23505 the duplicate key, for 23514 the whole row).
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

  // An unlisted database code is a 500. Log only the fields that name the
  // rule and the place, never the whole error: its detail holds the rejected
  // row, and its message (and so the first line of its stack) can hold a value,
  // for example `invalid input syntax for type bigint: "abc"`.
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

  // Log unexpected errors with the error object; never expose message or stack in the response.
  logger.error({ err }, 'Unhandled error');

  res.status(500).json({ error: 'Internal server error' });
};
