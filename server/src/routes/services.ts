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

// 5 to 480 minutes in steps of 5, the same rule as the database CHECK.
// z.int() is not redundant with multipleOf(5). Zod's multipleOf allows for
// floating-point error, so it accepts 30.000000000000004; PostgreSQL then
// refuses that value for an integer column (error 22P02) and the request
// would be a 500 instead of a 400. A string such as "30" is a 400 (no
// coercion).
const durationSchema = z.int().min(5).max(480).multipleOf(5);

const createServiceSchema = z.object({
  name: nameSchema,
  durationMinutes: durationSchema,
});

// Strict, so a misspelt key ({ "name": "x", "duration": 30 }) is a 400
// instead of a silent rename that ignores the duration. The refine rejects
// {}: an update must change something.
const updateServiceSchema = z
  .strictObject({
    name: nameSchema.optional(),
    durationMinutes: durationSchema.optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.durationMinutes !== undefined,
    { message: 'Provide name or durationMinutes' },
  );

// No mergeParams: this router reads the organization only from
// res.locals.membership (set by requireMembership in orgRouter), and its only
// own parameter is :serviceId.
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
    // safeParse, not parse: req.body is undefined when no JSON body was sent,
    // and that must be a 400, not a 500.
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
    // A malformed ID is a 404 without a database query.
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
