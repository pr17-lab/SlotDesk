// Task 6b follow-up: a lost database connection must fail the current
// request instead of crashing the process.
//   (a) The connection dies inside the create transaction: the client
//       checked out by createOrganizationWithOwner emits 'error', which
//       would crash Node without its own listener.
//   (b) An idle pooled connection dies: pg-pool re-emits the error on the
//       pool, which would crash Node without pool.on('error', ...).
// Without either fix, Vitest reports an unhandled 'error' event and the run
// fails.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { loadAppOnTestDatabase } from './helpers/auth-app.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';
import { logger } from '../../src/logger.js';

const TRUSTED_ORIGIN = 'http://localhost:3000';
// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'connection-loss-pw-15chars';

const { app, pool } = await loadAppOnTestDatabase();
// Loaded only after loadAppOnTestDatabase(): a static import would load
// src/db.ts before DATABASE_URL points at the test database.
const { createOrganizationWithOwner } =
  await import('../../src/data/organizations.js');
const { createClient } = requireTestDatabase();

let client: pg.Client;
// A second connection that holds a table lock while the test client looks
// for the blocked insert.
let lockClient: pg.Client;

// Filled in by the tests, printed once at the end.
let rejected = false;
let errorCode = 'none';
let idleLogged = false;

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  lockClient = createClient();
  await connectAndVerify(lockClient);
});

afterAll(async () => {
  // Counts and codes only: never a token, a cookie or a connection string.
  process.stdout.write(
    `[connection-loss] transaction: rejected=${rejected} ` +
      `code=${errorCode} idleLogged=${idleLogged}\n`,
  );
  await truncateTables(client);
  await client.end();
  await lockClient.end();
  await pool.end();
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

it('fails the create transaction without crashing when its connection dies', async () => {
  const email = 'connection-loss@example.com';
  const signUp = await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD, name: 'Connection Loss' });
  expect(signUp.status).toBe(200);
  const user = await client.query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [email],
  );
  const userId = user.rows[0]!.id;

  // The lock makes the membership insert wait, so the transaction is open
  // (organization already inserted) when we kill its connection.
  await lockClient.query('BEGIN');
  await lockClient.query('LOCK TABLE memberships IN ACCESS EXCLUSIVE MODE');

  // Never rejects, so the outcome can be inspected after the kill.
  const outcome = createOrganizationWithOwner(
    userId,
    'Lost Connection Org',
  ).then(
    () => 'resolved' as const,
    (err: unknown) => err,
  );

  let pid: number | undefined;
  for (let waited = 0; waited < 5000 && pid === undefined; waited += 50) {
    const blocked = await client.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND query LIKE 'INSERT INTO memberships%'`,
    );
    pid = blocked.rows[0]?.pid;
    if (pid === undefined) await wait(50);
  }
  if (pid === undefined) {
    await lockClient.query('ROLLBACK');
    throw new Error(
      'The membership insert never waited on the lock within 5 seconds.',
    );
  }

  await client.query('SELECT pg_terminate_backend($1)', [pid]);
  await lockClient.query('ROLLBACK');

  const result = await outcome;
  expect(result).not.toBe('resolved');
  expect(result instanceof Error).toBe(true);
  rejected = result instanceof Error;
  const code = (result as { code?: unknown }).code;
  errorCode = typeof code === 'string' ? code : 'none';

  const rows = await client.query(
    "SELECT 1 FROM organizations WHERE name = 'Lost Connection Org'",
  );
  expect(rows.rowCount).toBe(0);

  // Let any late 'error' events fire before checking the pool.
  await wait(500);
  expect(pool.totalCount - pool.idleCount).toBe(0);
  await expect(pool.query('SELECT 1')).resolves.toBeDefined();
}, 15000);

it('logs and survives when an idle pooled connection dies', async () => {
  const idle = await pool.connect();
  const backend = await idle.query<{ pid: number }>(
    'SELECT pg_backend_pid() AS pid',
  );
  idle.release();

  const spy = vi.spyOn(logger, 'error');
  try {
    await client.query('SELECT pg_terminate_backend($1)', [
      backend.rows[0]!.pid,
    ]);

    const wasLogged = (): boolean =>
      spy.mock.calls.some(
        (call) => (call as unknown[])[1] === 'Idle database client error',
      );
    for (let waited = 0; waited < 5000 && !wasLogged(); waited += 50) {
      await wait(50);
    }
    idleLogged = wasLogged();
    expect(idleLogged).toBe(true);

    await expect(pool.query('SELECT 1')).resolves.toBeDefined();
  } finally {
    spy.mockRestore();
  }
}, 15000);
