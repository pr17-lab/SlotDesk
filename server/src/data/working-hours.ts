import { pool, withTransaction } from '../db.js';

// All numbers: pg returns smallint (weekday) and integer (the minutes)
// columns as JavaScript numbers. Only bigint columns come back as strings.
export type WorkingWindow = {
  weekday: number;
  startMinute: number;
  endMinute: number;
};

// One constant because the same query runs three times: in
// listWorkingHours, inside the replaceWorkingHours transaction to read the
// stored week back, and inside the createBooking transaction in bookings.ts
// (exported for that).
//
// The double quotes in "startMinute" and "endMinute" keep the capital M:
// without them PostgreSQL would return the columns as "startminute" and
// "endminute".
export const SELECT_WORKING_HOURS = `SELECT weekday, start_minute AS "startMinute", end_minute AS "endMinute"
  FROM working_hours WHERE org_id = $1 AND resource_id = $2
  ORDER BY weekday, start_minute`;

// A single pool.query, not pool.connect(), so the D-014 listener rule does
// not apply here: pool.query handles connection errors itself.
export async function listWorkingHours(
  orgId: string,
  resourceId: string,
): Promise<WorkingWindow[]> {
  const result = await pool.query<WorkingWindow>(SELECT_WORKING_HOURS, [
    orgId,
    resourceId,
  ]);
  return result.rows;
}

// Replaces the whole week of one resource in one transaction: either every
// old window is gone and every new one is stored, or nothing changed.
// Returns null if the resource does not exist in this organization.
export async function replaceWorkingHours(
  orgId: string,
  resourceId: string,
  windows: WorkingWindow[],
): Promise<WorkingWindow[] | null> {
  return withTransaction(async (client) => {
    // Lock the resource row first. Without the lock, two PUTs for the same
    // resource at the same moment would both delete and both insert, and one
    // would fail on working_hours_no_overlap (a 500). With it, the second
    // waits here until the first commits, and the last write wins. The
    // architect measured this on 2026-11-17 (Tested, PostgreSQL 16, 50 rounds
    // of two simultaneous replaces whose Monday windows overlap): without the
    // lock one replace failed with 23P01 in 46 of 50 rounds; with it all 100
    // succeeded. It is the same lock-first shape the booking transaction
    // uses (D-012).
    const resource = await client.query(
      'SELECT id FROM resources WHERE org_id = $1 AND id = $2 FOR UPDATE',
      [orgId, resourceId],
    );
    if (resource.rowCount === 0) {
      // Nothing was written, so committing this transaction changes nothing.
      return null;
    }
    await client.query(
      'DELETE FROM working_hours WHERE org_id = $1 AND resource_id = $2',
      [orgId, resourceId],
    );
    // One INSERT per window: at most 70 windows, so the round trips do not
    // matter, and this reads more plainly than a multi-row insert.
    for (const window of windows) {
      await client.query(
        `INSERT INTO working_hours (org_id, resource_id, weekday, start_minute, end_minute)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          orgId,
          resourceId,
          window.weekday,
          window.startMinute,
          window.endMinute,
        ],
      );
    }
    // Read the week back through the same client, so the response is exactly
    // what was stored, in the same order as GET.
    const stored = await client.query<WorkingWindow>(SELECT_WORKING_HOURS, [
      orgId,
      resourceId,
    ]);
    return stored.rows;
  });
}
