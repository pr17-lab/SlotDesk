// The booking route through the real app on the test database
// (D-033). Covers the session and origin checks (401, 403), booking by owner
// and staff, the stored row, the overlap rule (409), the start check (400
// "not offered"), validation (400), unknown and malformed IDs (404 and 400),
// and isolation between organizations (404 identical to an unknown one).
import pg from 'pg';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
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
import { logger } from '../../src/logger.js';

const TRUSTED_ORIGIN = 'http://localhost:3000';
// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'bookings-pw-15chars';
const UNKNOWN = '999999';
// 2099-01-05 is a Monday. The India resources are open 09:00 to 10:00
// local (03:30Z to 04:30Z), and the service is 30 minutes, so the offered
// starts are 03:30Z, 03:45Z and 04:00Z.
const NINE = '2099-01-05T03:30:00Z';
const NINE_FIFTEEN = '2099-01-05T03:45:00Z';

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
let serviceA: string;
let resourceB: string;
let serviceB: string;

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

// A booking request for org A's resource and service at 09:00 local, unless
// a field is overridden. Sent as `body` so a case can send anything.
const validBody = (extra: Record<string, unknown> = {}) => ({
  resourceId: resourceA,
  serviceId: serviceA,
  startsAt: NINE,
  customerName: 'Guest Customer',
  customerEmail: 'guest@example.com',
  ...extra,
});

const post = (cookie: string, orgId: string, body: unknown) =>
  request(app)
    .post(`/api/orgs/${orgId}/bookings`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie)
    .send(body as object);

const countBookings = async (): Promise<number> => {
  const result = await client.query<{ count: string }>(
    'SELECT count(*) FROM bookings',
  );
  return Number(result.rows[0]!.count);
};

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser(app, client, {
    email: 'bk-alice@example.com',
    password: PASSWORD,
    name: 'Alice',
  });
  bob = await createUser(app, client, {
    email: 'bk-bob@example.com',
    password: PASSWORD,
    name: 'Bob',
  });
  carol = await createUser(app, client, {
    email: 'bk-carol@example.com',
    password: PASSWORD,
    name: 'Carol',
  });
  dave = await createUser(app, client, {
    email: 'bk-dave@example.com',
    password: PASSWORD,
    name: 'Dave',
  });
  orgA = await createOrg(app, alice.cookie, 'Bookings Org A');
  orgB = await createOrg(app, dave.cookie, 'Bookings Org B');
  await client.query(
    "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'staff')",
    [orgA, bob.id],
  );
  resourceA = await createResource(alice.cookie, orgA);
  serviceA = await createService(alice.cookie, orgA);
  resourceB = await createResource(dave.cookie, orgB);
  serviceB = await createService(dave.cookie, orgB);
});

afterEach(async () => {
  await client.query('DELETE FROM bookings');
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('401 and 403', () => {
  it('returns 401 without a cookie', async () => {
    const res = await request(app)
      .post(`/api/orgs/${orgA}/bookings`)
      .set('Origin', TRUSTED_ORIGIN)
      .send(validBody());
    expect(res.status).toBe(401);
    expect(await countBookings()).toBe(0);
  });

  it('returns 403 without an Origin header', async () => {
    const res = await request(app)
      .post(`/api/orgs/${orgA}/bookings`)
      .set('Cookie', alice.cookie)
      .send(validBody());
    expect(res.status).toBe(403);
    expect(await countBookings()).toBe(0);
  });
});

describe('creating a booking', () => {
  it('returns 201 with the booking for the owner', async () => {
    const res = await post(alice.cookie, orgA, validBody());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      resourceId: resourceA,
      serviceId: serviceA,
      startsAt: '2099-01-05T03:30:00.000Z',
      endsAt: '2099-01-05T04:00:00.000Z',
      status: 'confirmed',
      customerName: 'Guest Customer',
      customerEmail: 'guest@example.com',
      source: 'staff',
      createdAt: expect.any(String),
    });
  });

  // Staff run the front desk (D-033 A). This fails if the route requires the
  // owner role.
  it('returns 201 for a staff member', async () => {
    const res = await post(bob.cookie, orgA, validBody());
    expect(res.status).toBe(201);
  });

  it('stores the row in the organization, with the end set by the server', async () => {
    const res = await post(alice.cookie, orgA, validBody());
    expect(res.status).toBe(201);
    const row = await client.query(
      `SELECT org_id, resource_id, service_id, starts_at, ends_at, status,
         customer_name, customer_email
       FROM bookings WHERE id = $1`,
      [res.body.id],
    );
    expect(row.rows).toEqual([
      {
        org_id: orgA,
        resource_id: resourceA,
        service_id: serviceA,
        starts_at: new Date('2099-01-05T03:30:00Z'),
        ends_at: new Date('2099-01-05T04:00:00Z'),
        status: 'confirmed',
        customer_name: 'Guest Customer',
        customer_email: 'guest@example.com',
      },
    ]);
  });

  // The client may write the instant with any offset; the stored start is
  // the slot's exact instant.
  it('accepts the start written with the local offset', async () => {
    const res = await post(
      alice.cookie,
      orgA,
      validBody({ startsAt: '2099-01-05T09:00:00+05:30' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.startsAt).toBe('2099-01-05T03:30:00.000Z');
  });

  it('trims the name and the email', async () => {
    const res = await post(
      alice.cookie,
      orgA,
      validBody({
        customerName: '  Guest Customer  ',
        customerEmail: '  guest@example.com  ',
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.customerName).toBe('Guest Customer');
    expect(res.body.customerEmail).toBe('guest@example.com');
  });

  // Back-to-back bookings touch but do not overlap (half-open ranges).
  it('books the next slot after a booking ends', async () => {
    expect((await post(alice.cookie, orgA, validBody())).status).toBe(201);
    const next = await post(
      alice.cookie,
      orgA,
      validBody({ startsAt: '2099-01-05T04:00:00Z' }),
    );
    expect(next.status).toBe(201);
  });
});

describe('409: the slot is taken', () => {
  it('refuses the same slot twice', async () => {
    expect((await post(alice.cookie, orgA, validBody())).status).toBe(201);
    const second = await post(bob.cookie, orgA, validBody());
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'Conflict' });
    expect(await countBookings()).toBe(1);
  });

  // 09:15 to 09:45 overlaps 09:00 to 09:30.
  it('refuses a start that overlaps an existing booking', async () => {
    expect((await post(alice.cookie, orgA, validBody())).status).toBe(201);
    const overlap = await post(
      alice.cookie,
      orgA,
      validBody({ startsAt: NINE_FIFTEEN }),
    );
    expect(overlap.status).toBe(409);
    expect(await countBookings()).toBe(1);
  });

  it('allows a slot whose only booking was cancelled', async () => {
    const first = await post(alice.cookie, orgA, validBody());
    expect(first.status).toBe(201);
    await client.query(
      "UPDATE bookings SET status = 'cancelled' WHERE id = $1",
      [first.body.id],
    );
    const again = await post(alice.cookie, orgA, validBody());
    expect(again.status).toBe(201);
  });
});

describe('400: the start is not offered', () => {
  // Each start is a valid instant; only the start check refuses it. The
  // message tells it apart from a malformed start.
  it.each([
    ['an off-grid start (09:05 local)', '2099-01-05T03:35:00Z'],
    // 09:45 to 10:15 runs past the 10:00 end of the hours.
    ['a start that does not fit (09:45 local)', '2099-01-05T04:15:00Z'],
    ['a start before the hours (08:45 local)', '2099-01-05T03:15:00Z'],
    ['a day with no hours (Tuesday)', '2099-01-06T03:30:00Z'],
    // 2020-01-06 is a Monday in the past.
    ['a start in the past', '2020-01-06T03:30:00Z'],
    // Zod accepts this; Temporal cannot read it. This fails, as a 500, if
    // bookableSlot stops catching Temporal's RangeError.
    ['a start with ten fractional digits', '2099-01-05T03:30:00.1234567891Z'],
  ])('refuses %s', async (_label, startsAt) => {
    const res = await post(alice.cookie, orgA, validBody({ startsAt }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Bad Request',
      details: [
        { path: 'startsAt', message: 'This start time is not offered' },
      ],
    });
    expect(await countBookings()).toBe(0);
  });
});

describe('400: validation', () => {
  it('refuses a request with no body', async () => {
    const res = await request(app)
      .post(`/api/orgs/${orgA}/bookings`)
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', alice.cookie);
    expect(res.status).toBe(400);
  });

  // Each case changes one field; the path and the message name it.
  it.each([
    [
      'a start without an offset',
      { startsAt: '2099-01-05T09:00:00' },
      'startsAt',
      'Invalid ISO datetime',
    ],
    [
      'a start that is not a date',
      { startsAt: 'tomorrow' },
      'startsAt',
      'Invalid ISO datetime',
    ],
    [
      'an impossible date',
      { startsAt: '2099-02-30T03:30:00Z' },
      'startsAt',
      'Invalid ISO datetime',
    ],
    // 2100-01-04 is a Monday inside the hours. This fails, as a 201, if the
    // year limit is removed.
    [
      'a start in 2100',
      { startsAt: '2100-01-04T03:30:00Z' },
      'startsAt',
      'Year must be between 2000 and 2099',
    ],
    [
      'a start in 9999',
      { startsAt: '9999-12-27T03:30:00Z' },
      'startsAt',
      'Year must be between 2000 and 2099',
    ],
    [
      'a malformed resourceId',
      { resourceId: 'abc' },
      'resourceId',
      'Not a valid id',
    ],
    [
      'a numeric serviceId',
      { serviceId: 1 },
      'serviceId',
      'Invalid input: expected string, received number',
    ],
    [
      'an empty name after trimming',
      { customerName: '   ' },
      'customerName',
      'Too small: expected string to have >=1 characters',
    ],
    [
      'a 101-character name',
      { customerName: 'a'.repeat(101) },
      'customerName',
      'Too big: expected string to have <=100 characters',
    ],
    [
      'an invalid email',
      { customerEmail: 'not-an-email' },
      'customerEmail',
      'Invalid email address',
    ],
    [
      'a 255-character email',
      { customerEmail: 'a'.repeat(243) + '@example.com' },
      'customerEmail',
      'Too big: expected string to have <=254 characters',
    ],
    ['an unknown key', { orgId: '1' }, '', 'Unrecognized key: "orgId"'],
  ])('refuses %s', async (_label, extra, path, message) => {
    const res = await post(alice.cookie, orgA, validBody(extra));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Bad Request',
      details: [{ path, message }],
    });
    expect(await countBookings()).toBe(0);
  });

  it('accepts a 100-character name and a 254-character email', async () => {
    const res = await post(
      alice.cookie,
      orgA,
      validBody({
        customerName: 'a'.repeat(100),
        customerEmail: 'a'.repeat(242) + '@example.com',
      }),
    );
    expect(res.status).toBe(201);
  });
});

describe('404 and isolation', () => {
  // The membership check answers first: a non-member cannot tell whether
  // the organization exists (D-030).
  it('returns 404 to a user in no organization', async () => {
    const res = await post(carol.cookie, orgA, validBody());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it("returns 404 to a member of org B on org A's URL", async () => {
    const res = await post(dave.cookie, orgA, validBody());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(await countBookings()).toBe(0);
  });

  // Each case is a well-formed ID that is not in org A. The response must be
  // identical whether the ID does not exist or belongs to org B.
  //
  // The warn spy tells the two possible 404s apart. With the org_id filter
  // the lookup finds no row and the route answers 404 itself. Without it the
  // lookup finds org B's row, the INSERT then fails on a composite foreign
  // key (23503), and the error handler also answers 404, but logs a warning.
  // So "no warning" is what fails if a lookup loses its org_id filter.
  it.each([
    ['an unknown resource', () => ({ resourceId: UNKNOWN })],
    ["org B's resource", () => ({ resourceId: resourceB })],
    ['an unknown service', () => ({ serviceId: UNKNOWN })],
    ["org B's service", () => ({ serviceId: serviceB })],
  ])('returns 404 for %s, from the lookup', async (_label, extra) => {
    const warn = vi.spyOn(logger, 'warn');
    const res = await post(alice.cookie, orgA, validBody(extra()));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(warn).not.toHaveBeenCalled();
    expect(await countBookings()).toBe(0);
  });

  // Org B books its own resource at the same time as org A. Different
  // resources, so both succeed.
  it("does not let org A's booking block org B's resource", async () => {
    expect((await post(alice.cookie, orgA, validBody())).status).toBe(201);
    const res = await post(
      dave.cookie,
      orgB,
      validBody({ resourceId: resourceB, serviceId: serviceB }),
    );
    expect(res.status).toBe(201);
  });
});
