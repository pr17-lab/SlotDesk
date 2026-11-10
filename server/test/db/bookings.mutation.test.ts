// Layer 3 mutation proof (Step 3b, D-016).
//
// This test is expected to show double booking; it proves the harness can
// detect it. Without a database-level constraint, a naive application-level
// "check then insert" is not safe under concurrency. Two connections can both
// read "no conflict" and then both insert, producing overlapping rows.
//
// The test uses a scratch schema with no exclusion constraint. If the harness
// cannot produce multiple winners in any round, the assertion fails -- we do
// NOT weaken it; that outcome must be reported as a finding.
//
// If this test ever fails, the harness has stopped racing. Fix the harness;
// never loosen the assertion.

import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { slotFor } from './helpers/booking-data.js';
import { connectAndVerify, requireTestDatabase } from './helpers/db-guard.js';
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
// Race clients are opened inside the test so they can be closed in finally.
let raceClients: pg.Client[] = [];

// Same scheme as the race test: 1-hour slots starting 2027-06-01 00:00Z,
// offset from the race test's range so the two tests never share slots.
const SLOT_BASE = '2027-06-01T00:00:00Z';

beforeAll(async () => {
  setupClient = createClient();
  // Check 3: verify the live database name ends in _test before any writes.
  await connectAndVerify(setupClient);

  // Create the scratch schema and unguarded table.
  // The schema is dropped first so a crashed previous run leaves no debris.
  // This touches only race_scratch, never the real application tables.
  await setupClient.query('DROP SCHEMA IF EXISTS race_scratch CASCADE');
  await setupClient.query('CREATE SCHEMA race_scratch');
  await setupClient.query(`
    CREATE TABLE race_scratch.bookings_unguarded (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      resource_id bigint        NOT NULL,
      starts_at   timestamptz   NOT NULL,
      ends_at     timestamptz   NOT NULL,
      status      text          NOT NULL
      -- No exclusion constraint and no other overlap protection.
      -- That is the point: we want to show that application code alone
      -- cannot prevent double booking under concurrency.
    )
  `);
});

afterAll(async () => {
  // Always close race clients even if the test threw.
  await endClients(raceClients);
  // Drop the scratch schema so nothing lingers in the test database.
  await setupClient.query('DROP SCHEMA IF EXISTS race_scratch CASCADE');
  await setupClient.end();
});

it('naive SELECT-then-INSERT lets multiple connections double-book the same slot', async () => {
  raceClients = await openClients(url, CONNECTIONS);

  // Use a fixed resource_id; the scratch table has no FK so any value works.
  const resourceId = 1n;

  let totalCommitted = 0;
  let totalRejectedByCheck = 0;
  let totalOther = 0;
  let roundsWithMultipleWinners = 0;
  const spreadMsPerRound: number[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    const { startsAt, endsAt } = slotFor(SLOT_BASE, round);

    const { outcomes, spreadMs } = await fireTogether(
      raceClients,
      async (client) => {
        try {
          // Naive application check: does a confirmed overlapping row exist?
          // Under concurrent load, two connections can both see "no row"
          // and both proceed to INSERT -- the race condition we are proving.
          const conflict = await client.query<{ cnt: string }>(
            `SELECT COUNT(*) AS cnt
               FROM race_scratch.bookings_unguarded
               WHERE resource_id = $1
                 AND status = 'confirmed'
                 AND tstzrange(starts_at, ends_at) && tstzrange($2::timestamptz, $3::timestamptz)`,
            [resourceId, startsAt, endsAt],
          );
          const hasConflict = parseInt(conflict.rows[0]!.cnt, 10) > 0;

          if (hasConflict) {
            await client.query('ROLLBACK');
            return {
              result: 'rejected-by-check',
              constraint: null,
            } satisfies AttemptOutcome;
          }

          await client.query(
            `INSERT INTO race_scratch.bookings_unguarded
                 (resource_id, starts_at, ends_at, status)
               VALUES ($1, $2, $3, 'confirmed')`,
            [resourceId, startsAt, endsAt],
          );
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
          throw err;
        }
      },
    );

    spreadMsPerRound.push(spreadMs);

    const committed = outcomes.filter((o) => o.result === 'committed');
    const rejectedByCheck = outcomes.filter(
      (o) => o.result === 'rejected-by-check',
    );
    const other = outcomes.filter(
      (o) => o.result !== 'committed' && o.result !== 'rejected-by-check',
    );

    totalCommitted += committed.length;
    totalRejectedByCheck += rejectedByCheck.length;
    totalOther += other.length;

    if (committed.length > 1) {
      roundsWithMultipleWinners += 1;
    }
  }

  // Audit: find overlapping pairs of confirmed rows in the scratch table.
  const overlapResult = await setupClient.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
       FROM race_scratch.bookings_unguarded a
       JOIN race_scratch.bookings_unguarded b
         ON a.resource_id = b.resource_id
         AND a.id < b.id
         AND tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
       WHERE a.status = 'confirmed'
         AND b.status = 'confirmed'`,
  );
  const overlapCount = parseInt(overlapResult.rows[0]!.cnt, 10);

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
    `[mutation] connections=${CONNECTIONS} rounds=${ROUNDS} ` +
      `committed=${totalCommitted} rejected-by-check=${totalRejectedByCheck} ` +
      `other=${totalOther} rounds-with-multiple-winners=${roundsWithMultipleWinners} ` +
      `spreadMs min=${minSpread} median=${medianSpread} max=${maxSpread}\n`,
  );

  // The harness must demonstrate at least one round where more than one
  // client committed -- proving application-level checks are not safe.
  // If this assertion fails, the double-booking race did not trigger:
  // report it as a finding rather than weakening the assertion.
  expect(
    roundsWithMultipleWinners,
    `Expected at least one round with multiple committed outcomes, got 0. ` +
      `The race condition did not trigger. This is a finding: the test could ` +
      `not prove the harness detects double booking on this database/OS.`,
  ).toBeGreaterThan(0);

  expect(
    overlapCount,
    `Expected at least one overlapping pair of confirmed rows, got 0. ` +
      `The audit query found no overlaps even though the race should produce them.`,
  ).toBeGreaterThan(0);
}, 60000);
