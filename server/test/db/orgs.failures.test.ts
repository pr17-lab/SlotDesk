// Step 6b failure paths (D-030):
//   1. The create transaction leaves no organization behind when the owner
//      membership insert fails, and returns its client to the pool.
//   2. A database failure under the session check returns 500 and never
//      logs the session token.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  loadAppOnTestDatabase,
  signUp,
  tokenFromSessionCookie,
} from './helpers/auth-app.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';
import { installCaptureSpies } from './helpers/log-capture.js';

// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'org-failures-pw-15chars';

const { app, pool } = await loadAppOnTestDatabase();
// Loaded only after loadAppOnTestDatabase(): a static import would load
// src/db.ts before DATABASE_URL points at the test database.
const { createOrganizationWithOwner } =
  await import('../../src/data/organizations.js');
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

it('rolls back the organization when the owner membership insert fails, and releases the client', async () => {
  // 23503 on memberships_user_id_fkey shows the organization insert ran and
  // the membership insert then failed.
  await expect(
    createOrganizationWithOwner('no-such-user-id', 'Rollback Org'),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'memberships_user_id_fkey',
  });

  const rows = await client.query(
    "SELECT 1 FROM organizations WHERE name = 'Rollback Org'",
  );
  expect(rows.rowCount).toBe(0);
  expect(pool.totalCount - pool.idleCount).toBe(0);
});

it('returns 500 and never logs the token when the database fails under the session check', async () => {
  const cookie = await signUp(app, {
    email: 'org-failures@example.com',
    password: PASSWORD,
    name: 'Org Failures',
  });
  const rawToken = tokenFromSessionCookie(cookie);

  const captured: string[] = [];
  const spies = installCaptureSpies(captured);
  let res: request.Response;
  try {
    // Renamed with the separate test client, never the app's pool.
    await client.query(
      'ALTER TABLE sessions RENAME COLUMN token TO token_renamed',
    );
    try {
      res = await request(app).get('/api/orgs').set('Cookie', cookie);
    } finally {
      await client.query(
        'ALTER TABLE sessions RENAME COLUMN token_renamed TO token',
      );
    }
  } finally {
    spies.restore();
  }

  expect(res.status).toBe(500);
  expect(res.body).toEqual({ error: 'Internal server error' });
  expect(res.text.includes(rawToken)).toBe(false);
  const tokenHits = captured.filter((text) => text.includes(rawToken)).length;
  expect(tokenHits).toBe(0);
  const betterAuthLines = captured.filter((text) =>
    text.includes('[Better Auth]'),
  ).length;

  // The column is back: the same cookie works again.
  const after = await request(app).get('/api/orgs').set('Cookie', cookie);
  expect(after.status).toBe(200);

  // Counts only. process.stdout.write because Vitest's default reporter only
  // shows console output for failing tests (same as the token-logs test).
  process.stdout.write(
    `[org-routes] session db failure: lines=${captured.length} ` +
      `betterAuthLines=${betterAuthLines} status=${res.status}\n`,
  );
}, 15000);
