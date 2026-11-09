import { pool } from '../db.js';
import type { Role } from './memberships.js';

// IDs stay strings: pg returns bigint as a string, and a JavaScript number
// loses precision above 2^53.
export type OrgWithRole = { id: string; name: string; role: Role };

// The organization and its owner membership are inserted in one transaction,
// so an organization never exists without an owner (D-030).
export async function createOrganizationWithOwner(
  userId: string,
  name: string,
): Promise<OrgWithRole> {
  const client = await pool.connect();
  let discardClient = false;
  // A checked-out client has no 'error' listener (pg-pool removes its own
  // while the client is out), and pg emits 'error' when the connection drops.
  // Without this listener that event would crash the whole process.
  const onError = (): void => {
    discardClient = true;
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string; name: string }>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id, name',
      [name],
    );
    const org = result.rows[0];
    await client.query(
      "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')",
      [org.id, userId],
    );
    await client.query('COMMIT');
    return { id: org.id, name: org.name, role: 'owner' };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discardClient = true;
    }
    throw error;
  } finally {
    client.removeListener('error', onError);
    // A truthy value makes pg-pool destroy the client instead of reusing a
    // connection whose transaction state is unknown.
    client.release(discardClient);
  }
}

export async function listOrganizationsForUser(
  userId: string,
): Promise<OrgWithRole[]> {
  const result = await pool.query<OrgWithRole>(
    `SELECT o.id, o.name, m.role
     FROM memberships m JOIN organizations o ON o.id = m.org_id
     WHERE m.user_id = $1
     ORDER BY o.id`,
    [userId],
  );
  return result.rows;
}

export async function getOrganization(
  orgId: string,
): Promise<{ id: string; name: string } | null> {
  // In the organizations table the organization ID column is `id`; every
  // other tenant table filters on `org_id = $1`.
  const result = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM organizations WHERE id = $1',
    [orgId],
  );
  return result.rows[0] ?? null;
}
