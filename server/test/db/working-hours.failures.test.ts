// Step 9c: failure tests for replaceWorkingHours (D-032, D-014).
//   (a) The connection dies inside the replace transaction: the call must
//       reject without crashing the process, the old week must still be
//       stored, and the pool must recover.
//   (b) Two replaces for the same resource at the same moment: both must
//       succeed (the resource row lock makes the second wait), and the stored
//       week must be exactly one of the two, never a mix.
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadAppOnTestDatabase } from './helpers/auth-app.js';
import { insertOrg, insertResource } from './helpers/booking-data.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

const { pool } = await loadAppOnTestDatabase();
// Loaded only after loadAppOnTestDatabase(): a static import would load
// src/db.ts before DATABASE_URL points at the test database.
const { replaceWorkingHours } = await import('../../src/data/working-hours.js');
const { createClient } = requireTestDatabase();

type Window = { weekday: number; startMinute: number; endMinute: number };

let client: pg.Client;
// A second connection that holds a table lock while the test client looks
// for the blocked delete.
let lockClient: pg.Client;
let orgId: string;

// Filled in by the tests, printed once at the end.
let rejected = false;
let errorCode = 'none';
let endedAsA = 0;
let endedAsB = 0;

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  lockClient = createClient();
  await connectAndVerify(lockClient);
  orgId = String(await insertOrg(client, 'Working Hours Failures Org'));
});

afterAll(async () => {
  // Counts and codes only: never a token, a cookie or a connection string.
  process.stdout.write(
    `[working-hours] lost connection: rejected=${rejected} code=${errorCode}; ` +
      `two writers: A=${endedAsA} B=${endedAsB}\n`,
  );
  await truncateTables(client);
  await client.end();
  await lockClient.end();
  await pool.end();
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The stored week of one resource, read directly, sorted like the API.
async function storedWeek(resourceId: string): Promise<Window[]> {
  const result = await client.query<Window>(
    `SELECT weekday, start_minute AS "startMinute", end_minute AS "endMinute"
     FROM working_hours WHERE resource_id = $1
     ORDER BY weekday, start_minute`,
    [resourceId],
  );
  return result.rows;
}

it('fails the replace without crashing when its connection dies, and keeps the old week', async () => {
  const resourceId = String(
    await insertResource(client, BigInt(orgId), 'Lost Connection Chair'),
  );
  const oldWeek = [
    { weekday: 1, startMinute: 540, endMinute: 780 },
    { weekday: 2, startMinute: 600, endMinute: 900 },
  ];
  expect(await replaceWorkingHours(orgId, resourceId, oldWeek)).toEqual(
    oldWeek,
  );

  // The lock makes the delete wait, so the transaction is open (resource row
  // already locked) when we kill its connection.
  await lockClient.query('BEGIN');
  await lockClient.query('LOCK TABLE working_hours IN ACCESS EXCLUSIVE MODE');

  // Never rejects, so the outcome can be inspected after the kill.
  const outcome = replaceWorkingHours(orgId, resourceId, [
    { weekday: 5, startMinute: 0, endMinute: 1440 },
  ]).then(
    () => 'resolved' as const,
    (err: unknown) => err,
  );

  let pid: number | undefined;
  for (let waited = 0; waited < 5000 && pid === undefined; waited += 50) {
    const blocked = await client.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND query LIKE 'DELETE FROM working_hours%'`,
    );
    pid = blocked.rows[0]?.pid;
    if (pid === undefined) await wait(50);
  }
  if (pid === undefined) {
    await lockClient.query('ROLLBACK');
    throw new Error(
      'The working_hours delete never waited on the lock within 5 seconds.',
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

  expect(await storedWeek(resourceId)).toEqual(oldWeek);

  // Let any late 'error' events fire before checking the pool.
  await wait(500);
  expect(pool.totalCount - pool.idleCount).toBe(0);
  await expect(pool.query('SELECT 1')).resolves.toBeDefined();
}, 15000);

it('lets two simultaneous replaces both succeed, leaving exactly one week', async () => {
  const resourceId = String(
    await insertResource(client, BigInt(orgId), 'Two Writers Chair'),
  );
  // The Monday windows of A and B overlap, so if the two transactions
  // interleaved, one would fail on working_hours_no_overlap.
  const weekA = [
    { weekday: 1, startMinute: 540, endMinute: 780 },
    { weekday: 2, startMinute: 540, endMinute: 780 },
  ];
  const weekB = [
    { weekday: 1, startMinute: 600, endMinute: 900 },
    { weekday: 3, startMinute: 0, endMinute: 60 },
  ];

  for (let round = 0; round < 20; round++) {
    // Promise.all rejects if either call rejects, which fails the test.
    const [savedA, savedB] = await Promise.all([
      replaceWorkingHours(orgId, resourceId, weekA),
      replaceWorkingHours(orgId, resourceId, weekB),
    ]);
    // Each call reads back its own week inside its own transaction.
    expect(savedA).toEqual(weekA);
    expect(savedB).toEqual(weekB);

    const stored = await storedWeek(resourceId);
    expect([weekA, weekB]).toContainEqual(stored);
    if (JSON.stringify(stored) === JSON.stringify(weekA)) {
      endedAsA++;
    } else {
      endedAsB++;
    }
  }
  expect(endedAsA + endedAsB).toBe(20);
}, 30000);
