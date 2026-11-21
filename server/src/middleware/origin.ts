import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

// Better Auth's origin check only covers /api/auth, so our routes need their
// own. SameSite=Lax alone isn't enough: a page on another subdomain of the
// same site still sends our cookie (D-030).
const trustedOrigin = new URL(config.authUrl).origin;

// These don't change data, so they skip the check.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const requireTrustedOrigin = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  // Exact match only; a missing header or "null" is refused too.
  if (req.get('origin') === trustedOrigin) {
    next();
    return;
  }
  res.status(403).json({ error: 'Forbidden' });
};
