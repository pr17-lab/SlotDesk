import { pool, withTransaction } from '../db.js';

// All numbers: pg returns smallint and integer as numbers (only bigint
// comes back as a string).
export type WorkingWindow = {
  weekday: number;
  startMinute: number;
  endMinute: number;
};

// Used in three places: listWorkingHours, replaceWorkingHours (to read the
// week back) and createBooking. The double quotes keep the capital M.
export const SELECT_WORKING_HOURS = `SELECT weekday, start_minute AS "startMinute", end_minute AS "endMinute"
  FROM working_hours WHERE org_id = $1 AND resource_id = $2
  ORDER BY weekday, start_minute`;

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

// Replaces a resource's whole week in one transaction, so it's all or
// nothing. Returns null if the resource isn't in this organization.
export async function replaceWorkingHours(
  orgId: string,
  resourceId: string,
  windows: WorkingWindow[],
): Promise<WorkingWindow[] | null> {
  return withTransaction(async (client) => {
    // Lock the resource row first. Without it, two saves at the same moment
    // would both delete and both insert, and one would fail on
    // working_hours_no_overlap. With it, the second waits and the last save
    // wins. Same lock-first idea as booking.
    const resource = await client.query(
      'SELECT id FROM resources WHERE org_id = $1 AND id = $2 FOR UPDATE',
      [orgId, resourceId],
    );
    if (resource.rowCount === 0) {
      // Nothing was written, so committing here is harmless.
      return null;
    }
    await client.query(
      'DELETE FROM working_hours WHERE org_id = $1 AND resource_id = $2',
      [orgId, resourceId],
    );
    // One INSERT per window: there are at most 70, and it reads more plainly
    // than a multi-row insert.
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
    // Read it back on the same client, so the response is exactly what was
    // stored.
    const stored = await client.query<WorkingWindow>(SELECT_WORKING_HOURS, [
      orgId,
      resourceId,
    ]);
    return stored.rows;
  });
}
