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

type MemberRow = { user_id: string; name: string; email: string; role: Role };

export async function listMembers(orgId: string): Promise<Member[]> {
  // Only these four columns: never select anything else from users.
  const result = await pool.query<MemberRow>(
    `SELECT m.user_id, u.name, u.email, m.role
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = $1
     ORDER BY m.created_at, m.user_id`,
    [orgId],
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
  }));
}

export type AddStaffResult =
  | { result: 'added'; member: Member }
  | { result: 'unknown-email' }
  | { result: 'already-member' };

// pool.query, not pool.connect(): each step is a single statement, the
// primary key settles a race between two adds, and pool.query handles
// connection errors itself (D-014).
export async function addStaffMemberByEmail(
  orgId: string,
  email: string,
): Promise<AddStaffResult> {
  // The email is not lowercased here: the route's Zod schema lowercases it,
  // and Better Auth stores emails lowercased (Verified in better-auth 1.7.18:
  // sign-up.mjs normalizes the email with toLowerCase(), and
  // internal-adapter.mjs lowercases it on create and update).
  const user = await pool.query<{ id: string; name: string; email: string }>(
    'SELECT id, name, email FROM users WHERE email = $1',
    [email],
  );
  const found = user.rows[0];
  if (found === undefined) {
    return { result: 'unknown-email' };
  }
  try {
    await pool.query(
      "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'staff')",
      [orgId, found.id],
    );
  } catch (err) {
    if (isDuplicateMembership(err)) {
      return { result: 'already-member' };
    }
    throw err;
  }
  return {
    result: 'added',
    member: {
      userId: found.id,
      name: found.name,
      email: found.email,
      role: 'staff',
    },
  };
}

// 23505 is PostgreSQL's unique_violation. Only the primary key means
// "already a member"; any other constraint is a real error and is rethrown.
function isDuplicateMembership(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'constraint' in err &&
    err.code === '23505' &&
    err.constraint === 'memberships_pkey'
  );
}

export async function removeStaffMember(
  orgId: string,
  userId: string,
): Promise<'removed' | 'is-owner' | 'not-member'> {
  // AND role = 'staff' is what stops the owner ever being removed: the
  // owner's row never matches this DELETE.
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
