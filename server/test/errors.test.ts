import { describe, expect, it, vi } from 'vitest';
import express from 'express';
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
    // Generate a JSON string larger than 200 KB (default limit is 100 KB)
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
