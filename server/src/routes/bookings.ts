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

// IDs in the body are checked like IDs in a URL. A malformed one is a 400,
// because it is a body value, not a path segment (like serviceId in the
// availability query).
const idSchema = z.string().refine(isValidId, { message: 'Not a valid id' });

// An exact instant with an offset or Z, for example 2099-01-05T03:30:00Z or
// 2099-01-05T09:00:00+05:30. Without an offset a time would mean nothing,
// so it is refused.
//
// Why the year bounds: the same 2000 to 2099 limit as the availability
// dates. Zod accepts years 0000 to 9999, and a booking that starts late on
// 9999-12-31 ends in year 10000, which temporal-polyfill writes as
// +010000-..., a string PostgreSQL refuses (a 500; Step 9d finding).
// Comparing the first four characters works because the format check has
// already passed, and `abort: true` makes sure of that order.
const startsAtSchema = z.iso
  .datetime({ offset: true, abort: true })
  .refine(
    (value) => value.slice(0, 4) >= '2000' && value.slice(0, 4) <= '2099',
    { message: 'Year must be between 2000 and 2099' },
  );

// Trimmed first, then checked. Why pipe (Tested, Zod 4.6.7): checks run in
// the order written, so z.email().trim() checks the format before trimming
// and refuses " guest@example.com ". 254 characters is the longest address
// that fits in an SMTP path.
const customerEmailSchema = z.string().trim().pipe(z.email().max(254));

// Strict, so an unknown or misspelt key is a 400. The organization never
// comes from the body (D-030).
const createBookingSchema = z.strictObject({
  resourceId: idSchema,
  serviceId: idSchema,
  startsAt: startsAtSchema,
  customerName: z.string().trim().min(1).max(100),
  customerEmail: customerEmailSchema,
});

// The booking list query. Strict, like the availability query, so an
// unknown key is a 400. resourceId is required: a list is always for one
// resource, because from and to are local dates in that resource's time
// zone. The from and to rules are the availability route's, from
// date-range.ts (D-033).
const listBookingsQuerySchema = withDateRangeRules(
  z.strictObject({
    resourceId: idSchema,
    from: localDate,
    to: localDate,
  }),
);

// No mergeParams: this router reads the organization only from
// res.locals.membership (set by requireMembership in orgRouter).
export const bookingsRouter = Router();

// Owner and staff can both book (D-033 A: staff run the front desk), so
// there is no requireOwner here.
bookingsRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  // safeParse, not parse: req.body is undefined when no JSON body was sent,
  // and that must be a 400, not a 500.
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
    // The same 404 for a missing resource or service and for one in
    // another organization (D-030).
    notFoundHandler(req, res);
    return;
  }
  if (result.status === 'notOffered') {
    // The same shape as a validation error, with its own message, so a
    // client (and a test) can tell it apart from a malformed start.
    res.status(400).json({
      error: 'Bad Request',
      details: [
        { path: 'startsAt', message: 'This start time is not offered' },
      ],
    });
    return;
  }
  res.status(201).json(result.booking);
});

// The bookings of one resource that start on the local dates from `from` to
// `to` (both included, at most 14 days), confirmed and cancelled, oldest
// first (D-033). Owner and staff.
bookingsRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  // shortcut: no pagination on the booking list; the 14-day limit keeps it small, add pagination if a resource can have hundreds of bookings in two weeks
  const parsed = listBookingsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { resourceId, from, to } = parsed.data;
  const orgId = res.locals.membership.orgId;

  // The resource lookup is what keeps another organization's resource out:
  // it is filtered on org_id, so org B's resource is a 404 here, identical
  // to one that does not exist (D-030). It also gives the time zone.
  const resource = await getResource(orgId, resourceId);
  if (resource === null) {
    notFoundHandler(req, res);
    return;
  }
  // The local dates become one exact UTC range in src/availability.ts, the
  // one place for time zone conversion (D-032).
  const range = localDaysToUtcRange(from, to, resource.timeZone);
  const bookings = await listBookings(
    orgId,
    resourceId,
    range.start,
    range.end,
  );
  res.status(200).json(bookings);
});

// One booking. A malformed ID, an unknown one and another organization's
// one all get the same 404 (D-030).
bookingsRouter.get(
  '/:bookingId',
  async (req: Request, res: Response): Promise<void> => {
    const bookingId = req.params.bookingId;
    // A malformed ID is a 404 without a database query.
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

// Cancels a booking and returns it with status 'cancelled' (D-033). Owner
// and staff, like booking. POST, not DELETE, because the row stays (it is
// still listed, with its status); it also means the origin check applies,
// as for every non-GET route under /api/orgs. Cancelling twice is a 200
// both times. There is no un-cancel: book the slot again instead. A body,
// if one is sent, is ignored.
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
