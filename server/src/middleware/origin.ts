import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

// Why this exists (D-030): Better Auth's origin check only covers /api/auth,
// so our own routes need their own. SameSite=Lax is per site, not per origin:
// a page on another subdomain of the same site still sends our cookie.
const trustedOrigin = new URL(config.authUrl).origin;

export const requireTrustedOrigin = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (
    req.method === 'GET' ||
    req.method === 'HEAD' ||
    req.method === 'OPTIONS'
  ) {
    next();
    return;
  }
  // Exact match only. A missing header, a literal "null" or any other value
  // is rejected.
  if (req.get('origin') === trustedOrigin) {
    next();
    return;
  }
  res.status(403).json({ error: 'Forbidden' });
};
