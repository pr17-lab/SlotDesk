import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { createBooking } from '../data/bookings.js';
import { findOrganizationBySlug } from '../data/organizations.js';
import { listResources } from '../data/resources.js';
import { listServices } from '../data/services.js';
import { isValidId } from '../ids.js';
import { notFoundHandler, sendValidationError } from '../middleware/errors.js';
import { requireTrustedOrigin } from '../middleware/origin.js';
import { availabilityQuerySchema, findFreeTimes } from './availability.js';
import { createBookingSchema, sendNotOffered } from './bookings.js';

// The public booking page's API: no session, and the business comes from the
// link, never from a membership. Mounted on its own in app.ts, so no staff
// route can be reached from here.

// How far ahead customers can book online. Staff have no limit.
const HORIZON_DAYS = 30;

// 3 to 40 lowercase letters, digits and hyphens, starting and ending with a
// letter or digit. The database checks the same pattern.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

// The link name as the owner types it. Trimmed and lowercased first, so
// "Sunrise-Physio" is saved as "sunrise-physio".
export const bookingSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SLUG_PATTERN, {
    message:
      'Use 3 to 40 letters, digits or hyphens, starting and ending with a letter or digit',
  });

declare global {
  // Express declares Locals in a global namespace, so adding to it needs one.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      // Set only by resolvePublicOrg; read it only in routes behind it.
      publicOrg: { id: string; name: string };
    }
  }
}

// Finds the business whose page is on at this link. An unknown link, a
// turned-off one and a malformed one all get the same 404 as an unknown
// route, and a malformed one never reaches the database.
const resolvePublicOrg = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    notFoundHandler(req, res);
    return;
  }
  const org = await findOrganizationBySlug(slug);
  if (org === null) {
    notFoundHandler(req, res);
    return;
  }
  res.locals.publicOrg = org;
  next();
};

const latestStart = (now: Date): Date =>
  new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000);

export const publicRouter = Router();
// Stops other sites' pages from booking through their visitors' browsers.
// GETs skip it.
publicRouter.use(requireTrustedOrigin);

// mergeParams, because resolvePublicOrg reads :slug from the mount path.
const businessRouter = Router({ mergeParams: true });
businessRouter.use(resolvePublicOrg);

// What the page needs to show: the business name, who or where to book, and
// the services. No members, emails or bookings.
businessRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  const org = res.locals.publicOrg;
  const [resources, services] = await Promise.all([
    listResources(org.id),
    listServices(org.id),
  ]);
  res.status(200).json({ name: org.name, resources, services });
});

// Free times only, never a booking, and none past the horizon.
businessRouter.get(
  '/resources/:resourceId/availability',
  async (req: Request, res: Response): Promise<void> => {
    const resourceId = req.params.resourceId;
    if (!isValidId(resourceId)) {
      notFoundHandler(req, res);
      return;
    }
    const parsed = availabilityQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const now = new Date();
    const freeTimes = await findFreeTimes(
      res.locals.publicOrg.id,
      resourceId,
      parsed.data,
      now,
    );
    if (freeTimes === null) {
      notFoundHandler(req, res);
      return;
    }
    const latest = latestStart(now).getTime();
    res.status(200).json({
      timeZone: freeTimes.timeZone,
      slots: freeTimes.slots.filter(
        (slot) => Date.parse(slot.startsAt) < latest,
      ),
    });
  },
);

// Books through the same createBooking as staff, with the online rules on.
// The answer is what the confirmation shows: no booking ID and no customer
// details.
businessRouter.post(
  '/bookings',
  async (req: Request, res: Response): Promise<void> => {
    const parsed = createBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const now = new Date();
    const result = await createBooking(
      res.locals.publicOrg.id,
      parsed.data,
      now,
      { latestStart: latestStart(now), dailyCap: config.publicDailyBookingCap },
    );
    if (result.status === 'notFound') {
      notFoundHandler(req, res);
      return;
    }
    if (result.status === 'notOffered') {
      sendNotOffered(res);
      return;
    }
    if (result.status === 'capReached') {
      res.status(429).json({ error: 'Daily limit reached' });
      return;
    }
    res.status(201).json({
      startsAt: result.booking.startsAt,
      endsAt: result.booking.endsAt,
      serviceName: result.serviceName,
      resourceName: result.resourceName,
      timeZone: result.timeZone,
    });
  },
);

publicRouter.use('/:slug', businessRouter);
