import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { createBooking } from '../data/bookings.js';
import { isValidId } from '../ids.js';
import { notFoundHandler, sendValidationError } from '../middleware/errors.js';

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
