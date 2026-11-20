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

// Minutes since local midnight: 0 is 00:00, 540 is 09:00, 1440 is the end of
// the day. The same range as working_hours_minutes_check. z.int() refuses a
// fraction such as 540.5, which PostgreSQL would refuse for an integer column
// with a 500 instead of a 400.
const minute = z.int().min(0).max(1440);

// Strict, so a misspelt key is a 400 instead of being silently dropped. The
// refine is reported at the window itself (path windows.<index>).
const windowSchema = z
  .strictObject({
    weekday: z.int().min(1).max(7),
    startMinute: minute,
    endMinute: minute,
  })
  .refine((window) => window.startMinute < window.endMinute, {
    message: 'startMinute must be before endMinute',
  });

// True if two windows on the same weekday overlap. Sorted by weekday then
// startMinute, a window overlaps the one before it when it starts before
// that one ends. Touching windows (one ends at 780, the next starts at 780)
// are allowed, matching the database's half-open ranges. Sorts a copy, so
// the caller's array keeps its order.
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

// The database also refuses overlaps (working_hours_no_overlap), and that
// constraint stays the guarantee. The API checks first so the caller gets a
// 400 with a clear message; a database refusal alone would be answered by the
// central error mapping as a 409 with no detail (D-033).
//
// max(70) is 10 windows a day. An empty array is valid: the resource is
// closed all week.
const replaceWeekSchema = z.strictObject({
  windows: z
    .array(windowSchema)
    .max(70)
    .refine((windows) => !hasOverlap(windows), {
      message: 'Windows on the same weekday must not overlap',
    }),
});

// mergeParams is needed here: :resourceId belongs to the mount path in
// resources.ts ('/:resourceId/working-hours'), so without it
// req.params.resourceId would be undefined. The organization still comes
// only from res.locals.membership, never from req.params.
export const workingHoursRouter = Router({ mergeParams: true });

workingHoursRouter.get(
  '/',
  async (req: Request, res: Response): Promise<void> => {
    const resourceId = req.params.resourceId;
    // A malformed ID is a 404 without a database query.
    if (!isValidId(resourceId)) {
      notFoundHandler(req, res);
      return;
    }
    const orgId = res.locals.membership.orgId;
    // An unknown resource is a 404, so it never looks like a resource with
    // no hours.
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
    // safeParse, not parse: req.body is undefined when no JSON body was sent,
    // and that must be a 400, not a 500.
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
