import { bookableSlot } from '../availability.js';
import { pool, withTransaction } from '../db.js';
import { SELECT_WORKING_HOURS, type WorkingWindow } from './working-hours.js';

// pg returns timestamptz columns as JavaScript Date objects.
export type BookedRange = { startsAt: Date; endsAt: Date };

// A booking as the API returns it. IDs are strings because they're bigints;
// the Dates turn into UTC ISO strings in JSON.
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

// The columns of a Booking with the API's names, shared by every query here
// so they all return the same shape. The double quotes keep the capitals;
// without them PostgreSQL would return "resourceid", "startsat" and so on.
const BOOKING_COLUMNS = `id, resource_id AS "resourceId", service_id AS "serviceId",
  starts_at AS "startsAt", ends_at AS "endsAt", status,
  customer_name AS "customerName", customer_email AS "customerEmail",
  created_at AS "createdAt"`;

// Two kinds of failure, because the route answers them differently: 404 for
// a resource or service not in this organization, 400 for a start that isn't
// offered.
export type CreateBookingResult =
  | { status: 'created'; booking: Booking }
  | { status: 'notFound' }
  | { status: 'notOffered' };

// Books one guest into one slot in a single transaction: lock the resource
// row, read the service and working hours, check the start, insert (D-012).
//
// The lock doesn't decide who wins; the bookings_no_overlap constraint does.
// An overlap makes the INSERT fail with 23P01, which becomes a 409. The lock
// just makes requests for the same resource wait their turn instead of
// deadlocking. Saving working hours takes the same lock, so the hours can't
// change under us between the read and the insert.
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
      // Nothing was written, so committing here is harmless.
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

    // Store the slot's times, not the request's: the end is always the
    // start plus the service's duration.
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

// The confirmed bookings that overlap [start, end), for the availability
// route. Cancelled bookings don't block a slot, same as in the constraint.
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

// The bookings of one resource that start inside [start, end), confirmed
// and cancelled, oldest first. The route has already checked the resource
// belongs to this organization; we filter on org_id anyway, like every
// tenant query.
//
// id breaks ties: a cancelled booking and a newer confirmed one can start at
// the same instant, and we want a stable order.
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

// One booking, or null if it's not in this organization. The filter is just
// org_id and id, so if org_id ever went missing the isolation test would
// catch it.
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

// Cancels one booking and returns it, or null if it's not in this
// organization. No lock needed: cancelling can never create an overlap.
// Cancelling twice just returns the booking again, so a retry is safe.
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
