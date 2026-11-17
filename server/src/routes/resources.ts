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

// The stored value is the library's normalised name, so 'asia/kolkata' is
// saved as 'Asia/Kolkata'. The transform runs only if the length check
// passed. z.NEVER tells TypeScript nothing is returned after an issue.
const timeZoneSchema = z
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

// Strict, and without timeZone: the time zone cannot be changed after
// creation (D-032), because that would silently move every working-hours
// window while bookings stay put. A body with timeZone, or any other unknown
// key, is a 400.
const renameResourceSchema = z.strictObject({ name: nameSchema });

// No mergeParams: this router reads the organization only from
// res.locals.membership (set by requireMembership in orgRouter), and its only
// own parameter is :resourceId.
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
    // safeParse, not parse: req.body is undefined when no JSON body was sent,
    // and that must be a 400, not a 500.
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
    // A malformed ID is a 404 without a database query.
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
resourcesRouter.use('/:resourceId/availability', availabilityRouter);
