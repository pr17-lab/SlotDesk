import { pool } from '../db.js';

// pg returns timestamptz columns as JavaScript Date objects.
export type BookedRange = { startsAt: Date; endsAt: Date };

// The bookings table exists since Step 3; Week 3 adds the booking route's
// queries to this file.
//
// A single pool.query, not pool.connect(), so the D-014 listener rule does
// not apply here: pool.query handles connection errors itself.
//
// The double quotes in "startsAt" and "endsAt" keep the capital A: without
// them PostgreSQL would return the columns as "startsat" and "endsat".
//
// Only confirmed bookings block a slot; a cancelled one frees it, as in the
// bookings_no_overlap constraint. The last line keeps every booking that
// overlaps [start, end): it starts before the range ends and ends after the
// range starts.
export async function listConfirmedBookings(
  orgId: string,
  resourceId: string,
  start: string,
  end: string,
): Promise<BookedRange[]> {
  const result = await pool.query<BookedRange>(
    `SELECT starts_at AS "startsAt", ends_at AS "endsAt"
     FROM bookings
     WHERE org_id = $1 AND resource_id = $2 AND status = 'confirmed'
       AND starts_at < $4 AND ends_at > $3`,
    [orgId, resourceId, start, end],
  );
  return result.rows;
}
