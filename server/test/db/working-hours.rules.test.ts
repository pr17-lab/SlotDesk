// Database rule tests for the working_hours table (Step 9c, D-032).
// Each test proves one database rule on a direct connection, without the API.
// Uses TEST_DATABASE_URL only, never DATABASE_URL (D-016).
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertOrg, insertResource } from './helpers/booking-data.js';
import {
  connectAndVerify,
  expectError,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

const { createClient } = requireTestDatabase();

let client: pg.Client;
let orgA: bigint;
let orgB: bigint;
let resourceA: bigint;
let resourceA2: bigint;

async function insertWindow(
  oid: bigint,
  resourceId: bigint,
  weekday: number,
  startMinute: number,
  endMinute: number,
): Promise<void> {
  await client.query(
    `INSERT INTO working_hours (org_id, resource_id, weekday, start_minute, end_minute)
     VALUES ($1, $2, $3, $4, $5)`,
    [oid, resourceId, weekday, startMinute, endMinute],
  );
}

async function countWindows(): Promise<number> {
  const r = await client.query<{ count: string }>(
    'SELECT count(*) FROM working_hours',
  );
  return Number(r.rows[0]!.count);
}

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  orgA = await insertOrg(client, 'Working Hours Rules Org A');
  orgB = await insertOrg(client, 'Working Hours Rules Org B');
  resourceA = await insertResource(client, orgA, 'Chair 1');
  resourceA2 = await insertResource(client, orgA, 'Chair 2');
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
});

beforeEach(async () => {
  await client.query('TRUNCATE working_hours');
});

describe('working_hours constraint tests', () => {
  it('accepts two touching windows on one weekday (half-open ranges)', async () => {
    await insertWindow(orgA, resourceA, 1, 540, 780);
    await insertWindow(orgA, resourceA, 1, 780, 1020);
    expect(await countWindows()).toBe(2);
  });

  it('accepts the same times on another weekday', async () => {
    await insertWindow(orgA, resourceA, 1, 540, 780);
    await insertWindow(orgA, resourceA, 2, 540, 780);
    expect(await countWindows()).toBe(2);
  });

  it('accepts the same times on another resource', async () => {
    await insertWindow(orgA, resourceA, 1, 540, 780);
    await insertWindow(orgA, resourceA2, 1, 540, 780);
    expect(await countWindows()).toBe(2);
  });

  it('accepts the whole day, 0 to 1440', async () => {
    await insertWindow(orgA, resourceA, 1, 0, 1440);
    expect(await countWindows()).toBe(1);
  });

  it('refuses an overlapping window on the same resource and weekday (23P01)', async () => {
    await insertWindow(orgA, resourceA, 1, 540, 780);
    const err = await expectError(() =>
      insertWindow(orgA, resourceA, 1, 779, 1020),
    );
    expect(err.code).toBe('23P01');
    expect(err.constraint).toBe('working_hours_no_overlap');
    expect(await countWindows()).toBe(1);
  });

  it.each([0, 8])('refuses weekday %i (23514)', async (weekday) => {
    const err = await expectError(() =>
      insertWindow(orgA, resourceA, weekday, 540, 780),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('working_hours_weekday_check');
    expect(await countWindows()).toBe(0);
  });

  // Each pair breaks exactly one part of the CHECK: -1 to 60 only the lower
  // bound, 0 to 1441 only the upper bound, 600 to 600 only start < end.
  it.each([
    [-1, 60],
    [0, 1441],
    [600, 600],
  ])('refuses start %i with end %i (23514)', async (start, end) => {
    const err = await expectError(() =>
      insertWindow(orgA, resourceA, 1, start, end),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('working_hours_minutes_check');
    expect(await countWindows()).toBe(0);
  });

  it("refuses org B's ID with org A's resource (23503)", async () => {
    const err = await expectError(() =>
      insertWindow(orgB, resourceA, 1, 540, 780),
    );
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('working_hours_resource_fkey');
    expect(await countWindows()).toBe(0);
  });
});
