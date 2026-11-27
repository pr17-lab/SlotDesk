import { Router } from 'express';
import type { Request, Response } from 'express';
import { cancelByManageToken, findByManageToken } from '../data/bookings.js';
import { notFoundHandler } from '../middleware/errors.js';
import { requireTrustedOrigin } from '../middleware/origin.js';
import { readToken } from '../tokens.js';

// The customer's cancel link, under /api/manage. No session: the secret is
// the proof, like an airline's "manage booking" link. A malformed, unknown
// or started booking's secret gets the same 404 as an unknown route.

export const manageRouter = Router();
manageRouter.use(requireTrustedOrigin);

manageRouter.post(
  '/lookup',
  async (req: Request, res: Response): Promise<void> => {
    const token = readToken(req.body);
    const booking = token === null ? null : await findByManageToken(token);
    if (booking === null) {
      notFoundHandler(req, res);
      return;
    }
    res.status(200).json(booking);
  },
);

manageRouter.post(
  '/cancel',
  async (req: Request, res: Response): Promise<void> => {
    const token = readToken(req.body);
    const outcome = token === null ? null : await cancelByManageToken(token);
    if (outcome === null || outcome.status === 'notFound') {
      notFoundHandler(req, res);
      return;
    }
    // Not a 404: the caller has shown they hold the real link.
    if (outcome.status === 'tooLate') {
      res.status(409).json({ error: 'Too late to cancel online' });
      return;
    }
    res.status(200).json(outcome.booking);
  },
);
