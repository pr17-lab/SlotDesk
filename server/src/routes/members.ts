import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  addStaffMemberByEmail,
  listMembers,
  removeStaffMember,
} from '../data/memberships.js';
import { notFoundHandler, sendValidationError } from '../middleware/errors.js';
import { requireOwner } from '../middleware/role.js';

// Trimmed and lowercased before the format check, so '  Alice@Example.COM '
// matches the lowercased email Better Auth stored.
const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
});

// No mergeParams: this router reads the organization only from
// res.locals.membership (set by requireMembership in orgRouter), and its only
// own parameter is :userId.
export const membersRouter = Router();

membersRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  // shortcut: no pagination on GET /api/orgs/:orgId/members, add it if organizations can have many members (D-030)
  const members = await listMembers(res.locals.membership.orgId);
  res.status(200).json(members);
});

membersRouter.post(
  '/',
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    // safeParse, not parse: req.body is undefined when no JSON body was sent,
    // and that must be a 400, not a 500.
    const parsed = addMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const outcome = await addStaffMemberByEmail(
      res.locals.membership.orgId,
      parsed.data.email,
    );
    if (outcome.result === 'unknown-email') {
      notFoundHandler(req, res);
      return;
    }
    if (outcome.result === 'already-member') {
      res.status(409).json({ error: 'Conflict' });
      return;
    }
    res.status(201).json(outcome.member);
  },
);

membersRouter.delete(
  '/:userId',
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    // No format check: Better Auth IDs are opaque text, and the query is
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
