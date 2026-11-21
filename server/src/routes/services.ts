import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createService,
  getService,
  listServices,
  updateService,
} from '../data/services.js';
import { isValidId } from '../ids.js';
import { notFoundHandler, sendValidationError } from '../middleware/errors.js';
import { requireOwner } from '../middleware/role.js';

const nameSchema = z.string().trim().min(1).max(100);

// 5 to 480 minutes in steps of 5, same as the database CHECK. z.int() isn't
// redundant: multipleOf(5) lets 30.000000000000004 through, which the
// database would refuse with a 500.
const durationSchema = z.int().min(5).max(480).multipleOf(5);

const createServiceSchema = z.object({
  name: nameSchema,
  durationMinutes: durationSchema,
});

// Strict, so a misspelt key like "duration" is a 400 instead of being
// ignored. The refine rejects {}: an update has to change something.
const updateServiceSchema = z
  .strictObject({
    name: nameSchema.optional(),
    durationMinutes: durationSchema.optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.durationMinutes !== undefined,
    { message: 'Provide name or durationMinutes' },
  );

// No mergeParams: the organization comes from res.locals.membership.
export const servicesRouter = Router();

servicesRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  // shortcut: no pagination on GET /api/orgs/:orgId/services, add it if an organization can have many services (D-032)
  const services = await listServices(res.locals.membership.orgId);
  res.status(200).json(services);
});

servicesRouter.post(
  '/',
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    // safeParse, because a missing body must be a 400, not a 500.
    const parsed = createServiceSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const service = await createService(
      res.locals.membership.orgId,
      parsed.data.name,
      parsed.data.durationMinutes,
    );
    res.status(201).json(service);
  },
);

servicesRouter.get(
  '/:serviceId',
  async (req: Request, res: Response): Promise<void> => {
    const serviceId = req.params.serviceId;
    // No point querying for a malformed ID.
    if (!isValidId(serviceId)) {
      notFoundHandler(req, res);
      return;
    }
    const service = await getService(res.locals.membership.orgId, serviceId);
    if (service === null) {
      notFoundHandler(req, res);
      return;
    }
    res.status(200).json(service);
  },
);

servicesRouter.patch(
  '/:serviceId',
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    const serviceId = req.params.serviceId;
    if (!isValidId(serviceId)) {
      notFoundHandler(req, res);
      return;
    }
    const parsed = updateServiceSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const service = await updateService(
      res.locals.membership.orgId,
      serviceId,
      parsed.data.name,
      parsed.data.durationMinutes,
    );
    if (service === null) {
      notFoundHandler(req, res);
      return;
    }
    res.status(200).json(service);
  },
);
