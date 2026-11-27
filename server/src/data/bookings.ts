import { bookableSlot } from '../availability.js';
import { pool, withTransaction } from '../db.js';
import { hashToken } from '../tokens.js';
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
  // Who made it: staff, or a customer on the public booking page.
  source: 'staff' | 'public';
  createdAt: Date;
};

// The columns of a Booking with the API's names, shared by every query here
// so they all return the same shape. The double quotes keep the capitals;
// without them PostgreSQL would return "resourceid", "startsat" and so on.
const BOOKING_COLUMNS = `id, resource_id AS "resourceId", service_id AS "serviceId",
  starts_at AS "startsAt", ends_at AS "endsAt", status,
  customer_name AS "customerName", customer_email AS "customerEmail",
  source, created_at AS "createdAt"`;

// The route answers each failure differently: 404 for a resource or service
// not in this organization, 400 for a start that isn't offered, 429 when the
// room's online bookings for the day are used up, 422 when a key comes back
// with different details. The names come back so the public page can
// confirm what was booked.
export type CreateBookingResult =
  | {
      status: 'created';
      booking: Booking;
      resourceName: string;
      serviceName: string;
      timeZone: string;
    }
  | { status: 'notFound' }
  | { status: 'notOffered' }
  | { status: 'capReached' }
  | { status: 'keyReused' };

// Extra rules for a booking from the public page: it must start before
// latestStart, and the room takes at most dailyCap online bookings created
// in any 24 hours.
export type OnlineRules = { latestStart: Date; dailyCap: number };

// Books one guest into one slot in a single transaction: lock the resource
// row, read the service and working hours, check the start, insert (D-012).
//
// With an idempotency key, a booking already made with that key is answered
// again instead of booking twice. The lookup comes right after the lock:
// copies of one request name the same room, so the second waits for the
// first to commit and then finds its booking. It comes before every other
// check, so a repeat still gets its booking once the start has passed or the
// day's cap is used up, and never counts towards the cap again.
//
// The lock doesn't decide who wins; the bookings_no_overlap constraint does.
// An overlap makes the INSERT fail with 23P01, which becomes a 409. The lock
// just makes requests for the same resource wait their turn instead of
// deadlocking. Saving working hours takes the same lock, so the hours can't
// change under us between the read and the insert.
//
// With `online` set, the booking is stored as 'public'. The same lock makes
// the daily count exact: two online bookings for one room can't both count
// 19 and both get in, because the second counts only after the first
// commits.
//
// An online booking also stores the hash of its cancel link's secret. The
// page makes the secret, so a repeat still has it; a repeat with another
// secret counts as different details. A secret already in use breaks the
// UNIQUE and becomes a 409.
export async function createBooking(
  orgId: string,
  request: {
    resourceId: string;
    serviceId: string;
    startsAt: string;
    customerName: string;
    customerEmail: string;
    idempotencyKey?: string;
    manageToken?: string;
  },
  now: Date,
  online?: OnlineRules,
): Promise<CreateBookingResult> {
  return withTransaction(async (client) => {
    const resource = await client.query<{ name: string; timeZone: string }>(
      `SELECT name, time_zone AS "timeZone" FROM resources
       WHERE org_id = $1 AND id = $2 FOR UPDATE`,
      [orgId, request.resourceId],
    );
    if (resource.rowCount === 0) {
      // Nothing was written, so committing here is harmless.
      return { status: 'notFound' };
    }

    if (request.idempotencyKey !== undefined) {
      const earlier = await client.query<
        Booking & { serviceName: string; manageTokenHash: Buffer | null }
      >(
        `SELECT ${BOOKING_COLUMNS}, manage_token_hash AS "manageTokenHash",
           (SELECT name FROM services
            WHERE org_id = bookings.org_id AND id = bookings.service_id) AS "serviceName"
         FROM bookings WHERE org_id = $1 AND idempotency_key = $2`,
        [orgId, request.idempotencyKey],
      );
      if (earlier.rowCount !== 0) {
        const { serviceName, manageTokenHash, ...booking } = earlier.rows[0];
        if (
          !sameRequest(booking, request, online === undefined) ||
          !sameSecret(manageTokenHash, request.manageToken)
        ) {
          return { status: 'keyReused' };
        }
        return {
          status: 'created',
          booking,
          resourceName: resource.rows[0].name,
          serviceName,
          timeZone: resource.rows[0].timeZone,
        };
      }
    }
    const service = await client.query<{
      name: string;
      durationMinutes: number;
    }>(
      `SELECT name, duration_minutes AS "durationMinutes" FROM services
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

    if (online !== undefined) {
      // Past the horizon counts as not offered, same as the public page's
      // free times.
      if (Date.parse(slot.startsAt) >= online.latestStart.getTime()) {
        return { status: 'notOffered' };
      }
      // Cancelled ones count too: the cap limits how many rows a stranger
      // can create in a day, and so how many staff might have to clean up.
      const recent = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM bookings
         WHERE org_id = $1 AND resource_id = $2 AND source = 'public'
           AND created_at > now() - interval '24 hours'`,
        [orgId, request.resourceId],
      );
      if (recent.rows[0].count >= online.dailyCap) {
        return { status: 'capReached' };
      }
    }

    // Store the slot's times, not the request's: the end is always the
    // start plus the service's duration.
    const inserted = await client.query<Booking>(
      `INSERT INTO bookings
         (org_id, resource_id, service_id, starts_at, ends_at, customer_name, customer_email, source, idempotency_key, manage_token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${BOOKING_COLUMNS}`,
      [
        orgId,
        request.resourceId,
        request.serviceId,
        slot.startsAt,
        slot.endsAt,
        request.customerName,
        request.customerEmail,
        online === undefined ? 'staff' : 'public',
        request.idempotencyKey ?? null,
        request.manageToken === undefined
          ? null
          : hashToken(request.manageToken),
      ],
    );
    return {
      status: 'created',
      booking: inserted.rows[0],
      resourceName: resource.rows[0].name,
      serviceName: service.rows[0].name,
      timeZone: resource.rows[0].timeZone,
    };
  });
}

// True if a repeat asks for exactly the booking that was made with its key.
// The start is compared as an instant, so +05:30 and Z spellings match.
function sameRequest(
  booking: Booking,
  request: {
    resourceId: string;
    serviceId: string;
    startsAt: string;
    customerName: string;
    customerEmail: string;
  },
  byStaff: boolean,
): boolean {
  return (
    booking.resourceId === request.resourceId &&
    booking.serviceId === request.serviceId &&
    booking.startsAt.getTime() === Date.parse(request.startsAt) &&
    booking.customerName === request.customerName &&
    booking.customerEmail === request.customerEmail &&
    booking.source === (byStaff ? 'staff' : 'public')
  );
}

// True if a repeat brings the cancel secret the booking was stored with, or
// neither has one.
function sameSecret(stored: Buffer | null, token: string | undefined) {
  if (stored === null || token === undefined) {
    return stored === null && token === undefined;
  }
  return stored.equals(hashToken(token));
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

// ---- The customer's cancel link ----

// Online cancelling closes this long before the start. Staff can cancel any
// time.
export const CANCEL_NOTICE_HOURS = 24;

// What the cancel link shows: when and what, never who, and no IDs.
export type ManagedBooking = {
  businessName: string;
  serviceName: string;
  resourceName: string;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  status: 'confirmed' | 'cancelled';
  cancelBefore: Date;
};

// Shared by lookup and cancel. `b` is the bookings table or the rows the
// cancel just changed. $2 is CANCEL_NOTICE_HOURS.
const MANAGED_COLUMNS = `o.name AS "businessName", s.name AS "serviceName",
  r.name AS "resourceName", b.starts_at AS "startsAt", b.ends_at AS "endsAt",
  r.time_zone AS "timeZone", b.status,
  b.starts_at - make_interval(hours => $2) AS "cancelBefore"`;
const MANAGED_JOINS = `JOIN organizations o ON o.id = b.org_id
  JOIN resources r ON r.org_id = b.org_id AND r.id = b.resource_id
  JOIN services s ON s.org_id = b.org_id AND s.id = b.service_id`;

// The booking behind a cancel link, until it starts; null after that or for
// an unknown secret. A staff booking has no hash, so no secret finds one.
export async function findByManageToken(
  token: string,
): Promise<ManagedBooking | null> {
  const result = await pool.query<ManagedBooking>(
    `SELECT ${MANAGED_COLUMNS} FROM bookings b ${MANAGED_JOINS}
     WHERE b.manage_token_hash = $1 AND b.starts_at > now()`,
    [hashToken(token), CANCEL_NOTICE_HOURS],
  );
  return result.rows[0] ?? null;
}

export type ManageCancelResult =
  | { status: 'cancelled'; booking: ManagedBooking }
  | { status: 'tooLate' }
  | { status: 'notFound' };

// Cancels the booking behind a cancel link, while more than
// CANCEL_NOTICE_HOURS are left. The database's clock decides, like every
// other time rule here.
//
// The cancel is one UPDATE, so PostgreSQL locks the row: two cancels, or a
// customer's and a staff one, run one after the other and both succeed.
// Only when it changes nothing do we read the booking to pick the answer.
// The read never writes and a start never changes, so the only thing that
// can happen in between is a staff cancel, and then "cancelled" is true.
export async function cancelByManageToken(
  token: string,
): Promise<ManageCancelResult> {
  const result = await pool.query<ManagedBooking>(
    `WITH b AS (
       UPDATE bookings SET status = 'cancelled'
       WHERE manage_token_hash = $1
         AND starts_at > now() + make_interval(hours => $2)
       RETURNING org_id, resource_id, service_id, starts_at, ends_at, status
     )
     SELECT ${MANAGED_COLUMNS} FROM b ${MANAGED_JOINS}`,
    [hashToken(token), CANCEL_NOTICE_HOURS],
  );
  if (result.rows[0] !== undefined) {
    return { status: 'cancelled', booking: result.rows[0] };
  }
  const booking = await findByManageToken(token);
  if (booking === null) return { status: 'notFound' };
  if (booking.status === 'cancelled') return { status: 'cancelled', booking };
  return { status: 'tooLate' };
}
