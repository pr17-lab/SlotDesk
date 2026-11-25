import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { localDaysToUtcRange } from '../availability.js';
import {
  cancelBooking,
  createBooking,
  getBooking,
  listBookings,
} from '../data/bookings.js';
import { getResource } from '../data/resources.js';
import { isValidId } from '../ids.js';
import { notFoundHandler, sendValidationError } from '../middleware/errors.js';
import { localDate, withDateRangeRules } from './date-range.js';

// Body IDs get the same check as URL IDs, but a bad one is a 400 here
// because it's input, not a path.
const idSchema = z.string().refine(isValidId, { message: 'Not a valid id' });

// An exact instant with an offset or Z, like 2099-01-05T09:00:00+05:30. A
// time with no offset doesn't pin down an instant, so we refuse it.
//
// Years are kept to 2000-2099, like availability dates: a booking late on
// 9999-12-31 would end in year 10000, which PostgreSQL refuses. `abort: true`
// makes the format check run first, so slicing the year is safe.
const startsAtSchema = z.iso
  .datetime({ offset: true, abort: true })
  .refine(
    (value) => value.slice(0, 4) >= '2000' && value.slice(0, 4) <= '2099',
    { message: 'Year must be between 2000 and 2099' },
  );

// Trim first, then check: z.email().trim() would check the format before
// trimming and refuse " guest@example.com ". 254 is the longest address
// email allows.
const customerEmailSchema = z.string().trim().pipe(z.email().max(254));

// Strict, so a misspelt key is a 400. The organization never comes from the
// body. The public page takes the same fields.
export const createBookingSchema = z.strictObject({
  resourceId: idSchema,
  serviceId: idSchema,
  startsAt: startsAtSchema,
  customerName: z.string().trim().min(1).max(100),
  customerEmail: customerEmailSchema,
});

// resourceId is required because from and to are local dates in that
// resource's time zone. The date rules are shared with availability.
const listBookingsQuerySchema = withDateRangeRules(
  z.strictObject({
    resourceId: idSchema,
    from: localDate,
    to: localDate,
  }),
);

// Shaped like a validation error, with its own message so a client can tell
// it apart from a malformed start.
export function sendNotOffered(res: Response): void {
  res.status(400).json({
    error: 'Bad Request',
    details: [{ path: 'startsAt', message: 'This start time is not offered' }],
  });
}

// No mergeParams: the organization comes from res.locals.membership.
export const bookingsRouter = Router();

// Owner and staff can both book; staff run the front desk.
bookingsRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  // safeParse, because a missing body must be a 400, not a 500.
  const parsed = createBookingSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const result = await createBooking(
    res.locals.membership.orgId,
    parsed.data,
    new Date(),
  );
  if (result.status === 'notFound') {
    // Same 404 whether it doesn't exist or belongs to another organization.
    notFoundHandler(req, res);
    return;
  }
  if (result.status === 'notOffered') {
    sendNotOffered(res);
    return;
  }
  if (result.status === 'capReached') {
    // The cap is only for online bookings, which never come through here.
    throw new Error('Daily cap applied to a staff booking');
  }
  res.status(201).json(result.booking);
});

// A resource's bookings that start on the local dates `from` to `to`,
// confirmed and cancelled, oldest first.
bookingsRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  // shortcut: no pagination on the booking list; the 14-day limit keeps it small, add pagination if a resource can have hundreds of bookings in two weeks
  const parsed = listBookingsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { resourceId, from, to } = parsed.data;
  const orgId = res.locals.membership.orgId;

  // This lookup keeps other organizations out (it filters on org_id) and
  // gives us the time zone.
  const resource = await getResource(orgId, resourceId);
  if (resource === null) {
    notFoundHandler(req, res);
    return;
  }
  const range = localDaysToUtcRange(from, to, resource.timeZone);
  const bookings = await listBookings(
    orgId,
    resourceId,
    range.start,
    range.end,
  );
  res.status(200).json(bookings);
});

// One booking. Bad, unknown and other-organization IDs all get the same 404.
bookingsRouter.get(
  '/:bookingId',
  async (req: Request, res: Response): Promise<void> => {
    const bookingId = req.params.bookingId;
    // No point querying for a malformed ID.
    if (!isValidId(bookingId)) {
      notFoundHandler(req, res);
      return;
    }
    const booking = await getBooking(res.locals.membership.orgId, bookingId);
    if (booking === null) {
      notFoundHandler(req, res);
      return;
    }
    res.status(200).json(booking);
  },
);

// Cancels a booking and returns it. POST, not DELETE, because the row stays
// (it's still listed, as cancelled). Cancelling twice is fine. There's no
// un-cancel; just book the slot again.
bookingsRouter.post(
  '/:bookingId/cancel',
  async (req: Request, res: Response): Promise<void> => {
    const bookingId = req.params.bookingId;
    if (!isValidId(bookingId)) {
      notFoundHandler(req, res);
      return;
    }
    const booking = await cancelBooking(res.locals.membership.orgId, bookingId);
    if (booking === null) {
      notFoundHandler(req, res);
      return;
    }
    res.status(200).json(booking);
  },
);
