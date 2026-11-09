// Step 5 checklist: the session token must never be logged, even when the
// database fails underneath a request (docs/trade-off-record.md 4.1, D-029).
//
// Two scenarios, each against a real signed-in session:
//   1. Query failure -- the sessions.token column is renamed out from under
//      a running app, so any query that reads it fails.
//   2. Connection failure -- the app's own pool is ended, so every query
//      rejects immediately.
// In both, GET /api/auth/get-session and POST /api/auth/sign-out are called
// with the valid cookie, and everything written to console, to the process
// streams, and to our pino logger during those two calls is scanned for the
// raw token.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  findSessionCookie,
  loadAppOnTestDatabase,
  tokenFromSessionCookie,
} from './helpers/auth-app.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';
import { installCaptureSpies } from './helpers/log-capture.js';

const TRUSTED_ORIGIN = 'http://localhost:3000';
const PASSWORD = 'token-logs-pw-15chars';

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;
let poolEnded = false;

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  if (!poolEnded) {
    await pool.end();
  }
});

it('never logs the session token when the database fails underneath get-session or sign-out', async () => {
  const email = 'token-logs@example.com';
  await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD, name: 'Token Logs' });
  const signIn = await request(app)
    .post('/api/auth/sign-in/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD });
  const cookie = findSessionCookie(signIn.get('Set-Cookie') ?? []);
  expect(cookie !== undefined).toBe(true);
  const rawToken = tokenFromSessionCookie(cookie!);

  const captured: string[] = [];
  const spies = installCaptureSpies(captured);

  let scenario1: { getSessionStatus: number; signOutStatus: number };
  let scenario2: { getSessionStatus: number; signOutStatus: number };

  try {
    // Scenario 1: query failure. Rename the column with a SEPARATE client
    // (not the app's pool), then restore it in a finally block.
    await client.query(
      'ALTER TABLE sessions RENAME COLUMN token TO token_renamed',
    );
    const scenario1Start = captured.length;
    let getSessionRes: request.Response;
    let signOutRes: request.Response;
    try {
      getSessionRes = await request(app)
        .get('/api/auth/get-session')
        .set('Cookie', cookie!);
      signOutRes = await request(app)
        .post('/api/auth/sign-out')
        .set('Origin', TRUSTED_ORIGIN)
        .set('Cookie', cookie!);
    } finally {
      await client.query(
        'ALTER TABLE sessions RENAME COLUMN token_renamed TO token',
      );
    }
    scenario1 = {
      getSessionStatus: getSessionRes.status,
      signOutStatus: signOutRes.status,
    };
    expect(getSessionRes.status).not.toBe(200);
    // Documents Better Auth's fail-open sign-out: sign-out.mjs catches
    // database errors, clears the cookie and returns success while the
    // session row survives. Accepted under D-029 risk A. If this fails, the
    // library changed; report it.
    expect(signOutRes.status).toBe(200);
    expect(getSessionRes.text.includes(rawToken)).toBe(false);
    expect(signOutRes.text.includes(rawToken)).toBe(false);

    const scenario1Texts = captured.slice(scenario1Start);
    const scenario1TokenHits = scenario1Texts.filter((text) =>
      text.includes(rawToken),
    );
    expect(scenario1TokenHits.length).toBe(0);
    const scenario1BetterAuthLines = scenario1Texts.filter((text) =>
      text.includes('[Better Auth]'),
    ).length;

    // The column is back, and the same cookie still works: the session
    // survived the sign-out that reported success.
    const afterScenario1 = await request(app)
      .get('/api/auth/get-session')
      .set('Cookie', cookie!);
    expect(afterScenario1.status).toBe(200);
    expect(afterScenario1.body?.user?.email).toBe(email);

    // Scenario 2: connection failure. End the app's own pool, then make
    // the same two requests against it.
    const scenario2Start = captured.length;
    await pool.end();
    poolEnded = true;

    const getSessionRes2 = await request(app)
      .get('/api/auth/get-session')
      .set('Cookie', cookie!);
    const signOutRes2 = await request(app)
      .post('/api/auth/sign-out')
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', cookie!);
    scenario2 = {
      getSessionStatus: getSessionRes2.status,
      signOutStatus: signOutRes2.status,
    };
    expect(getSessionRes2.status).not.toBe(200);
    // Same fail-open sign-out as scenario 1 (D-029 risk A).
    expect(signOutRes2.status).toBe(200);
    expect(getSessionRes2.text.includes(rawToken)).toBe(false);
    expect(signOutRes2.text.includes(rawToken)).toBe(false);

    // Checked with the separate client, since the app's pool is ended.
    // Found by the user, not by the token.
    // Sign-up signs the user in automatically, so the user has more than one session.
    const sessionsAfterScenario2 = await client.query<{ token: string }>(
      `SELECT s.token FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE u.email = $1`,
      [email],
    );
    const scenario2Matches = sessionsAfterScenario2.rows.filter(
      (row) => row.token === rawToken,
    ).length;
    expect(scenario2Matches === 1).toBe(true);

    const scenario2Texts = captured.slice(scenario2Start);
    const scenario2TokenHits = scenario2Texts.filter((text) =>
      text.includes(rawToken),
    );
    expect(scenario2TokenHits.length).toBe(0);
    const scenario2BetterAuthLines = scenario2Texts.filter((text) =>
      text.includes('[Better Auth]'),
    ).length;

    spies.restore();

    // Summary lines: counts only, per requirement 25. If either scenario
    // produced zero captured lines, Better Auth logged nothing for it --
    // requirement 26 says the test still passes, and that is recorded here.
    // process.stdout.write (not console.log) because Vitest's default
    // reporter only surfaces console output for failing tests; the other
    // database test files use the same pattern for their summary lines.
    process.stdout.write(
      `[token-logs] scenario 1 (query failure): lines=${scenario1Texts.length} ` +
        `betterAuthLines=${scenario1BetterAuthLines} ` +
        `getSessionStatus=${scenario1.getSessionStatus} signOutStatus=${scenario1.signOutStatus}\n`,
    );
    process.stdout.write(
      `[token-logs] scenario 2 (connection failure): lines=${scenario2Texts.length} ` +
        `betterAuthLines=${scenario2BetterAuthLines} ` +
        `getSessionStatus=${scenario2.getSessionStatus} signOutStatus=${scenario2.signOutStatus}\n`,
    );
  } finally {
    spies.restore();
  }
}, 15000);
