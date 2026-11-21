import path from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { loadAppOnTestDatabase } from './helpers/auth-app.js';

// Set before the app loads: config.ts reads it once.
process.env.CLIENT_DIST_DIR = path.join(
  import.meta.dirname,
  '..',
  'fixtures',
  'client',
);

const { app, pool } = await loadAppOnTestDatabase();

afterAll(async () => {
  await pool.end();
});

describe('Better Auth with the built React app served', () => {
  it('still answers /api/auth/get-session itself', async () => {
    const res = await request(app).get('/api/auth/get-session');

    expect(res.status).toBe(200);
    expect(res.type).toBe('application/json');
    expect(res.body).toBeNull();
  });

  it('serves the page on the same app', async () => {
    const res = await request(app).get('/orgs/5');

    expect(res.status).toBe(200);
    expect(res.text).toContain('SlotDesk test page');
  });
});
