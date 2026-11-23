import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { normalizeTimeZone } from '../availability.js';
import {
  createResource,
  getResource,
  listResources,
  renameResource,
} from '../data/resources.js';
import { isValidId } from '../ids.js';
import { notFoundHandler, sendValidationError } from '../middleware/errors.js';
import { requireOwner } from '../middleware/role.js';
import { availabilityRouter } from './availability.js';
import { workingHoursRouter } from './working-hours.js';

const nameSchema = z.string().trim().min(1).max(100);

// Stores the normalised name, so 'asia/kolkata' is saved as 'Asia/Kolkata'.
// z.NEVER tells TypeScript nothing comes back after an issue.
export const timeZoneSchema = z
  .string()
  .max(64)
  .transform((value, ctx) => {
    const normalized = normalizeTimeZone(value);
    if (normalized === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Not a valid IANA time zone name',
      });
      return z.NEVER;
    }
    return normalized;
  });

const createResourceSchema = z.object({
  name: nameSchema,
  timeZone: timeZoneSchema,
});

// No timeZone here: it's fixed at creation, because changing it would
// quietly move every working-hours window while bookings stay put (D-032).
// Strict, so sending timeZone is a 400.
const renameResourceSchema = z.strictObject({ name: nameSchema });

// No mergeParams: the organization comes from res.locals.membership.
export const resourcesRouter = Router();

resourcesRouter.get(
  '/',
  async (_req: Request, res: Response): Promise<void> => {
    // shortcut: no pagination on GET /api/orgs/:orgId/resources, add it if an organization can have many resources (D-032)
    const resources = await listResources(res.locals.membership.orgId);
    res.status(200).json(resources);
  },
);

resourcesRouter.post(
  '/',
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    // safeParse, because a missing body must be a 400, not a 500.
    const parsed = createResourceSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const resource = await createResource(
      res.locals.membership.orgId,
      parsed.data.name,
      parsed.data.timeZone,
    );
    res.status(201).json(resource);
  },
);

resourcesRouter.get(
  '/:resourceId',
  async (req: Request, res: Response): Promise<void> => {
    const resourceId = req.params.resourceId;
    // No point querying for a malformed ID.
    if (!isValidId(resourceId)) {
      notFoundHandler(req, res);
      return;
    }
    const resource = await getResource(res.locals.membership.orgId, resourceId);
    if (resource === null) {
      notFoundHandler(req, res);
      return;
    }
    res.status(200).json(resource);
  },
);

resourcesRouter.patch(
  '/:resourceId',
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    const resourceId = req.params.resourceId;
    if (!isValidId(resourceId)) {
      notFoundHandler(req, res);
      return;
    }
    const parsed = renameResourceSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const resource = await renameResource(
      res.locals.membership.orgId,
      resourceId,
      parsed.data.name,
    );
    if (resource === null) {
      notFoundHandler(req, res);
      return;
    }
    res.status(200).json(resource);
  },
);

resourcesRouter.use('/:resourceId/working-hours', workingHoursRouter);
// availabilityRouter uses mergeParams to read :resourceId from this path.
resourcesRouter.use('/:resourceId/availability', availabilityRouter);
