// Step 10e: listing, viewing and cancelling bookings through the real app on
// the test database (D-033). Covers the session and origin checks (401,
// 403), owner and staff access, the list's local-date range (the resource's
// time zone, `to` included), validation (400), and isolation between
// organizations: another organization's resource or booking gets a 404
// identical to one that does not exist, and is never changed.
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrg,
  createUser,
  loadAppOnTestDatabase,
  type TestUser,
} from './helpers/auth-app.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

const TRUSTED_ORIGIN = 'http://localhost:3000';
// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'bk-manage-pw-15chars';
const UNKNOWN = '999999';
// 2099-01-05 is a Monday. The India resources are open 09:00 to 10:00
// local (03:30Z to 04:30Z), and the service is 30 minutes.
const NINE = '2099-01-05T03:30:00Z';

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;

let alice: TestUser; // owner of org A
let bob: TestUser; // staff of org A
let carol: TestUser; // in no organization
let dave: TestUser; // owner of org B
let orgA: string;
let orgB: string;
let resourceA: string;
let otherResourceA: string;
let serviceA: string;
let resourceB: string;
let serviceB: string;
// Org B's booking in the last isolation cases. Set inside each case,
// because afterEach deletes every booking.
let bookingB: string;

// An India resource (Asia/Kolkata, +05:30, no DST) open Monday 09:00 to
// 10:00.
async function createResource(cookie: string, orgId: string): Promise<string> {
  const res = await request(app)
    .post(`/api/orgs/${orgId}/resources`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie)
    .send({ name: 'Chair', timeZone: 'Asia/Kolkata' });
  expect(res.status).toBe(201);
  const id = res.body.id as string;
  const hours = await request(app)
    .put(`/api/orgs/${orgId}/resources/${id}/working-hours`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie)
    .send({ windows: [{ weekday: 1, startMinute: 540, endMinute: 600 }] });
  expect(hours.status).toBe(200);
  return id;
}

async function createService(cookie: string, orgId: string): Promise<string> {
  const res = await request(app)
    .post(`/api/orgs/${orgId}/services`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie)
    .send({ name: 'Half hour', durationMinutes: 30 });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

// Books 09:00 local on the given organization's resource through the real
// route and returns the 201 body.
async function book(
  cookie: string,
  orgId: string,
  resourceId: string,
  serviceId: string,
): Promise<Record<string, unknown>> {
  const res = await request(app)
    .post(`/api/orgs/${orgId}/bookings`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie)
    .send({
      resourceId,
      serviceId,
      startsAt: NINE,
      customerName: 'Guest Customer',
      customerEmail: 'guest@example.com',
    });
  expect(res.status).toBe(201);
  return res.body as Record<string, unknown>;
}

// A 30-minute booking on org A's resource, inserted directly, so the list
// tests can use start times outside the working hours (the list does not
// look at working hours).
async function insertBooking(
  startsAt: string,
  status: 'confirmed' | 'cancelled' = 'confirmed',
  resourceId = resourceA,
): Promise<void> {
  await client.query(
    `INSERT INTO bookings
       (org_id, resource_id, service_id, starts_at, ends_at, status,
        customer_name, customer_email)
     VALUES ($1, $2, $3, $4, $4::timestamptz + interval '30 minutes', $5,
       'Guest', 'guest@example.com')`,
    [orgA, resourceId, serviceA, startsAt, status],
  );
}

const list = (cookie: string, orgId: string, query: Record<string, string>) =>
  request(app)
    .get(`/api/orgs/${orgId}/bookings`)
    .query(query)
    .set('Cookie', cookie);

const view = (cookie: string, orgId: string, bookingId: string) =>
  request(app)
    .get(`/api/orgs/${orgId}/bookings/${bookingId}`)
    .set('Cookie', cookie);

const cancel = (cookie: string, orgId: string, bookingId: string) =>
  request(app)
    .post(`/api/orgs/${orgId}/bookings/${bookingId}/cancel`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie);

const statusOf = async (bookingId: unknown): Promise<string> => {
  const result = await client.query<{ status: string }>(
    'SELECT status FROM bookings WHERE id = $1',
    [bookingId],
  );
  return result.rows[0]!.status;
};

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser(app, client, {
    email: 'bm-alice@example.com',
    password: PASSWORD,
    name: 'Alice',
  });
  bob = await createUser(app, client, {
    email: 'bm-bob@example.com',
    password: PASSWORD,
    name: 'Bob',
  });
  carol = await createUser(app, client, {
    email: 'bm-carol@example.com',
    password: PASSWORD,
    name: 'Carol',
  });
  dave = await createUser(app, client, {
    email: 'bm-dave@example.com',
    password: PASSWORD,
    name: 'Dave',
  });
  orgA = await createOrg(app, alice.cookie, 'Manage Org A');
  orgB = await createOrg(app, dave.cookie, 'Manage Org B');
  await client.query(
    "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'staff')",
    [orgA, bob.id],
  );
  resourceA = await createResource(alice.cookie, orgA);
  otherResourceA = await createResource(alice.cookie, orgA);
  serviceA = await createService(alice.cookie, orgA);
  resourceB = await createResource(dave.cookie, orgB);
  serviceB = await createService(dave.cookie, orgB);
});

afterEach(async () => {
  await client.query('DELETE FROM bookings');
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('401 and 403', () => {
  it('returns 401 for the list without a cookie', async () => {
    const res = await request(app)
      .get(`/api/orgs/${orgA}/bookings`)
      .query({ resourceId: resourceA, from: '2099-01-05', to: '2099-01-05' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a booking without a cookie', async () => {
    const booking = await book(alice.cookie, orgA, resourceA, serviceA);
    const res = await request(app).get(
      `/api/orgs/${orgA}/bookings/${booking.id}`,
    );
    expect(res.status).toBe(401);
  });

  // Cancel is a POST, so the origin check applies (D-030).
  it('returns 403 for cancel without an Origin header, and cancels nothing', async () => {
    const booking = await book(alice.cookie, orgA, resourceA, serviceA);
    const res = await request(app)
      .post(`/api/orgs/${orgA}/bookings/${booking.id}/cancel`)
      .set('Cookie', alice.cookie);
    expect(res.status).toBe(403);
    expect(await statusOf(booking.id)).toBe('confirmed');
  });
});

describe('listing bookings', () => {
  it('returns each booking as the booking route does, for owner and staff', async () => {
    const booking = await book(alice.cookie, orgA, resourceA, serviceA);
    for (const user of [alice, bob]) {
      const res = await list(user.cookie, orgA, {
        resourceId: resourceA,
        from: '2099-01-05',
        to: '2099-01-05',
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual([booking]);
    }
  });

  // The resource is in India (+05:30), so local 2099-01-05 runs from
  // 2099-01-04T18:30Z to 2099-01-05T18:30Z. Four bookings sit on the two
  // edges of that day. Each case fails if the range is taken in UTC
  // instead of the resource's zone, or if `to` is not included.
  it.each([
    [
      'one local day',
      '2099-01-05',
      '2099-01-05',
      ['2099-01-04T18:30:00.000Z', '2099-01-05T18:00:00.000Z'],
    ],
    [
      'the day before, `to` included',
      '2099-01-04',
      '2099-01-05',
      [
        '2099-01-04T18:00:00.000Z',
        '2099-01-04T18:30:00.000Z',
        '2099-01-05T18:00:00.000Z',
      ],
    ],
    [
      'the day after, `to` included',
      '2099-01-05',
      '2099-01-06',
      [
        '2099-01-04T18:30:00.000Z',
        '2099-01-05T18:00:00.000Z',
        '2099-01-05T18:30:00.000Z',
      ],
    ],
    ['a day with no bookings', '2099-01-07', '2099-01-07', []],
  ])(
    'lists the bookings that start on %s',
    async (_label, from, to, starts) => {
      await insertBooking('2099-01-04T18:00:00Z'); // 23:30 local on the 4th
      await insertBooking('2099-01-04T18:30:00Z'); // 00:00 local on the 5th
      await insertBooking('2099-01-05T18:00:00Z'); // 23:30 local on the 5th
      await insertBooking('2099-01-05T18:30:00Z'); // 00:00 local on the 6th
      const res = await list(alice.cookie, orgA, {
        resourceId: resourceA,
        from,
        to,
      });
      expect(res.status).toBe(200);
      expect(res.body.map((b: { startsAt: string }) => b.startsAt)).toEqual(
        starts,
      );
    },
  );

  // A cancelled booking frees its slot, so a confirmed one can start at the
  // same instant. Both are listed, oldest first, each with its status.
  it('lists cancelled bookings too, in start order', async () => {
    await insertBooking('2099-01-05T06:00:00Z');
    await insertBooking('2099-01-05T04:00:00Z', 'cancelled');
    await insertBooking('2099-01-05T04:00:00Z');
    const res = await list(alice.cookie, orgA, {
      resourceId: resourceA,
      from: '2099-01-05',
      to: '2099-01-05',
    });
    expect(res.status).toBe(200);
    expect(
      res.body.map((b: { startsAt: string; status: string }) => [
        b.startsAt,
        b.status,
      ]),
    ).toEqual([
      ['2099-01-05T04:00:00.000Z', 'cancelled'],
      ['2099-01-05T04:00:00.000Z', 'confirmed'],
      ['2099-01-05T06:00:00.000Z', 'confirmed'],
    ]);
  });

  it('lists only the requested resource', async () => {
    await insertBooking('2099-01-05T04:00:00Z');
    await insertBooking('2099-01-05T05:00:00Z', 'confirmed', otherResourceA);
    const res = await list(alice.cookie, orgA, {
      resourceId: otherResourceA,
      from: '2099-01-05',
      to: '2099-01-05',
    });
    expect(res.status).toBe(200);
    expect(res.body.map((b: { startsAt: string }) => b.startsAt)).toEqual([
      '2099-01-05T05:00:00.000Z',
    ]);
  });

  // 14 days, both included, is the longest range allowed.
  it('accepts a 14-day range', async () => {
    const res = await list(alice.cookie, orgA, {
      resourceId: resourceA,
      from: '2099-01-05',
      to: '2099-01-18',
    });
    expect(res.status).toBe(200);
  });
});

describe('400: the list query', () => {
  const valid = () => ({
    resourceId: resourceA,
    from: '2099-01-05',
    to: '2099-01-05',
  });

  // Each case changes one value; the path and the message name it. The
  // date rules are the availability route's (shared, D-033), so these
  // cases check that the list uses them, not each rule in detail.
  it.each([
    [
      'no resourceId',
      () => ({ from: '2099-01-05', to: '2099-01-05' }),
      'resourceId',
      'Invalid input: expected string, received undefined',
    ],
    [
      'a malformed resourceId',
      () => ({ ...valid(), resourceId: 'abc' }),
      'resourceId',
      'Not a valid id',
    ],
    [
      'an impossible date',
      () => ({ ...valid(), from: '2099-02-30' }),
      'from',
      'Invalid ISO date',
    ],
    [
      'a date in 2100',
      () => ({ ...valid(), to: '2100-01-01' }),
      'to',
      'Date must be between 2000-01-01 and 2099-12-31',
    ],
    [
      'from after to',
      () => ({ ...valid(), from: '2099-01-06' }),
      'to',
      'from must not be after to',
    ],
    [
      'a 15-day range',
      () => ({ ...valid(), to: '2099-01-19' }),
      'to',
      'The range must be at most 14 days',
    ],
    [
      'an unknown key',
      () => ({ ...valid(), status: 'confirmed' }),
      '',
      'Unrecognized key: "status"',
    ],
  ])('refuses %s', async (_label, query, path, message) => {
    const res = await list(alice.cookie, orgA, query());
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Bad Request',
      details: [{ path, message }],
    });
  });
});

describe('viewing a booking', () => {
  it('returns the booking to owner and staff', async () => {
    const booking = await book(alice.cookie, orgA, resourceA, serviceA);
    for (const user of [alice, bob]) {
      const res = await view(user.cookie, orgA, booking.id as string);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(booking);
    }
  });
});

describe('cancelling a booking', () => {
  it('returns the booking with status cancelled and changes nothing else', async () => {
    const booking = await book(alice.cookie, orgA, resourceA, serviceA);
    const res = await cancel(alice.cookie, orgA, booking.id as string);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...booking, status: 'cancelled' });
    expect(await statusOf(booking.id)).toBe('cancelled');
    const viewed = await view(alice.cookie, orgA, booking.id as string);
    expect(viewed.body).toEqual({ ...booking, status: 'cancelled' });
  });

  // Staff run the front desk (D-033 A). This fails if the route requires
  // the owner role.
  it('lets a staff member cancel', async () => {
    const booking = await book(alice.cookie, orgA, resourceA, serviceA);
    const res = await cancel(bob.cookie, orgA, booking.id as string);
    expect(res.status).toBe(200);
    expect(await statusOf(booking.id)).toBe('cancelled');
  });

  // A client that retries after losing the first answer gets the same 200.
  it('returns 200 with the same body when cancelled twice', async () => {
    const booking = await book(alice.cookie, orgA, resourceA, serviceA);
    const first = await cancel(alice.cookie, orgA, booking.id as string);
    const second = await cancel(alice.cookie, orgA, booking.id as string);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  // The constraint covers confirmed bookings only, so cancelling frees the
  // slot for the booking route.
  it('frees the slot for a new booking', async () => {
    const booking = await book(alice.cookie, orgA, resourceA, serviceA);
    expect(
      (await cancel(alice.cookie, orgA, booking.id as string)).status,
    ).toBe(200);
    const again = await book(alice.cookie, orgA, resourceA, serviceA);
    expect(again.id).not.toBe(booking.id);
  });
});

describe('404 and isolation', () => {
  // The membership check answers first (D-030).
  it.each([
    ['a user in no organization', () => carol],
    ['a member of org B', () => dave],
  ])('returns 404 to %s on every org A route', async (_label, user) => {
    const booking = await book(alice.cookie, orgA, resourceA, serviceA);
    const id = booking.id as string;
    const responses = [
      await list(user().cookie, orgA, {
        resourceId: resourceA,
        from: '2099-01-05',
        to: '2099-01-05',
      }),
      await view(user().cookie, orgA, id),
      await cancel(user().cookie, orgA, id),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    }
    expect(await statusOf(id)).toBe('confirmed');
  });

  // Org B's resource looks exactly like one that does not exist. This fails
  // if the resource lookup in the list route loses its org_id filter: org
  // B's resource would then be found and the list would answer 200.
  it.each([
    ['an unknown resource', () => UNKNOWN],
    ["org B's resource", () => resourceB],
  ])('returns 404 when listing %s', async (_label, resourceId) => {
    await book(dave.cookie, orgB, resourceB, serviceB);
    const res = await list(alice.cookie, orgA, {
      resourceId: resourceId(),
      from: '2099-01-05',
      to: '2099-01-05',
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  // Org B has a real booking, so a view or cancel query without its org_id
  // filter would find it (200) instead of answering 404. Malformed IDs get
  // the same 404 without a query.
  it.each([
    ["org B's booking", () => bookingB],
    ['an unknown booking', () => UNKNOWN],
    ['a malformed id', () => 'abc'],
    ['a zero id', () => '0'],
    ['an id with a leading zero', () => '01'],
  ])('returns 404 for %s on view and cancel', async (_label, bookingId) => {
    bookingB = (await book(dave.cookie, orgB, resourceB, serviceB))
      .id as string;
    const viewed = await view(alice.cookie, orgA, bookingId());
    expect(viewed.status).toBe(404);
    expect(viewed.body).toEqual({ error: 'Not found' });
    const cancelled = await cancel(alice.cookie, orgA, bookingId());
    expect(cancelled.status).toBe(404);
    expect(cancelled.body).toEqual({ error: 'Not found' });
    // Org B's booking is untouched.
    expect(await statusOf(bookingB)).toBe('confirmed');
  });
});
