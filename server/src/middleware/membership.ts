import type { Request, Response, NextFunction } from 'express';
import { findMembershipRole } from '../data/memberships.js';
import type { Role } from '../data/memberships.js';
import { notFoundHandler } from './errors.js';

declare global {
  // Express's own types declare Locals inside the global Express namespace,
  // so augmenting it needs a namespace block.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      // Set only by requireMembership; read it only in routes mounted behind it.
      membership: { orgId: string; role: Role };
    }
  }
}

// Largest value a PostgreSQL bigint can hold.
const MAX_BIGINT = 9223372036854775807n;

// Digits only, no leading zero, and within bigint range, so a malformed ID
// never reaches the database (where it would cause an error and a 500).
function isValidOrgId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]*$/.test(value) &&
    BigInt(value) <= MAX_BIGINT
  );
}

// A non-member gets the same 404 as an unknown route, so they cannot tell
// whether the organization exists (D-030).
export const requireMembership = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const orgId = req.params.orgId;
  if (!isValidOrgId(orgId)) {
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
