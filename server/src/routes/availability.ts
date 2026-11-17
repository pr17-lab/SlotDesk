import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  availableSlots,
  bookingSearchRange,
  daysInRange,
  MAX_RANGE_DAYS,
} from '../availability.js';
import { listConfirmedBookings } from '../data/bookings.js';
import { getResource } from '../data/resources.js';
import { getService } from '../data/services.js';
import { listWorkingHours } from '../data/working-hours.js';
import { isValidId } from '../ids.js';
import { notFoundHandler, sendValidationError } from '../middleware/errors.js';

// A local date such as 2026-11-23, in the resource's time zone.
//
// Why abort: true (Tested): in Zod 4.6.7 a failed format check on a string
// does not stop the object-level refines below. Without it, from=2026-02-30
// reached daysInRange, temporal-polyfill threw "RangeError: Invalid day: 30",
// and the route would answer 500. With abort: true that field fails alone
// and the refines below are skipped.
//
// Why the year bounds (Tested, PostgreSQL 16): without them 0000-01-01 and
// 9999-12-31 are valid ISO dates, but bookingSearchRange then produces
// -000001-12-31T00:00:00Z or +010000-01-02T00:00:00Z, which PostgreSQL
// refuses (a 500). Comparing YYYY-MM-DD strings works because they sort like
// dates.
const localDate = z.iso
  .date({ abort: true })
  .refine((value) => value >= '2000-01-01' && value <= '2099-12-31', {
    message: 'Date must be between 2000-01-01 and 2099-12-31',
    abort: true,
  });

// Strict, so an unknown or misspelt key is a 400. Express 5 turns a repeated
// key (from=a&from=b) into an array, which is a 400 here (expected string,
// received array).
//
// A malformed serviceId is a 400, because it is a query value, not a path
// segment. An unknown one, or one from another organization, is a 404 (in
// the handler below).
//
// query.from <= query.to compares strings, which works because YYYY-MM-DD
// strings sort like dates.
const availabilityQuerySchema = z
  .strictObject({
    serviceId: z.string().refine(isValidId, { message: 'Not a valid id' }),
    from: localDate,
    to: localDate,
  })
  .refine((query) => query.from <= query.to, {
    message: 'from must not be after to',
    path: ['to'],
  })
  .refine((query) => daysInRange(query.from, query.to) <= MAX_RANGE_DAYS, {
    message: `The range must be at most ${MAX_RANGE_DAYS} days`,
    path: ['to'],
  });

// mergeParams is needed here: :resourceId belongs to the mount path in
// resources.ts ('/:resourceId/availability'), so without it
// req.params.resourceId would be undefined. The organization still comes
// only from res.locals.membership, never from req.params.
export const availabilityRouter = Router({ mergeParams: true });

// The free start times for one service on one resource. The answer is a
// hint, not a promise: two people can see the same free slot, and in Week 3
// the bookings exclusion constraint decides who gets it. Members only in
// Week 2 (public availability for guests is a Week 3 decision).
availabilityRouter.get(
  '/',
  async (req: Request, res: Response): Promise<void> => {
    const resourceId = req.params.resourceId;
    // A malformed ID is a 404 without a database query.
    if (!isValidId(resourceId)) {
      notFoundHandler(req, res);
      return;
    }
    const parsed = availabilityQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const { serviceId, from, to } = parsed.data;
    const orgId = res.locals.membership.orgId;

    // The reads below are separate queries, not one transaction. A write
    // between them can only make the hint slightly stale, which a hint may
    // be.
    const resource = await getResource(orgId, resourceId);
    if (resource === null) {
      notFoundHandler(req, res);
      return;
    }
    // The same 404 as a missing resource, so another organization's service
    // looks exactly like one that does not exist (D-030).
    const service = await getService(orgId, serviceId);
    if (service === null) {
      notFoundHandler(req, res);
      return;
    }
    const windows = await listWorkingHours(orgId, resourceId);
    const range = bookingSearchRange(from, to);
    const bookings = await listConfirmedBookings(
      orgId,
      resourceId,
      range.start,
      range.end,
    );

    const slots = availableSlots({
      timeZone: resource.timeZone,
      windows,
      durationMinutes: service.durationMinutes,
      bookings,
      from,
      to,
      now: new Date(),
    });
    res.status(200).json({ timeZone: resource.timeZone, slots });
  },
);
