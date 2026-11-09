import type { Request, Response, NextFunction } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../auth.js';

declare global {
  // Express's own types declare Locals inside the global Express namespace,
  // so augmenting it needs a namespace block.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      // Set only by requireSession; read it only in routes mounted behind it.
      userId: string;
    }
  }
}

// Errors from getSession are not caught on purpose: Express 5 passes the
// rejected promise to the error handler, which answers 500.
export const requireSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  // disableRefresh (D-030): a server-side auth.api call drops Set-Cookie, so a
  // refresh here would extend the database row without updating the
  // browser's cookie. The refresh happens on /api/auth/get-session instead.
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
