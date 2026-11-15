import { pool } from '../db.js';

// id is a string because it is a bigint; durationMinutes is a number because
// pg returns integer columns as JavaScript numbers.
export type Service = { id: string; name: string; durationMinutes: number };

// Every function here is a single pool.query, not pool.connect(), so the
// D-014 listener rule does not apply: pool.query handles connection errors
// itself.
//
// In each query, the double quotes in "durationMinutes" keep the capital M:
// without them PostgreSQL would return the column as "durationminutes".

export async function createService(
  orgId: string,
  name: string,
  durationMinutes: number,
): Promise<Service> {
  const result = await pool.query<Service>(
    `INSERT INTO services (org_id, name, duration_minutes) VALUES ($1, $2, $3)
     RETURNING id, name, duration_minutes AS "durationMinutes"`,
    [orgId, name, durationMinutes],
  );
  return result.rows[0];
}

export async function listServices(orgId: string): Promise<Service[]> {
  const result = await pool.query<Service>(
    `SELECT id, name, duration_minutes AS "durationMinutes"
     FROM services WHERE org_id = $1 ORDER BY id`,
    [orgId],
  );
  return result.rows;
}

export async function getService(
  orgId: string,
  serviceId: string,
): Promise<Service | null> {
  const result = await pool.query<Service>(
    `SELECT id, name, duration_minutes AS "durationMinutes"
     FROM services WHERE org_id = $1 AND id = $2`,
    [orgId, serviceId],
  );
  return result.rows[0] ?? null;
}

// Changes only the fields given. COALESCE($3, name) returns the first value
// that is not null, so a null parameter (a field that was not given) keeps
// the stored value.
//
// Changing a duration affects only availability offered later. A booking
// stores its own start and end, so existing bookings do not change (Week 3).
export async function updateService(
  orgId: string,
  serviceId: string,
  name: string | undefined,
  durationMinutes: number | undefined,
): Promise<Service | null> {
  const result = await pool.query<Service>(
    `UPDATE services
     SET name = COALESCE($3, name), duration_minutes = COALESCE($4, duration_minutes)
     WHERE org_id = $1 AND id = $2
     RETURNING id, name, duration_minutes AS "durationMinutes"`,
    [orgId, serviceId, name ?? null, durationMinutes ?? null],
  );
  return result.rows[0] ?? null;
}
