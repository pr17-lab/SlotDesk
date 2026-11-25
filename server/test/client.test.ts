import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const builtClient = path.join(import.meta.dirname, 'fixtures', 'client');
const noClient = path.join(import.meta.dirname, 'fixtures', 'no-client-here');

// The app reads CLIENT_DIST_DIR once at import, so each test loads a fresh copy.
const loadApp = async (clientDir: string) => {
  vi.stubEnv('CLIENT_DIST_DIR', clientDir);
  vi.resetModules();
  const { app } = await import('../src/app.js');
  return app;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Serving the built React app', () => {
  it('answers / and page paths with index.html', async () => {
    const app = await loadApp(builtClient);

    for (const page of ['/', '/orgs/5', '/orgs/5/bookings/']) {
      const res = await request(app).get(page);
      expect(res.status, page).toBe(200);
      expect(res.type, page).toBe('text/html');
      expect(res.text, page).toContain('SlotDesk test page');
    }
  });

  it('serves files from the build folder', async () => {
    const app = await loadApp(builtClient);

    const res = await request(app).get('/assets/app.css');

    expect(res.status).toBe(200);
    expect(res.type).toBe('text/css');
  });

  it('never answers an /api path with the page, whatever the case', async () => {
    const app = await loadApp(builtClient);

    for (const apiPath of ['/api', '/api/nope', '/API/nope', '/Api/nope']) {
      const res = await request(app).get(apiPath);
      expect(res.status, apiPath).toBe(404);
      expect(res.body, apiPath).toEqual({ error: 'Not found' });
    }
  });

  it('only answers GET with the page', async () => {
    const app = await loadApp(builtClient);

    const res = await request(app).post('/orgs/5');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('keeps the API routes working', async () => {
    const app = await loadApp(builtClient);

    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });

    // There's no database here, so Better Auth can't answer properly. What
    // matters is that the page never does. test/db/client.test.ts checks the
    // real answer.
    const session = await request(app).get('/api/auth/get-session');
    expect(session.type).toBe('application/json');
    expect(session.text).not.toContain('SlotDesk test page');
  });

  it("sends helmet's security headers with the page", async () => {
    const app = await loadApp(builtClient);

    const res = await request(app).get('/orgs/5');

    expect(res.type).toBe('text/html');
    expect(res.headers['content-security-policy']).toContain(
      "script-src 'self'",
    );
  });

  // The bot check on the public booking page loads a script and a frame from
  // Cloudflare. Nothing else is added.
  it('lets the page load the bot check from Cloudflare only', async () => {
    const app = await loadApp(builtClient);

    const res = await request(app).get('/book/sunrise-physio');

    const policy = String(res.headers['content-security-policy']).split(';');
    expect(policy).toContain(
      "script-src 'self' https://challenges.cloudflare.com",
    );
    expect(policy).toContain(
      "frame-src 'self' https://challenges.cloudflare.com",
    );
    expect(policy).toContain("default-src 'self'");
  });

  it('runs as an API only when the folder has no index.html', async () => {
    const app = await loadApp(noClient);

    for (const page of ['/', '/orgs/5']) {
      const res = await request(app).get(page);
      expect(res.status, page).toBe(404);
      expect(res.body, page).toEqual({ error: 'Not found' });
    }
  });
});
