import type { Request, Response, NextFunction } from 'express';
import { isValidId } from '../ids.js';
import { findMembershipRole } from '../data/memberships.js';
import type { Role } from '../data/memberships.js';
import { notFoundHandler } from './errors.js';

declare global {
  // Express declares Locals in a global namespace, so adding to it needs one.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      // Set only by requireMembership; read it only in routes mounted behind it.
      membership: { orgId: string; role: Role };
    }
  }
}

// A non-member gets the same 404 as an unknown route, so they can't tell
// whether the organization exists (D-030).
export const requireMembership = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const orgId = req.params.orgId;
  if (!isValidId(orgId)) {
    notFoundHandler(req, res);
    return;
  }
  const role = await findMembershipRole(orgId, res.locals.userId);
  if (role === null) {
    notFoundHandler(req, res);
    return;
  }
  res.locals.membership = { orgId, role };
  next();
};
