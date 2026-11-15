import { pool } from '../db.js';

export type Resource = { id: string; name: string; timeZone: string };

// Every function here is a single pool.query, not pool.connect(), so the
// D-014 listener rule does not apply: pool.query handles connection errors
// itself.
//
// In each query, the double quotes in "timeZone" keep the capital Z: without
// them PostgreSQL would return the column as "timezone".

export async function createResource(
  orgId: string,
  name: string,
  timeZone: string,
): Promise<Resource> {
  const result = await pool.query<Resource>(
    `INSERT INTO resources (org_id, name, time_zone) VALUES ($1, $2, $3)
     RETURNING id, name, time_zone AS "timeZone"`,
    [orgId, name, timeZone],
  );
  return result.rows[0];
}

export async function listResources(orgId: string): Promise<Resource[]> {
  const result = await pool.query<Resource>(
    `SELECT id, name, time_zone AS "timeZone"
     FROM resources WHERE org_id = $1 ORDER BY id`,
    [orgId],
  );
  return result.rows;
}

export async function getResource(
  orgId: string,
  resourceId: string,
): Promise<Resource | null> {
  const result = await pool.query<Resource>(
    `SELECT id, name, time_zone AS "timeZone"
     FROM resources WHERE org_id = $1 AND id = $2`,
    [orgId, resourceId],
  );
  return result.rows[0] ?? null;
}

// Updates only the name: the time zone is fixed at creation (D-032).
export async function renameResource(
  orgId: string,
  resourceId: string,
  name: string,
): Promise<Resource | null> {
  const result = await pool.query<Resource>(
    `UPDATE resources SET name = $3 WHERE org_id = $1 AND id = $2
     RETURNING id, name, time_zone AS "timeZone"`,
    [orgId, resourceId, name],
  );
  return result.rows[0] ?? null;
}
