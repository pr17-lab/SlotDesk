// Layer 3 mutation proof (D-016).
//
// This test is expected to show double booking, which proves the race harness
// can catch it. On a scratch table with no exclusion constraint, a "check then
// insert" lets two connections both see no conflict and both insert.
//
// If it ever fails, the harness has stopped racing. Fix the harness; never
// loosen the assertion.

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

const { url, createClient } = requireTestDatabase();

let setupClient: pg.Client;
let raceClients: pg.Client[] = [];

// 1-hour slots, on a different day from the race test.
const SLOT_BASE = '2027-06-01T00:00:00Z';

beforeAll(async () => {
  setupClient = createClient();
  await connectAndVerify(setupClient);

  // Dropped first so a crashed earlier run leaves nothing behind. Only
  // race_scratch is touched, never the real tables.
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
  await endClients(raceClients);
  await setupClient.query('DROP SCHEMA IF EXISTS race_scratch CASCADE');
  await setupClient.end();
});

it('naive SELECT-then-INSERT lets multiple connections double-book the same slot', async () => {
  raceClients = await openClients(url, CONNECTIONS);

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
          // The naive check: two connections can both see no overlap here
          // and both go on to INSERT.
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

  // Printed on purpose: pino is silent under test and assertion messages
  // show only on failure.
  process.stdout.write(
    `[mutation] connections=${CONNECTIONS} rounds=${ROUNDS} ` +
      `committed=${totalCommitted} rejected-by-check=${totalRejectedByCheck} ` +
      `other=${totalOther} rounds-with-multiple-winners=${roundsWithMultipleWinners} ` +
      `spreadMs min=${minSpread} median=${medianSpread} max=${maxSpread}\n`,
  );

  // At least one round must have more than one winner.
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
