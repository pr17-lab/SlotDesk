// Outside production the bot check keys are optional. Without them the
// public page still shows, but online booking is off: the POST answers 503
// and never reaches Cloudflare or the bookings table.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAppOnTestDatabase } from './helpers/auth-app.js';
import { insertOrg } from './helpers/booking-data.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';
import { siteverifyPasses, verifyCalls } from './helpers/turnstile-fake.js';

// vitest.db.config.ts sets both keys for every other file; each test file
// loads its own copy of the app, so removing them here affects only this one.
delete process.env.TURNSTILE_SITE_KEY;
delete process.env.TURNSTILE_SECRET_KEY;

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  const orgId = await insertOrg(client, 'Unready Clinic');
  await client.query(
    "UPDATE organizations SET booking_slug = 'unready-clinic' WHERE id = $1",
    [orgId],
  );
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('online booking without the bot check keys', () => {
  it('shows the page with no site key', async () => {
    const res = await request(app).get('/api/public/unready-clinic');
    expect(res.status).toBe(200);
    expect(res.body.turnstileSiteKey).toBeNull();
  });

  it('answers 503 to a booking and writes nothing', async () => {
    const fake = siteverifyPasses();
    const res = await request(app)
      .post('/api/public/unready-clinic/bookings')
      .set('Origin', 'http://localhost:3000')
      .send({ turnstileToken: 'any-token' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Online booking is not set up' });
    expect(verifyCalls(fake)).toBe(0);
    const rows = await client.query('SELECT count(*)::int AS n FROM bookings');
    expect(rows.rows[0].n).toBe(0);
  });
});
