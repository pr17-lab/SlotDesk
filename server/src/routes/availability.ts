import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  availableSlots,
  bookingSearchRange,
  type Slot,
} from '../availability.js';
import { listConfirmedBookings } from '../data/bookings.js';
import { getResource } from '../data/resources.js';
import { getService } from '../data/services.js';
import { listWorkingHours } from '../data/working-hours.js';
import { isValidId } from '../ids.js';
import { notFoundHandler, sendValidationError } from '../middleware/errors.js';
import { localDate, withDateRangeRules } from './date-range.js';

// Strict, so a misspelt key is a 400. A repeated key (from=a&from=b) arrives
// as an array and is a 400 too. A malformed serviceId is a 400; an unknown
// one is a 404. The date rules live in date-range.ts. The public page uses
// the same rules.
export const availabilityQuerySchema = withDateRangeRules(
  z.strictObject({
    serviceId: z.string().refine(isValidId, { message: 'Not a valid id' }),
    from: localDate,
    to: localDate,
  }),
);

// The free start times for one service on one resource of this
// organization, or null when the resource or service isn't in it. Shared by
// the staff route and the public page, which both pass the organization in.
//
// It's a hint, not a promise: two people can see the same slot, and the
// booking constraint decides who gets it (D-032). Separate queries, no
// transaction: a write in between only makes the hint a bit stale.
export async function findFreeTimes(
  orgId: string,
  resourceId: string,
  query: z.infer<typeof availabilityQuerySchema>,
  now: Date,
): Promise<{ timeZone: string; slots: Slot[] } | null> {
  const { serviceId, from, to } = query;
  const resource = await getResource(orgId, resourceId);
  if (resource === null) {
    return null;
  }
  // Same 404 as a missing one, so another organization's service looks like
  // it doesn't exist.
  const service = await getService(orgId, serviceId);
  if (service === null) {
    return null;
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
    now,
  });
  return { timeZone: resource.timeZone, slots };
}

// mergeParams, because :resourceId is in the mount path in resources.ts.
// The organization still comes only from res.locals.membership.
export const availabilityRouter = Router({ mergeParams: true });

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
    const freeTimes = await findFreeTimes(
      res.locals.membership.orgId,
      resourceId,
      parsed.data,
      new Date(),
    );
    if (freeTimes === null) {
      notFoundHandler(req, res);
      return;
    }
    res.status(200).json(freeTimes);
  },
);
