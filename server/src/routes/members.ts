import { Router } from 'express';
import type { Request, Response } from 'express';
import { listMembers, removeStaffMember } from '../data/memberships.js';
import { notFoundHandler } from '../middleware/errors.js';
import { requireOwner } from '../middleware/role.js';

// Nobody is added here: people join through an invite link they accept
// (invitations.ts). No mergeParams: the organization comes from
// res.locals.membership.
export const membersRouter = Router();

membersRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  // shortcut: no pagination on GET /api/orgs/:orgId/members, add it if organizations can have many members (D-030)
  const members = await listMembers(res.locals.membership.orgId);
  res.status(200).json(members);
});

membersRouter.delete(
  '/:userId',
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    // No format check: Better Auth IDs are just text, and the query is
    // parameterized.
    const userId = req.params.userId;
    if (typeof userId !== 'string') {
      notFoundHandler(req, res);
      return;
    }
    const outcome = await removeStaffMember(
      res.locals.membership.orgId,
      userId,
    );
    if (outcome === 'is-owner') {
      res.status(409).json({ error: 'Conflict' });
      return;
    }
    if (outcome === 'not-member') {
      notFoundHandler(req, res);
      return;
    }
    res.status(204).end();
  },
);
