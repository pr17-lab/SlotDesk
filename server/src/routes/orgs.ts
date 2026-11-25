import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createOrganizationWithOwner,
  getOrganization,
  listOrganizationsForUser,
  setBookingSlug,
} from '../data/organizations.js';
import { notFoundHandler, sendValidationError } from '../middleware/errors.js';
import { requireMembership } from '../middleware/membership.js';
import { requireTrustedOrigin } from '../middleware/origin.js';
import { requireOwner } from '../middleware/role.js';
import { requireSession } from '../middleware/session.js';
import { bookingsRouter } from './bookings.js';
import { membersRouter } from './members.js';
import { bookingSlugSchema } from './public.js';
import { resourcesRouter } from './resources.js';
import { sampleDataRouter } from './sample-data.js';
import { servicesRouter } from './services.js';

const createOrgSchema = z.object({ name: z.string().trim().min(1).max(100) });

// null turns the public booking page off. Strict, so nothing else can be
// changed through this route yet.
const updateOrgSchema = z.strictObject({
  bookingSlug: bookingSlugSchema.nullable(),
});

export const orgsRouter = Router();
orgsRouter.use(requireTrustedOrigin, requireSession);

orgsRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  // safeParse, because a missing body must be a 400, not a 500.
  const parsed = createOrgSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const org = await createOrganizationWithOwner(
    res.locals.userId,
    parsed.data.name,
  );
  res.status(201).json(org);
});

orgsRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  // shortcut: no pagination on GET /api/orgs, add it if a user can belong to many organizations
  const orgs = await listOrganizationsForUser(res.locals.userId);
  res.status(200).json(orgs);
});

// mergeParams, because requireMembership reads :orgId from the parent's
// mount path.
const orgRouter = Router({ mergeParams: true });
orgRouter.use(requireMembership);
orgRouter.use('/members', membersRouter);
orgRouter.use('/resources', resourcesRouter);
orgRouter.use('/services', servicesRouter);
orgRouter.use('/bookings', bookingsRouter);
orgRouter.use('/sample-data', sampleDataRouter);

orgRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  // The organization comes from the membership check, never the params or
  // the body.
  const { orgId, role } = res.locals.membership;
  const org = await getOrganization(orgId);
  if (org === null) {
    notFoundHandler(req, res);
    return;
  }
  res.status(200).json({ ...org, role });
});

// Only the owner turns online booking on or off, or changes the link.
orgRouter.patch(
  '/',
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = updateOrgSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const { orgId, role } = res.locals.membership;
    const org = await setBookingSlug(orgId, parsed.data.bookingSlug);
    if (org === null) {
      notFoundHandler(req, res);
      return;
    }
    res.status(200).json({ ...org, role });
  },
);

orgsRouter.use('/:orgId', orgRouter);
