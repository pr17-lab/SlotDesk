import { bookableSlot } from '../availability.js';
import { pool, withTransaction } from '../db.js';
import { SELECT_WORKING_HOURS, type WorkingWindow } from './working-hours.js';

// pg returns timestamptz columns as JavaScript Date objects.
export type BookedRange = { startsAt: Date; endsAt: Date };

// A booking as the API returns it (D-033). IDs are strings because they are
// bigints; the three times are Date objects, which JSON turns into UTC ISO
// strings.
export type Booking = {
  id: string;
  resourceId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  status: 'confirmed' | 'cancelled';
  customerName: string;
  customerEmail: string;
  createdAt: Date;
};

// The columns of a Booking, renamed to the API's names. Shared by the four
// queries in this file that return whole bookings (create, list, view,
// cancel), so they always return the same shape. The double quotes keep the
// capital letters: without them PostgreSQL would return "resourceid",
// "startsat" and so on.
const BOOKING_COLUMNS = `id, resource_id AS "resourceId", service_id AS "serviceId",
  starts_at AS "startsAt", ends_at AS "endsAt", status,
  customer_name AS "customerName", customer_email AS "customerEmail",
  created_at AS "createdAt"`;

// What createBooking found. Two kinds of failure, because the route answers
// them differently: 404 for a resource or service that is not in this
// organization, 400 for a start time that is not offered.
export type CreateBookingResult =
  | { status: 'created'; booking: Booking }
  | { status: 'notFound' }
  | { status: 'notOffered' };

// Books one guest customer into one slot, in one transaction (D-012,
// D-033 C): lock the resource row, read the service and the working hours,
// check the start, insert, commit.
//
// The lock does not decide who wins; the bookings_no_overlap constraint does.
// If another confirmed booking overlaps, the INSERT fails with 23P01, which
// the central error handler turns into a 409. The lock makes concurrent
// requests for the same resource queue here instead of deadlocking (Step
// 3b), and since replaceWorkingHours takes the same lock, the working hours
// cannot change between the read and the insert.
//
// The service and working-hours reads go through the transaction's client,
// not the pool, so they run inside the transaction and after the lock.
//
// `now` is passed in, not read from the clock, like availableSlots.
export async function createBooking(
  orgId: string,
  request: {
    resourceId: string;
    serviceId: string;
    startsAt: string;
    customerName: string;
    customerEmail: string;
  },
  now: Date,
): Promise<CreateBookingResult> {
  return withTransaction(async (client) => {
    const resource = await client.query<{ timeZone: string }>(
      `SELECT time_zone AS "timeZone" FROM resources
       WHERE org_id = $1 AND id = $2 FOR UPDATE`,
      [orgId, request.resourceId],
    );
    if (resource.rowCount === 0) {
      // Nothing was written, so committing this transaction changes nothing.
      return { status: 'notFound' };
    }
    const service = await client.query<{ durationMinutes: number }>(
      `SELECT duration_minutes AS "durationMinutes" FROM services
       WHERE org_id = $1 AND id = $2`,
      [orgId, request.serviceId],
    );
    if (service.rowCount === 0) {
      return { status: 'notFound' };
    }
    const windows = await client.query<WorkingWindow>(SELECT_WORKING_HOURS, [
      orgId,
      request.resourceId,
    ]);

    const slot = bookableSlot({
      timeZone: resource.rows[0].timeZone,
      windows: windows.rows,
      durationMinutes: service.rows[0].durationMinutes,
      startsAt: request.startsAt,
      now,
    });
    if (slot === null) {
      return { status: 'notOffered' };
    }

    // starts_at and ends_at come from the slot, not from the request, so
    // the stored start is the slot's exact instant whatever offset the client
    // wrote, and the end is the start plus the service's duration (D-033 B).
    const inserted = await client.query<Booking>(
      `INSERT INTO bookings
         (org_id, resource_id, service_id, starts_at, ends_at, customer_name, customer_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${BOOKING_COLUMNS}`,
      [
        orgId,
        request.resourceId,
        request.serviceId,
        slot.startsAt,
        slot.endsAt,
        request.customerName,
        request.customerEmail,
      ],
    );
    return { status: 'created', booking: inserted.rows[0] };
  });
}

// listConfirmedBookings is used by the availability route (Step 9d).
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

// The functions below are single pool.query calls, like
// listConfirmedBookings, so the D-014 listener rule does not apply.

// The bookings of one resource that start inside [start, end), confirmed and
// cancelled, oldest first (Step 10e). The route passes the exact UTC range of
// the requested local dates, so a booking is listed on the local date it
// starts. The route has already checked that the resource is in this
// organization; the org_id filter here is kept anyway, as in every tenant
// query (D-030).
//
// id breaks a tie: a cancelled booking and a later confirmed one can start
// at the same instant, and without it their order could change between
// calls.
export async function listBookings(
  orgId: string,
  resourceId: string,
  start: string,
  end: string,
): Promise<Booking[]> {
  const result = await pool.query<Booking>(
    `SELECT ${BOOKING_COLUMNS}
     FROM bookings
     WHERE org_id = $1 AND resource_id = $2
       AND starts_at >= $3 AND starts_at < $4
     ORDER BY starts_at, id`,
    [orgId, resourceId, start, end],
  );
  return result.rows;
}

// One booking, or null when it is not in this organization. Filtered on
// org_id and id only, so a missing org_id filter would return another
// organization's booking, and the isolation test sees it (D-033).
export async function getBooking(
  orgId: string,
  bookingId: string,
): Promise<Booking | null> {
  const result = await pool.query<Booking>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE org_id = $1 AND id = $2`,
    [orgId, bookingId],
  );
  return result.rows[0] ?? null;
}

// Cancels one booking and returns it, or null when it is not in this
// organization (D-033). No transaction and no lock: setting the status to
// cancelled can never create an overlap, because the bookings_no_overlap
// constraint covers confirmed bookings only. Cancelling a booking that is
// already cancelled changes nothing and returns it again, so a client that
// retries after losing the answer gets the same 200.
export async function cancelBooking(
  orgId: string,
  bookingId: string,
): Promise<Booking | null> {
  const result = await pool.query<Booking>(
    `UPDATE bookings SET status = 'cancelled'
     WHERE org_id = $1 AND id = $2
     RETURNING ${BOOKING_COLUMNS}`,
    [orgId, bookingId],
  );
  return result.rows[0] ?? null;
}
