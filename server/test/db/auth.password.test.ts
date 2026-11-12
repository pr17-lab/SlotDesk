// Password hashing through the real app (D-031, Step 7d): the stored format,
// sign-in with right and wrong passwords, and a corrupt stored hash.
// Passwords, hashes and cookies are never printed: every check compares a
// boolean, a status, a count or uses toMatch.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  findSessionCookie,
  loadAppOnTestDatabase,
  signIn,
  signUp,
} from './helpers/auth-app.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

const TRUSTED_ORIGIN = 'http://localhost:3000';
const HASH_FORMAT = /^scrypt:32768:8:3:[0-9a-f]{32}:[0-9a-f]{128}$/;

// 15+ characters, the minimum set in src/auth.ts.
const PASSWORD = 'password-test-15chars';
const WRONG_PASSWORD = 'password-test-15charz';

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

// Sends a sign-in request and returns the response, whatever its status.
function postSignIn(email: string, password: string) {
  return request(app)
    .post('/api/auth/sign-in/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password });
}

function hasSessionCookie(res: request.Response): boolean {
  return findSessionCookie(res.get('Set-Cookie') ?? []) !== undefined;
}

async function storedHash(email: string): Promise<string> {
  const result = await client.query<{ password: string }>(
    `SELECT a.password FROM accounts a
       JOIN users u ON u.id = a.user_id
      WHERE u.email = $1 AND a.provider_id = 'credential'`,
    [email],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0]!.password;
}

async function countSessions(email: string): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE u.email = $1`,
    [email],
  );
  return Number(result.rows[0]?.count ?? 0);
}

it('stores the hash in our scrypt format at sign-up', async () => {
  const email = 'password-format@example.com';
  await signUp(app, { email, password: PASSWORD, name: 'Format' });
  expect(await storedHash(email)).toMatch(HASH_FORMAT);
});

it('signs in with the right password and refuses a wrong one', async () => {
  const email = 'password-signin@example.com';
  await signUp(app, { email, password: PASSWORD, name: 'Sign In' });

  await signIn(app, { email, password: PASSWORD });

  const wrong = await postSignIn(email, WRONG_PASSWORD);
  expect(wrong.status).toBe(401);
  expect(hasSessionCookie(wrong)).toBe(false);
});

it('answers 401 for an email that does not exist', async () => {
  const res = await postSignIn('password-nobody@example.com', PASSWORD);
  expect(res.status).toBe(401);
  expect(hasSessionCookie(res)).toBe(false);
});

it('answers 500 with no session for a corrupt stored hash', async () => {
  const email = 'password-corrupt@example.com';
  await signUp(app, { email, password: PASSWORD, name: 'Corrupt' });
  await client.query(
    `UPDATE accounts SET password = 'not-a-valid-hash'
      WHERE provider_id = 'credential'
        AND user_id = (SELECT id FROM users WHERE email = $1)`,
    [email],
  );
  const sessionsBefore = await countSessions(email);

  const res = await postSignIn(email, PASSWORD);
  expect(res.status).toBe(500);
  expect(hasSessionCookie(res)).toBe(false);
  expect(await countSessions(email)).toBe(sessionsBefore);
});
