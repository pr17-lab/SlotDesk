import pg from 'pg';
import { pool } from '../db.js';

export type Role = 'owner' | 'staff';

export async function findMembershipRole(
  orgId: string,
  userId: string,
): Promise<Role | null> {
  const result = await pool.query<{ role: Role }>(
    'SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2',
    [orgId, userId],
  );
  return result.rows[0]?.role ?? null;
}

export type Member = {
  userId: string;
  name: string;
  email: string;
  role: Role;
};

export async function listMembers(orgId: string): Promise<Member[]> {
  // Only these four columns; never anything else from users. The double
  // quotes keep the capital I.
  const result = await pool.query<Member>(
    `SELECT m.user_id AS "userId", u.name, u.email, m.role
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = $1
     ORDER BY m.created_at, m.user_id`,
    [orgId],
  );
  return result.rows;
}

// 23505 is a unique violation. Only the primary key means "already a
// member"; any other constraint is a real error, so we rethrow it.
export function isDuplicateMembership(err: unknown): boolean {
  return (
    err instanceof pg.DatabaseError &&
    err.code === '23505' &&
    err.constraint === 'memberships_pkey'
  );
}

export async function removeStaffMember(
  orgId: string,
  userId: string,
): Promise<'removed' | 'is-owner' | 'not-member'> {
  // AND role = 'staff' is what keeps the owner from ever being removed.
  const result = await pool.query(
    "DELETE FROM memberships WHERE org_id = $1 AND user_id = $2 AND role = 'staff' RETURNING user_id",
    [orgId, userId],
  );
  if (result.rowCount === 1) {
    return 'removed';
  }
  const role = await findMembershipRole(orgId, userId);
  return role === 'owner' ? 'is-owner' : 'not-member';
}
