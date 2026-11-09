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
