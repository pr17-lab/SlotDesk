import pg from 'pg';

// Test-data helpers shared by the booking test files.

// Insert one organization and return its id.
export async function insertOrg(c: pg.Client, name: string): Promise<bigint> {
  const r = await c.query<{ id: string }>(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    [name],
  );
  return BigInt(r.rows[0]!.id);
}

// Insert one resource under the given org and return its id.
export async function insertResource(
  c: pg.Client,
  oid: bigint,
  name: string,
): Promise<bigint> {
  const r = await c.query<{ id: string }>(
    "INSERT INTO resources (org_id, name, time_zone) VALUES ($1, $2, 'UTC') RETURNING id",
    [oid, name],
  );
  return BigInt(r.rows[0]!.id);
}

// Return a fixed UTC slot for the given round index: one hour long,
// starting `round` hours after `base`, so no two rounds overlap.
// Fixed times (not "now") make failures reproducible.
export function slotFor(
  base: string,
  round: number,
): { startsAt: string; endsAt: string } {
  const startsAt = new Date(new Date(base).getTime() + round * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}
