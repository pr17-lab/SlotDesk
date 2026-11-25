import { pool, withTransaction } from '../db.js';
import type { Role } from './memberships.js';

// IDs stay strings: a JavaScript number loses precision above 2^53.
export type OrgWithRole = { id: string; name: string; role: Role };

// The organization and its owner go in together, so an organization never
// exists without an owner.
export async function createOrganizationWithOwner(
  userId: string,
  name: string,
): Promise<OrgWithRole> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string; name: string }>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id, name',
      [name],
    );
    const org = result.rows[0];
    await client.query(
      "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')",
      [org.id, userId],
    );
    return { id: org.id, name: org.name, role: 'owner' };
  });
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

// bookingSlug is the public booking link's name, or null when the page is
// off.
export type Organization = {
  id: string;
  name: string;
  bookingSlug: string | null;
};

export async function getOrganization(
  orgId: string,
): Promise<Organization | null> {
  // Here the organization's ID column is `id`; other tables use `org_id`.
  const result = await pool.query<Organization>(
    'SELECT id, name, booking_slug AS "bookingSlug" FROM organizations WHERE id = $1',
    [orgId],
  );
  return result.rows[0] ?? null;
}

// Sets or clears the booking link. A link another business has fails on the
// unique constraint, which the error handler turns into a 409.
export async function setBookingSlug(
  orgId: string,
  bookingSlug: string | null,
): Promise<Organization | null> {
  const result = await pool.query<Organization>(
    `UPDATE organizations SET booking_slug = $2 WHERE id = $1
     RETURNING id, name, booking_slug AS "bookingSlug"`,
    [orgId, bookingSlug],
  );
  return result.rows[0] ?? null;
}

// The business whose page is on at this link, or null. A turned-off page
// has a null slug, so it's never found.
export async function findOrganizationBySlug(
  bookingSlug: string,
): Promise<{ id: string; name: string } | null> {
  const result = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM organizations WHERE booking_slug = $1',
    [bookingSlug],
  );
  return result.rows[0] ?? null;
}
