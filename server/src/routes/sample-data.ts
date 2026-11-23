import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { createSampleData } from '../data/sample-data.js';
import { sendValidationError } from '../middleware/errors.js';
import { requireOwner } from '../middleware/role.js';
import { timeZoneSchema } from './resources.js';

// Strict, so a misspelt key is a 400 instead of being quietly dropped.
const sampleDataSchema = z.strictObject({ timeZone: timeZoneSchema });

// The "Create sample data" button on an empty organization.
export const sampleDataRouter = Router({ mergeParams: true });

sampleDataRouter.post(
  '/',
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = sampleDataSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const result = await createSampleData(
      res.locals.membership.orgId,
      parsed.data.timeZone,
    );
    if (result.status === 'notEmpty') {
      res.status(409).json({ error: 'This organization already has data' });
      return;
    }
    const { resource, service, windows } = result;
    res.status(201).json({ resource, service, windows });
  },
);
