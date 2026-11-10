// Layer 1 database race test (Step 3b, D-016).
//
// Proves that the database exclusion constraint `bookings_no_overlap` prevents
// double booking under genuine concurrent load, without any application-level
// availability pre-check.
//
// Design: 30 clients all try to INSERT a confirmed booking for the same slot
// at the same time. The D-012 transaction shape is used: lock the resource row
// first (FOR UPDATE) so that simultaneous inserts queue behind a single lock
// rather than deadlocking against each other. The exclusion constraint then
// lets exactly one INSERT commit and rejects every other with error 23P01.
//
// The test repeats this for 20 rounds (different slots) so we are not testing
// a one-off fluke.
//
// Why the test would fail without the constraint: without bookings_no_overlap,
// every INSERT would succeed because there is nothing to enforce uniqueness of
// the booked interval. All 30 connections would commit in every round. The
// per-round assertion (exactly 1 committed) would immediately fail.

import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { insertOrg, insertResource, slotFor } from './helpers/booking-data.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';
import {
  AttemptOutcome,
  endClients,
  fireTogether,
  openClients,
} from './helpers/race-harness.js';

const CONNECTIONS = 30;
const ROUNDS = 20;

// Checks TEST_DATABASE_URL exists and names a _test database (checks 1 and 2).
const { url, createClient } = requireTestDatabase();

let setupClient: pg.Client;
let orgId: bigint;
let resourceId: bigint;
// Race clients are opened inside the test so we can close them in finally.
let raceClients: pg.Client[] = [];

// Slots start at 2027-01-01 00:00Z and step by 1 hour per round so no two
// rounds overlap.
const SLOT_BASE = '2027-01-01T00:00:00Z';

beforeAll(async () => {
  setupClient = createClient();
  // Check 3: verify the live database name ends in _test before any writes.
  await connectAndVerify(setupClient);

  orgId = await insertOrg(setupClient, 'Race Test Org');
  resourceId = await insertResource(setupClient, orgId, 'Race Room');
});

afterAll(async () => {
  // Always close race clients even if the test threw.
  await endClients(raceClients);
  await truncateTables(setupClient);
  await setupClient.end();
});

it('exclusion constraint prevents double booking under 30 concurrent connections over 20 rounds', async () => {
  // Check max_connections before opening 30 extra connections.
  const mcResult = await setupClient.query<{ max_connections: string }>(
    'SHOW max_connections',
  );
  const maxConn = parseInt(mcResult.rows[0]!.max_connections, 10);
  if (maxConn < CONNECTIONS + 10) {
    throw new Error(
      `max_connections is ${maxConn}, need at least ${CONNECTIONS + 10} ` +
        `(${CONNECTIONS} race clients + 10 headroom). Increase it in postgresql.conf.`,
    );
  }

  raceClients = await openClients(url, CONNECTIONS);

  let totalCommitted = 0;
  let total23P01 = 0;
  let totalOther = 0;
  const spreadMsPerRound: number[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    const { startsAt, endsAt } = slotFor(SLOT_BASE, round);

    const { outcomes, spreadMs } = await fireTogether(
      raceClients,
      async (client) => {
        try {
          // Lock the resource row before inserting. This prevents deadlocks
          // between simultaneous inserts; it does not decide who gets the slot.
          // The exclusion constraint does that.
          await client.query<{ id: string }>(
            'SELECT id FROM resources WHERE org_id = $1 AND id = $2 FOR UPDATE',
            [orgId, resourceId],
          );

          await client.query<{ id: string }>(
            `INSERT INTO bookings
                 (org_id, resource_id, starts_at, ends_at, status,
                  customer_name, customer_email)
               VALUES ($1, $2, $3, $4, 'confirmed', 'Race Bot', 'race@example.com')`,
            [orgId, resourceId, startsAt, endsAt],
          );
          // The INSERT succeeded -- commit immediately so blocked losers
          // can proceed. Do not wait for other clients.
          await client.query('COMMIT');
          return {
            result: 'committed',
            constraint: null,
          } satisfies AttemptOutcome;
        } catch (err) {
          await client.query('ROLLBACK');
          if (err instanceof pg.DatabaseError && err.code != null) {
            return {
              result: err.code,
              constraint: err.constraint ?? null,
            } satisfies AttemptOutcome;
          }
          // Unknown error type -- surface it.
          throw err;
        }
      },
    );

    spreadMsPerRound.push(spreadMs);

    const committed = outcomes.filter((o) => o.result === 'committed');
    const error23P01 = outcomes.filter(
      (o) => o.result === '23P01' && o.constraint === 'bookings_no_overlap',
    );
    const other = outcomes.filter(
      (o) =>
        o.result !== 'committed' &&
        !(o.result === '23P01' && o.constraint === 'bookings_no_overlap'),
    );

    totalCommitted += committed.length;
    total23P01 += error23P01.length;
    totalOther += other.length;

    // Per-round assertion: exactly one winner, every other outcome is 23P01
    // on the bookings_no_overlap constraint. Anything else -- including
    // 40P01 (deadlock) -- is a failure.
    expect(
      committed.length,
      `Round ${round}: expected exactly 1 committed, got ${committed.length}. Outcomes: ${JSON.stringify(outcomes)}`,
    ).toBe(1);

    expect(
      other.length,
      `Round ${round}: unexpected outcomes (not committed or 23P01/bookings_no_overlap): ${JSON.stringify(other)}`,
    ).toBe(0);
  }

  // Post-run audit queries via the setup client.
  const countResult = await setupClient.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM bookings WHERE status = 'confirmed'",
  );
  const confirmedCount = parseInt(countResult.rows[0]!.count, 10);

  expect(
    confirmedCount,
    `Expected exactly ${ROUNDS} confirmed bookings after ${ROUNDS} rounds, got ${confirmedCount}`,
  ).toBe(ROUNDS);

  // One confirmed row per slot: group by slot and check each has count 1.
  const perSlotResult = await setupClient.query<{
    starts_at: Date;
    cnt: string;
  }>(
    "SELECT starts_at, COUNT(*) AS cnt FROM bookings WHERE status = 'confirmed' GROUP BY starts_at HAVING COUNT(*) > 1",
  );
  expect(
    perSlotResult.rowCount,
    `Found slots with more than one confirmed booking: ${JSON.stringify(perSlotResult.rows)}`,
  ).toBe(0);

  // Zero overlapping pairs of confirmed bookings (self-join with tstzrange &&).
  const overlapResult = await setupClient.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
       FROM bookings a
       JOIN bookings b ON a.resource_id = b.resource_id
         AND a.id < b.id
         AND tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
       WHERE a.status = 'confirmed'
         AND b.status = 'confirmed'`,
  );
  const overlapCount = parseInt(overlapResult.rows[0]!.cnt, 10);
  expect(
    overlapCount,
    `Found ${overlapCount} overlapping pair(s) of confirmed bookings -- constraint failed`,
  ).toBe(0);

  const sortedSpread = [...spreadMsPerRound].sort((a, b) => a - b);
  const minSpread = sortedSpread[0]!.toFixed(2);
  const maxSpread = sortedSpread[sortedSpread.length - 1]!.toFixed(2);
  const mid = Math.floor(sortedSpread.length / 2);
  const medianSpread =
    sortedSpread.length % 2 === 0
      ? ((sortedSpread[mid - 1]! + sortedSpread[mid]!) / 2).toFixed(2)
      : sortedSpread[mid]!.toFixed(2);

  // Deliberate test output only. The pino logger is silent under NODE_ENV=test,
  // and assertion messages appear only on failure.
  process.stdout.write(
    `[race] connections=${CONNECTIONS} rounds=${ROUNDS} ` +
      `committed=${totalCommitted} 23P01=${total23P01} other=${totalOther} ` +
      `spreadMs min=${minSpread} median=${medianSpread} max=${maxSpread}\n`,
  );
}, 60000);
