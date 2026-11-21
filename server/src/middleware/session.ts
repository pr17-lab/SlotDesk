import type { Request, Response, NextFunction } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../auth.js';

declare global {
  // Express declares Locals in a global namespace, so adding to it needs one.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      // Set only by requireSession; read it only in routes mounted behind it.
      userId: string;
    }
  }
}

// getSession errors aren't caught on purpose: Express 5 sends them to the
// error handler, which answers 500.
export const requireSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  // disableRefresh: a refresh here would extend the session in the database
  // but never reach the browser's cookie. The browser refreshes through
  // /api/auth/get-session instead (D-030).
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
    query: { disableRefresh: true },
  });
  if (session === null) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.locals.userId = session.user.id;
  next();
};
