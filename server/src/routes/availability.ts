import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { availableSlots, bookingSearchRange } from '../availability.js';
import { listConfirmedBookings } from '../data/bookings.js';
import { getResource } from '../data/resources.js';
import { getService } from '../data/services.js';
import { listWorkingHours } from '../data/working-hours.js';
import { isValidId } from '../ids.js';
import { notFoundHandler, sendValidationError } from '../middleware/errors.js';
import { localDate, withDateRangeRules } from './date-range.js';

// Strict, so an unknown or misspelt key is a 400. Express 5 turns a repeated
// key (from=a&from=b) into an array, which is a 400 here (expected string,
// received array).
//
// A malformed serviceId is a 400, because it is a query value, not a path
// segment. An unknown one, or one from another organization, is a 404 (in
// the handler below).
//
// The from and to rules (the date format, the years, from not after to, at
// most 14 days) live in date-range.ts, shared with the booking list.
const availabilityQuerySchema = withDateRangeRules(
  z.strictObject({
    serviceId: z.string().refine(isValidId, { message: 'Not a valid id' }),
    from: localDate,
    to: localDate,
  }),
);

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
