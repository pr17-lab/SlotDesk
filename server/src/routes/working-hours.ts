import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getResource } from '../data/resources.js';
import type { WorkingWindow } from '../data/working-hours.js';
import {
  listWorkingHours,
  replaceWorkingHours,
} from '../data/working-hours.js';
import { isValidId } from '../ids.js';
import { notFoundHandler, sendValidationError } from '../middleware/errors.js';
import { requireOwner } from '../middleware/role.js';

// Minutes since local midnight: 540 is 09:00, 1440 is the end of the day.
// z.int() refuses 540.5 here, as a 400, before the database can.
const minute = z.int().min(0).max(1440);

// Strict, so a misspelt key is a 400 instead of being quietly dropped.
const windowSchema = z
  .strictObject({
    weekday: z.int().min(1).max(7),
    startMinute: minute,
    endMinute: minute,
  })
  .refine((window) => window.startMinute < window.endMinute, {
    message: 'startMinute must be before endMinute',
  });

// True if two windows on the same weekday overlap. After sorting, a window
// overlaps the previous one if it starts before that one ends. Touching
// windows are fine, like the database's half-open ranges.
function hasOverlap(windows: WorkingWindow[]): boolean {
  const sorted = [...windows].sort(
    (a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute,
  );
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!;
    const next = sorted[i]!;
    if (
      next.weekday === previous.weekday &&
      next.startMinute < previous.endMinute
    ) {
      return true;
    }
  }
  return false;
}

// The database refuses overlaps too, and that stays the real guarantee. We
// check here first so the caller gets a clear 400 instead of a bare 409.
// max(70) is 10 windows a day; an empty array means closed all week.
const replaceWeekSchema = z.strictObject({
  windows: z
    .array(windowSchema)
    .max(70)
    .refine((windows) => !hasOverlap(windows), {
      message: 'Windows on the same weekday must not overlap',
    }),
});

// mergeParams, because :resourceId is in the mount path in resources.ts.
// The organization still comes only from res.locals.membership.
export const workingHoursRouter = Router({ mergeParams: true });

workingHoursRouter.get(
  '/',
  async (req: Request, res: Response): Promise<void> => {
    const resourceId = req.params.resourceId;
    // No point querying for a malformed ID.
    if (!isValidId(resourceId)) {
      notFoundHandler(req, res);
      return;
    }
    const orgId = res.locals.membership.orgId;
    // A 404, so an unknown resource never looks like one with no hours.
    const resource = await getResource(orgId, resourceId);
    if (resource === null) {
      notFoundHandler(req, res);
      return;
    }
    const windows = await listWorkingHours(orgId, resourceId);
    res.status(200).json({ windows });
  },
);

workingHoursRouter.put(
  '/',
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    const resourceId = req.params.resourceId;
    if (!isValidId(resourceId)) {
      notFoundHandler(req, res);
      return;
    }
    // safeParse, because a missing body must be a 400, not a 500.
    const parsed = replaceWeekSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const windows = await replaceWorkingHours(
      res.locals.membership.orgId,
      resourceId,
      parsed.data.windows,
    );
    if (windows === null) {
      notFoundHandler(req, res);
      return;
    }
    res.status(200).json({ windows });
  },
);
