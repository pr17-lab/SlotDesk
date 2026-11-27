import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  acceptInvitation,
  cancelInvitation,
  createInvitation,
  declineInvitation,
  listInvitations,
  lookupInvitation,
} from '../data/invitations.js';
import { isValidId } from '../ids.js';
import { notFoundHandler, sendValidationError } from '../middleware/errors.js';
import { requireTrustedOrigin } from '../middleware/origin.js';
import { requireOwner } from '../middleware/role.js';
import { requireSession } from '../middleware/session.js';
import { readToken } from '../tokens.js';

// ---- The owner's side, under /api/orgs/:orgId/invitations ----

const createSchema = z.object({ label: z.string().trim().min(1).max(100) });

// No mergeParams: the organization comes from res.locals.membership.
export const orgInvitationsRouter = Router();
orgInvitationsRouter.use(requireOwner);

orgInvitationsRouter.post(
  '/',
  async (req: Request, res: Response): Promise<void> => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const outcome = await createInvitation(
      res.locals.membership.orgId,
      parsed.data.label,
    );
    if (outcome.status === 'limitReached') {
      res.status(409).json({ error: 'Too many pending invitations' });
      return;
    }
    // The only answer that ever carries the secret.
    res.status(201).json({ ...outcome.invitation, token: outcome.token });
  },
);

orgInvitationsRouter.get(
  '/',
  async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json(await listInvitations(res.locals.membership.orgId));
  },
);

orgInvitationsRouter.delete(
  '/:id',
  async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id;
    if (
      !isValidId(id) ||
      !(await cancelInvitation(res.locals.membership.orgId, id))
    ) {
      notFoundHandler(req, res);
      return;
    }
    res.status(204).end();
  },
);

// ---- The invited person's side, under /api/invitations ----
// They aren't a member yet, so there is no membership check: the
// organization comes from the secret, like /api/public's from its link.

export const invitationsRouter = Router();
invitationsRouter.use(requireTrustedOrigin, requireSession);

invitationsRouter.post(
  '/lookup',
  async (req: Request, res: Response): Promise<void> => {
    const token = readToken(req.body);
    const found = token === null ? null : await lookupInvitation(token);
    if (found === null) {
      notFoundHandler(req, res);
      return;
    }
    res.status(200).json(found);
  },
);

invitationsRouter.post(
  '/accept',
  async (req: Request, res: Response): Promise<void> => {
    const token = readToken(req.body);
    if (token === null) {
      notFoundHandler(req, res);
      return;
    }
    const outcome = await acceptInvitation(token, res.locals.userId);
    if (outcome.status === 'notFound') {
      notFoundHandler(req, res);
      return;
    }
    if (outcome.status === 'alreadyMember') {
      res.status(409).json({ error: 'Conflict' });
      return;
    }
    res
      .status(200)
      .json({ orgId: outcome.orgId, orgName: outcome.orgName, role: 'staff' });
  },
);

invitationsRouter.post(
  '/decline',
  async (req: Request, res: Response): Promise<void> => {
    const token = readToken(req.body);
    if (token === null || !(await declineInvitation(token))) {
      notFoundHandler(req, res);
      return;
    }
    res.status(204).end();
  },
);
