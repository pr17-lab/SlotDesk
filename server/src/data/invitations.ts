import { createHash, randomBytes } from 'node:crypto';
import { pool, withTransaction } from '../db.js';
import { isDuplicateMembership } from './memberships.js';

// At most this many live invitations per organization, so one owner can't
// fill the table.
export const PENDING_LIMIT = 20;

export type Invitation = {
  id: string;
  label: string;
  createdAt: Date;
  expiresAt: Date;
};

// We keep only the SHA-256 of a link's secret. Never log the secret.
function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export type CreateResult =
  | { status: 'created'; invitation: Invitation; token: string }
  | { status: 'limitReached' };

export async function createInvitation(
  orgId: string,
  label: string,
): Promise<CreateResult> {
  return withTransaction(async (client) => {
    // A second create at the same moment waits here until this one commits,
    // so two can't both count 19 and both get in.
    await client.query(
      'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
      [orgId],
    );
    await client.query(
      'DELETE FROM invitations WHERE org_id = $1 AND expires_at <= now()',
      [orgId],
    );
    const pending = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM invitations WHERE org_id = $1',
      [orgId],
    );
    if (pending.rows[0]!.count >= PENDING_LIMIT) {
      return { status: 'limitReached' };
    }
    // 32 random bytes: 43 base64url characters, nothing to guess.
    const token = randomBytes(32).toString('base64url');
    const row = await client.query<Invitation>(
      `INSERT INTO invitations (org_id, label, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '24 hours')
       RETURNING id, label, created_at AS "createdAt", expires_at AS "expiresAt"`,
      [orgId, label, hashToken(token)],
    );
    return { status: 'created', invitation: row.rows[0]!, token };
  });
}

// Live invitations only, newest first. Never the hash.
export async function listInvitations(orgId: string): Promise<Invitation[]> {
  const result = await pool.query<Invitation>(
    `SELECT id, label, created_at AS "createdAt", expires_at AS "expiresAt"
     FROM invitations
     WHERE org_id = $1 AND expires_at > now()
     ORDER BY created_at DESC, id DESC`,
    [orgId],
  );
  return result.rows;
}

// org_id in the WHERE keeps one owner from cancelling another's invitation.
export async function cancelInvitation(
  orgId: string,
  id: string,
): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM invitations WHERE org_id = $1 AND id = $2',
    [orgId, id],
  );
  return result.rowCount === 1;
}

export async function lookupInvitation(
  token: string,
): Promise<{ orgName: string; expiresAt: Date } | null> {
  const result = await pool.query<{ orgName: string; expiresAt: Date }>(
    `SELECT o.name AS "orgName", i.expires_at AS "expiresAt"
     FROM invitations i JOIN organizations o ON o.id = i.org_id
     WHERE i.token_hash = $1 AND i.expires_at > now()`,
    [hashToken(token)],
  );
  return result.rows[0] ?? null;
}

export type AcceptResult =
  | { status: 'accepted'; orgId: string; orgName: string }
  | { status: 'notFound' }
  | { status: 'alreadyMember' };

export async function acceptInvitation(
  token: string,
  userId: string,
): Promise<AcceptResult> {
  try {
    return await withTransaction(async (client) => {
      // Deleting first locks the row: a second accept of the same link waits,
      // then finds it gone. Delete and insert commit together or not at all.
      const used = await client.query<{ org_id: string }>(
        'DELETE FROM invitations WHERE token_hash = $1 AND expires_at > now() RETURNING org_id',
        [hashToken(token)],
      );
      const orgId = used.rows[0]?.org_id;
      if (orgId === undefined) {
        return { status: 'notFound' };
      }
      await client.query(
        "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'staff')",
        [orgId, userId],
      );
      const org = await client.query<{ name: string }>(
        'SELECT name FROM organizations WHERE id = $1',
        [orgId],
      );
      return { status: 'accepted', orgId, orgName: org.rows[0]!.name };
    });
  } catch (err) {
    // Already a member: the rollback puts the invitation back, so the owner
    // can still see and cancel it.
    if (isDuplicateMembership(err)) {
      return { status: 'alreadyMember' };
    }
    throw err;
  }
}

export async function declineInvitation(token: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM invitations WHERE token_hash = $1 AND expires_at > now()',
    [hashToken(token)],
  );
  return result.rowCount === 1;
}
