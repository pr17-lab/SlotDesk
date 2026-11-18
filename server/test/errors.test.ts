import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import pg from 'pg';
import request from 'supertest';
import { app } from '../src/app.js';
import { errorHandler } from '../src/middleware/errors.js';
import { logger } from '../src/logger.js';

describe('Error handling middleware', () => {
  it('returns 500 with generic JSON body without error message or stack trace', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    const testApp = express();
    const sensitiveErrorMessage = 'database secret leaked message';

    testApp.get('/throw', () => {
      throw new Error(sensitiveErrorMessage);
    });
    testApp.use(errorHandler);

    const res = await request(testApp).get('/throw');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain(sensitiveErrorMessage);
    expect(res.body).not.toHaveProperty('stack');
    expect(res.text).not.toContain(sensitiveErrorMessage);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('calls logger.error once with the error object for an unexpected error', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    const testApp = express();
    const boom = new Error('something broke');

    testApp.get('/throw', () => {
      throw boom;
    });
    testApp.use(errorHandler);

    await request(testApp).get('/throw');

    expect(errorSpy).toHaveBeenCalledOnce();
    // First argument must be the object containing the error
    expect(errorSpy.mock.calls[0][0]).toMatchObject({ err: boom });

    errorSpy.mockRestore();
  });

  it('does not call logger.error for a 4xx client error (malformed JSON)', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{bad');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Bad Request' });
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('returns 400 Bad Request for malformed JSON body', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{bad');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Bad Request' });
    // Must not leak parser internals or stack traces
    expect(res.text).not.toMatch(/SyntaxError/i);
    expect(res.text).not.toContain('stack');
    expect(res.text).not.toContain('at ');
  });

  it('returns 413 Payload Too Large for body over 200 KB', async () => {
    // Generate a JSON string larger than 200 KB (the limit is 10 KB)
    const bigBody = JSON.stringify({ data: 'x'.repeat(210 * 1024) });

    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send(bigBody);

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Payload Too Large' });
    // Must not leak parser internals or stack traces
    expect(res.text).not.toMatch(/PayloadTooLargeError/i);
    expect(res.text).not.toContain('stack');
    expect(res.text).not.toContain('at ');
  });
});

// A pg.DatabaseError like the ones pg builds from PostgreSQL's replies. The
// detail holds a value on purpose, to prove it is never logged or sent.
function databaseError(code: string): pg.DatabaseError {
  const err = new pg.DatabaseError('database refused the change', 1, 'error');
  err.code = code;
  err.constraint = 'some_constraint';
  err.table = 'some_table';
  err.detail = 'Key (email)=(secret@example.com) already exists.';
  return err;
}

function appThrowing(err: unknown): express.Express {
  const testApp = express();
  testApp.get('/throw', () => {
    throw err;
  });
  testApp.use(errorHandler);
  return testApp;
}

describe('Database error mapping', () => {
  it.each([
    ['23P01', 409, { error: 'Conflict' }],
    ['23505', 409, { error: 'Conflict' }],
    ['23503', 404, { error: 'Not found' }],
    ['23514', 400, { error: 'Bad Request' }],
    ['40P01', 503, { error: 'Service Unavailable' }],
    ['40001', 503, { error: 'Service Unavailable' }],
  ])('maps %s to %i', async (code, status, body) => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    const res = await request(appThrowing(databaseError(code))).get('/throw');

    expect(res.status).toBe(status);
    expect(res.body).toEqual(body);
    expect(res.text).not.toContain('secret@example.com');
    expect(res.text).not.toContain('some_constraint');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]).toEqual([
      { code, constraint: 'some_constraint', table: 'some_table' },
      'Database error mapped to a client response',
    ]);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(
      'secret@example.com',
    );
    expect(errorSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('sets Retry-After only on a 503', async () => {
    const deadlock = await request(appThrowing(databaseError('40P01'))).get(
      '/throw',
    );
    expect(deadlock.headers['retry-after']).toBe('1');

    const conflict = await request(appThrowing(databaseError('23P01'))).get(
      '/throw',
    );
    expect(conflict.headers['retry-after']).toBeUndefined();
  });

  it('answers 23503 with exactly the same 404 as an unknown route', async () => {
    const mapped = await request(appThrowing(databaseError('23503'))).get(
      '/throw',
    );
    const unknown = await request(app).get('/api/no-such-route');

    expect(mapped.status).toBe(unknown.status);
    expect(mapped.body).toEqual(unknown.body);
    expect(mapped.get('content-type')).toBe(unknown.get('content-type'));
  });

  it('keeps an unlisted database code a logged 500', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    // 22P02 (invalid text representation) is not in the mapping.
    const res = await request(appThrowing(databaseError('22P02'))).get(
      '/throw',
    );

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('does not map an error that only looks like a database error', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    // A plain Error with a code property is not a pg.DatabaseError.
    const fake = Object.assign(new Error('not from pg'), { code: '23505' });
    const res = await request(appThrowing(fake)).get('/throw');

    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledOnce();

    errorSpy.mockRestore();
  });
});
