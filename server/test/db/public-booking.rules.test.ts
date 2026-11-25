// Database rules for online booking: the booking link on organizations and
// the source column on bookings. Each test proves one constraint on a real
// PostgreSQL connection.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  insertOrg,
  insertResource,
  insertService,
} from './helpers/booking-data.js';
import {
  connectAndVerify,
  expectError,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

const { createClient } = requireTestDatabase();

let client: pg.Client;

const setSlug = (orgId: bigint, slug: string | null) =>
  client.query('UPDATE organizations SET booking_slug = $2 WHERE id = $1', [
    orgId,
    slug,
  ]);

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
});

afterEach(async () => {
  await truncateTables(client);
});

afterAll(async () => {
  await client.end();
});

describe('organizations.booking_slug', () => {
  it('is null for a new organization, so its page is off', async () => {
    const orgId = await insertOrg(client, 'Off by default');
    const row = await client.query(
      'SELECT booking_slug FROM organizations WHERE id = $1',
      [orgId],
    );
    expect(row.rows).toEqual([{ booking_slug: null }]);
  });

  it.each(['abc', 'sunrise-physio', 'clinic-2', '9am', 'a'.repeat(40), 'a--b'])(
    'accepts %s',
    async (slug) => {
      const orgId = await insertOrg(client, 'Good slug');
      await setSlug(orgId, slug);
    },
  );

  it.each([
    ['uppercase', 'Sunrise'],
    ['too short', 'ab'],
    ['too long', 'a'.repeat(41)],
    ['a leading hyphen', '-abc'],
    ['a trailing hyphen', 'abc-'],
    ['a space', 'sun rise'],
    ['an underscore', 'sun_rise'],
    ['an empty string', ''],
  ])('refuses %s', async (_label, slug) => {
    const orgId = await insertOrg(client, 'Bad slug');
    const err = await expectError(() => setSlug(orgId, slug));
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('organizations_booking_slug_check');
  });

  it('refuses a slug another organization has', async () => {
    const first = await insertOrg(client, 'First');
    const second = await insertOrg(client, 'Second');
    await setSlug(first, 'shared-name');
    const err = await expectError(() => setSlug(second, 'shared-name'));
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('organizations_booking_slug_key');
  });

  it('allows any number of organizations with no slug', async () => {
    const first = await insertOrg(client, 'First');
    const second = await insertOrg(client, 'Second');
    await setSlug(first, null);
    await setSlug(second, null);
    const row = await client.query<{ n: string }>(
      'SELECT count(*) AS n FROM organizations WHERE booking_slug IS NULL',
    );
    expect(Number(row.rows[0]!.n)).toBe(2);
  });
});

describe('bookings.source', () => {
  let orgId: bigint;
  let resourceId: bigint;
  let serviceId: bigint;

  const insertBooking = (source?: string) =>
    source === undefined
      ? client.query<{ source: string }>(
          `INSERT INTO bookings
             (org_id, resource_id, service_id, starts_at, ends_at,
              customer_name, customer_email)
           VALUES ($1, $2, $3, '2099-01-05T09:00Z', '2099-01-05T10:00Z',
             'Guest', 'guest@example.com')
           RETURNING source`,
          [orgId, resourceId, serviceId],
        )
      : client.query<{ source: string }>(
          `INSERT INTO bookings
             (org_id, resource_id, service_id, starts_at, ends_at,
              customer_name, customer_email, source)
           VALUES ($1, $2, $3, '2099-01-05T09:00Z', '2099-01-05T10:00Z',
             'Guest', 'guest@example.com', $4)
           RETURNING source`,
          [orgId, resourceId, serviceId, source],
        );

  const setUp = async () => {
    orgId = await insertOrg(client, 'Source org');
    resourceId = await insertResource(client, orgId, 'Room');
    serviceId = await insertService(client, orgId, 'Hour');
  };

  it("is 'staff' when not given, as for every booking made before", async () => {
    await setUp();
    const row = await insertBooking();
    expect(row.rows).toEqual([{ source: 'staff' }]);
  });

  it("accepts 'public'", async () => {
    await setUp();
    const row = await insertBooking('public');
    expect(row.rows).toEqual([{ source: 'public' }]);
  });

  it.each(['online', 'Staff', ''])('refuses %j', async (source) => {
    await setUp();
    const err = await expectError(() => insertBooking(source));
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('bookings_source_check');
  });

  it('refuses null', async () => {
    await setUp();
    const err = await expectError(() =>
      client.query(
        `INSERT INTO bookings
           (org_id, resource_id, service_id, starts_at, ends_at,
            customer_name, customer_email, source)
         VALUES ($1, $2, $3, '2099-01-05T09:00Z', '2099-01-05T10:00Z',
           'Guest', 'guest@example.com', NULL)`,
        [orgId, resourceId, serviceId],
      ),
    );
    expect(err.code).toBe('23502');
  });
});
