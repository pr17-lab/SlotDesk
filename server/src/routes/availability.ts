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

// Strict, so a misspelt key is a 400. A repeated key (from=a&from=b) arrives
// as an array and is a 400 too. A malformed serviceId is a 400; an unknown
// one is a 404 below. The date rules live in date-range.ts.
const availabilityQuerySchema = withDateRangeRules(
  z.strictObject({
    serviceId: z.string().refine(isValidId, { message: 'Not a valid id' }),
    from: localDate,
    to: localDate,
  }),
);

// mergeParams, because :resourceId is in the mount path in resources.ts.
// The organization still comes only from res.locals.membership.
export const availabilityRouter = Router({ mergeParams: true });

// The free start times for one service on one resource. It's a hint, not a
// promise: two people can see the same slot, and the booking constraint
// decides who gets it (D-032).
availabilityRouter.get(
  '/',
  async (req: Request, res: Response): Promise<void> => {
    const resourceId = req.params.resourceId;
    // No point querying for a malformed ID.
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

    // Separate queries, no transaction: a write in between only makes the
    // hint a bit stale, which is fine for a hint.
    const resource = await getResource(orgId, resourceId);
    if (resource === null) {
      notFoundHandler(req, res);
      return;
    }
    // Same 404 as a missing one, so another organization's service looks
    // like it doesn't exist.
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
