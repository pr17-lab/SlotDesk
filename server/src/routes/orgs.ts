// shortcut: no rate limit on /api/orgs (Better Auth limits only /api/auth), review at Step 7
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createOrganizationWithOwner,
  getOrganization,
  listOrganizationsForUser,
} from '../data/organizations.js';
import { notFoundHandler, sendValidationError } from '../middleware/errors.js';
import { requireMembership } from '../middleware/membership.js';
import { requireTrustedOrigin } from '../middleware/origin.js';
import { requireSession } from '../middleware/session.js';
import { membersRouter } from './members.js';

const createOrgSchema = z.object({ name: z.string().trim().min(1).max(100) });

export const orgsRouter = Router();
orgsRouter.use(requireTrustedOrigin, requireSession);

orgsRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  // safeParse, not parse: req.body is undefined when no JSON body was sent,
  // and that must be a 400, not a 500.
  const parsed = createOrgSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const org = await createOrganizationWithOwner(
    res.locals.userId,
    parsed.data.name,
  );
  res.status(201).json(org);
});

orgsRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  // shortcut: no pagination on GET /api/orgs, add it if a user can belong to many organizations
  const orgs = await listOrganizationsForUser(res.locals.userId);
  res.status(200).json(orgs);
});

// mergeParams: true is needed because requireMembership runs inside orgRouter
// and reads :orgId, which belongs to the parent's mount path. Without it,
// req.params.orgId is undefined here. Step 6c adds /members to this router.
const orgRouter = Router({ mergeParams: true });
orgRouter.use(requireMembership);
orgRouter.use('/members', membersRouter);

orgRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  // The organization comes only from the membership check, never from
  // req.params or the body.
  const { orgId, role } = res.locals.membership;
  const org = await getOrganization(orgId);
  if (org === null) {
    notFoundHandler(req, res);
    return;
  }
  res.status(200).json({ id: org.id, name: org.name, role });
});

orgsRouter.use('/:orgId', orgRouter);
