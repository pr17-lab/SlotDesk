import type { Request, Response, NextFunction } from 'express';

// Runs after requireMembership, so the caller is already a member and a 403
// tells them nothing new. Non-members got a 404 before reaching this.
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
