import express from 'express';
import type { RequestHandler } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRateLimiter } from '../src/middleware/rate-limit.js';

// A tiny app with one limiter in front of a handler that always says 200.
const appWithLimiter = (limiter: RequestHandler) => {
  const app = express();
  app.use(limiter);
  app.use((_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
};

const appWith = (limit: number) => appWithLimiter(makeRateLimiter(limit));

describe('makeRateLimiter', () => {
  it('answers 429 once the limit is used, with Retry-After', async () => {
    const app = appWith(3);

    for (let i = 0; i < 3; i++) {
      expect((await request(app).post('/')).status).toBe(200);
    }
    const res = await request(app).post('/');

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'Too Many Requests' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts GET and HEAD too when nothing is skipped', async () => {
    const app = appWith(2);

    await request(app).get('/');
    await request(app).head('/');

    expect((await request(app).get('/')).status).toBe(429);
  });

  it('gives each client address its own count', async () => {
    const app = appWith(1);

    const first = await request(app)
      .post('/')
      .set('cf-connecting-ip', '1.1.1.1');
    const again = await request(app)
      .post('/')
      .set('cf-connecting-ip', '1.1.1.1');
    const other = await request(app)
      .post('/')
      .set('cf-connecting-ip', '2.2.2.2');

    expect(first.status).toBe(200);
    expect(again.status).toBe(429);
    expect(other.status).toBe(200);
  });

  it('puts IPv6 addresses from the same /56 in one count', async () => {
    const app = appWith(1);

    const first = await request(app)
      .post('/')
      .set('cf-connecting-ip', '2001:db8:1:2::5');
    const sameBlock = await request(app)
      .post('/')
      .set('cf-connecting-ip', '2001:db8:1:99::5');
    const otherBlock = await request(app)
      .post('/')
      .set('cf-connecting-ip', '2001:db8:2:2::5');

    expect(first.status).toBe(200);
    expect(sameBlock.status).toBe(429);
    expect(otherBlock.status).toBe(200);
  });

  it('ignores x-forwarded-for, which a client can fake', async () => {
    const app = appWith(1);

    await request(app).post('/').set('x-forwarded-for', '1.1.1.1');
    const res = await request(app).post('/').set('x-forwarded-for', '2.2.2.2');

    expect(res.status).toBe(429);
  });
});

describe('writeLimiter', () => {
  // The settings are read once at import, so each test loads a fresh copy.
  const loadWriteApp = async (limit: number) => {
    vi.stubEnv('WRITE_RATE_LIMIT', String(limit));
    vi.resetModules();
    const { writeLimiter } = await import('../src/middleware/rate-limit.js');
    return appWithLimiter(writeLimiter);
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('never counts GET, HEAD or OPTIONS', async () => {
    const app = await loadWriteApp(2);

    for (let i = 0; i < 5; i++) {
      await request(app).get('/');
      await request(app).head('/');
      await request(app).options('/');
    }

    expect((await request(app).post('/')).status).toBe(200);
    expect((await request(app).post('/')).status).toBe(200);
    expect((await request(app).post('/')).status).toBe(429);
  });

  it.each(['post', 'put', 'patch', 'delete'] as const)(
    'counts %s',
    async (method) => {
      const app = await loadWriteApp(2);

      expect((await request(app)[method]('/')).status).toBe(200);
      expect((await request(app)[method]('/')).status).toBe(200);
      expect((await request(app)[method]('/')).status).toBe(429);
    },
  );

  it('keeps counting after the limit is reached', async () => {
    const app = await loadWriteApp(1);

    await request(app).post('/');

    expect((await request(app).post('/')).status).toBe(429);
    expect((await request(app).post('/')).status).toBe(429);
  });
});

describe('the limits on /api/orgs in the real app', () => {
  // The app reads its settings once at import, so each test loads a fresh copy.
  const loadApp = async (writeLimit: number, requestLimit: number) => {
    vi.stubEnv('WRITE_RATE_LIMIT', String(writeLimit));
    vi.stubEnv('REQUEST_RATE_LIMIT', String(requestLimit));
    vi.resetModules();
    const { app } = await import('../src/app.js');
    return app;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // No Origin header, so a request that gets past the limiter is refused with
  // 403 by the origin check, before any database query. A 429 therefore also
  // shows that the limiter runs before the origin and session checks.
  it('limits writes before the origin check', async () => {
    const app = await loadApp(2, 100);

    expect((await request(app).post('/api/orgs')).status).toBe(403);
    expect((await request(app).post('/api/orgs')).status).toBe(403);
    const res = await request(app).post('/api/orgs');

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'Too Many Requests' });
  });

  it('limits all requests, reads included, on a separate count', async () => {
    const app = await loadApp(100, 2);

    expect((await request(app).post('/api/orgs')).status).toBe(403);
    expect((await request(app).post('/api/orgs')).status).toBe(403);

    expect((await request(app).post('/api/orgs')).status).toBe(429);
    expect((await request(app).get('/api/orgs')).status).toBe(429);
  });

  it('does not limit /api/health', async () => {
    const app = await loadApp(1, 1);

    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/api/health')).status).toBe(200);
    }
  });
});
