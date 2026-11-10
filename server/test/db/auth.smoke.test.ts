// Better Auth smoke test (Step 5b, D-021, D-025, D-029).
//
// Proves that sign-up and session lookup work through the mounted handler and
// that the identity rows land in the tables created by our own migration.
// The Step 5c checklist tests (cookie attributes, sign-out, cross-origin,
// reset route, token storage) are not here.
//
// Loading the app against the test database (guard on TEST_DATABASE_URL,
// point DATABASE_URL at it, dynamic import, verify current_database()) is
// shared with the other database test files in loadAppOnTestDatabase().

import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  findSessionCookie,
  loadAppOnTestDatabase,
} from './helpers/auth-app.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

// Plain test-only constants. The password is 15 characters, the minimum set
// in src/auth.ts. Never printed by this file.
const TEST_EMAIL = 'smoke@example.com';
const TEST_PASSWORD = 'smoke-test-pw15';
const TEST_NAME = 'Smoke Test';

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

it("the app's pool is on the test database", async () => {
  const result = await pool.query<{ current_database: string }>(
    'select current_database()',
  );
  expect(result.rows[0]?.current_database.endsWith('_test')).toBe(true);
});

it('signs up with email and password, then finds the session', async () => {
  const signUp = await request(app)
    .post('/api/auth/sign-up/email')
    .send({ email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME });

  expect(signUp.status).toBe(200);

  // Keep only the "name=value" part of the session cookie. Assertions compare
  // booleans so a failure never prints the cookie or the token.
  const sessionCookie = findSessionCookie(signUp.get('Set-Cookie') ?? []);
  expect(sessionCookie !== undefined).toBe(true);

  const session = await request(app)
    .get('/api/auth/get-session')
    .set('Cookie', sessionCookie ?? '');

  expect(session.status).toBe(200);
  expect(session.body?.user?.email).toBe(TEST_EMAIL);

  const users = await client.query<{ id: string }>('SELECT id FROM users');
  expect(users.rowCount).toBe(1);
  const userId = users.rows[0]!.id;

  const accounts = await client.query<{ provider_id: string }>(
    'SELECT provider_id FROM accounts',
  );
  expect(accounts.rowCount).toBe(1);
  expect(accounts.rows[0]!.provider_id).toBe('credential');

  const sessions = await client.query<{ user_id: string }>(
    'SELECT user_id FROM sessions',
  );
  expect(sessions.rowCount).toBe(1);
  expect(sessions.rows[0]!.user_id).toBe(userId);
});

it('GET /api/health still returns 200 with the app loaded this way', async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
});
