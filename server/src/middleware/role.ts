import type { Request, Response, NextFunction } from 'express';

// Runs after requireMembership, so the caller is already a member of this
// organization. A 403 here tells them nothing a member does not already know
// (D-030); non-members never get this far and see the 404 instead.
export const requireOwner = (
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (res.locals.membership.role === 'owner') {
    next();
    return;
  }
  res.status(403).json({ error: 'Forbidden' });
};
