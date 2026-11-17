// Step 9d: the availability route through the real app on the test database
// (D-032). Covers the session check (401), GET without an Origin, the slots
// for members (owner and staff), the current time, confirmed and cancelled
// bookings, the wide booking search range, validation (400), unknown and
// malformed IDs (404), and isolation between organizations (404 identical to
// an unknown one).
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadAppOnTestDatabase, signUp } from './helpers/auth-app.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

const TRUSTED_ORIGIN = 'http://localhost:3000';
// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'availability-pw-15chars';
const UNKNOWN = '999999';
// 2099-01-05 is a Monday, far enough ahead that "now" does not interfere,
// and still inside the API's 2000 to 2099 limit.
const MONDAY = '2099-01-05';

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;

type TestUser = { id: string; cookie: string };
let alice: TestUser; // owner of org A
let bob: TestUser; // staff of org A
let carol: TestUser; // in no organization
let dave: TestUser; // owner of org B
let orgA: string;
let orgB: string;
let main: string; // org A, Monday 09:00 to 10:00
let empty: string; // org A, no hours
let midnight: string; // org A, Monday 00:00 to 01:00
let serviceA: string; // org A, 30 minutes
let resourceB: string; // org B, Monday 09:00 to 10:00
let serviceB: string; // org B, 30 minutes

// These small helpers now exist in five files (members.test.ts,
// resources.test.ts, services.test.ts, working-hours.test.ts and this one):
// createUser, createOrg and observed. Not shared, because existing test files
// are not refactored.
async function createUser(email: string, name: string): Promise<TestUser> {
  const cookie = await signUp(app, { email, password: PASSWORD, name });
  const row = await client.query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [email],
  );
  return { id: row.rows[0]!.id, cookie };
}

async function createOrg(cookie: string, name: string): Promise<string> {
  const res = await request(app)
    .post('/api/orgs')
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie)
    .send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

// An India resource (Asia/Kolkata, +05:30, no DST) with the given Monday
// window, or no hours when window is null.
async function createResource(
  cookie: string,
  orgId: string,
  name: string,
  window: { startMinute: number; endMinute: number } | null,
): Promise<string> {
  const res = await request(app)
    .post(`/api/orgs/${orgId}/resources`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie)
    .send({ name, timeZone: 'Asia/Kolkata' });
  expect(res.status).toBe(201);
  const id = res.body.id as string;
  if (window !== null) {
    const hours = await request(app)
      .put(`/api/orgs/${orgId}/resources/${id}/working-hours`)
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', cookie)
      .send({ windows: [{ weekday: 1, ...window }] });
    expect(hours.status).toBe(200);
  }
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

// Bookings are inserted directly: there is no booking route until Week 3.
async function insertBooking(
  orgId: string,
  resourceId: string,
  startsAt: string,
  endsAt: string,
  status: 'confirmed' | 'cancelled',
): Promise<void> {
  await client.query(
    `INSERT INTO bookings (org_id, resource_id, starts_at, ends_at, status, customer_name, customer_email)
     VALUES ($1, $2, $3, $4, $5, 'Guest', 'guest@example.com')`,
    [orgId, resourceId, startsAt, endsAt, status],
  );
}

// Status, body and content-type: what a caller can observe.
function observed(res: request.Response) {
  return {
    status: res.status,
    body: res.body as unknown,
    contentType: res.get('content-type'),
  };
}

// A GET with a raw query string, so a case can repeat a key (from=a&from=b).
const getRaw = (
  cookie: string,
  orgId: string,
  resourceId: string,
  query: string,
) =>
  request(app)
    .get(`/api/orgs/${orgId}/resources/${resourceId}/availability?${query}`)
    .set('Cookie', cookie);

// A GET with a valid query unless a value is overridden.
const get = (
  cookie: string,
  orgId: string,
  resourceId: string,
  query: { serviceId?: string; from?: string; to?: string } = {},
) =>
  getRaw(
    cookie,
    orgId,
    resourceId,
    new URLSearchParams({
      serviceId: serviceA,
      from: MONDAY,
      to: MONDAY,
      ...query,
    }).toString(),
  );

const THREE_SLOTS = [
  { startsAt: '2099-01-05T03:30:00Z', endsAt: '2099-01-05T04:00:00Z' },
  { startsAt: '2099-01-05T03:45:00Z', endsAt: '2099-01-05T04:15:00Z' },
  { startsAt: '2099-01-05T04:00:00Z', endsAt: '2099-01-05T04:30:00Z' },
];

const starts = (res: request.Response) =>
  (res.body.slots as Array<{ startsAt: string }>).map((slot) => slot.startsAt);

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser('av-alice@example.com', 'Alice');
  bob = await createUser('av-bob@example.com', 'Bob');
  carol = await createUser('av-carol@example.com', 'Carol');
  dave = await createUser('av-dave@example.com', 'Dave');
  orgA = await createOrg(alice.cookie, 'Availability Org A');
  orgB = await createOrg(dave.cookie, 'Availability Org B');
  await client.query(
    "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'staff')",
    [orgA, bob.id],
  );
  main = await createResource(alice.cookie, orgA, 'Main', {
    startMinute: 540,
    endMinute: 600,
  });
  empty = await createResource(alice.cookie, orgA, 'Empty', null);
  midnight = await createResource(alice.cookie, orgA, 'Midnight', {
    startMinute: 0,
    endMinute: 60,
  });
  serviceA = await createService(alice.cookie, orgA);
  resourceB = await createResource(dave.cookie, orgB, 'Chair B', {
    startMinute: 540,
    endMinute: 600,
  });
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

describe('401 and the origin', () => {
  it('returns 401 without a cookie', async () => {
    const res = await request(app).get(
      `/api/orgs/${orgA}/resources/${main}/availability?serviceId=${serviceA}&from=${MONDAY}&to=${MONDAY}`,
    );
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('works without an Origin header (GET is not checked)', async () => {
    const res = await get(alice.cookie, orgA, main);
    expect(res.status).toBe(200);
  });
});

describe('slots', () => {
  it('returns the time zone and the three Monday slots', async () => {
    const res = await get(alice.cookie, orgA, main);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timeZone: 'Asia/Kolkata', slots: THREE_SLOTS });
  });

  it('returns the same three slots over a whole week', async () => {
    const res = await get(alice.cookie, orgA, main, { to: '2099-01-11' });
    expect(res.status).toBe(200);
    expect(res.body.slots).toEqual(THREE_SLOTS);
  });

  it('returns no slots for a resource with no hours', async () => {
    const res = await get(alice.cookie, orgA, empty);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timeZone: 'Asia/Kolkata', slots: [] });
  });

  // 2020-01-06 is a Monday in the past. This fails if the route ignores the
  // current time.
  it('returns no slots for a past Monday', async () => {
    const res = await get(alice.cookie, orgA, main, {
      from: '2020-01-06',
      to: '2020-01-06',
    });
    expect(res.status).toBe(200);
    expect(res.body.slots).toEqual([]);
  });

  it('gives staff (Bob) the same slots', async () => {
    const res = await get(bob.cookie, orgA, main);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timeZone: 'Asia/Kolkata', slots: THREE_SLOTS });
  });
});

describe('bookings', () => {
  it('a confirmed booking blocks the slots it overlaps', async () => {
    await insertBooking(
      orgA,
      main,
      '2099-01-05T03:30:00Z',
      '2099-01-05T03:45:00Z',
      'confirmed',
    );
    const res = await get(alice.cookie, orgA, main);
    expect(res.status).toBe(200);
    expect(starts(res)).toEqual([
      '2099-01-05T03:45:00Z',
      '2099-01-05T04:00:00Z',
    ]);
  });

  it('a cancelled booking blocks nothing', async () => {
    await insertBooking(
      orgA,
      main,
      '2099-01-05T03:30:00Z',
      '2099-01-05T04:30:00Z',
      'cancelled',
    );
    const res = await get(alice.cookie, orgA, main);
    expect(res.status).toBe(200);
    expect(res.body.slots).toEqual(THREE_SLOTS);
  });

  it('a booking on another resource blocks nothing', async () => {
    await insertBooking(
      orgA,
      empty,
      '2099-01-05T03:30:00Z',
      '2099-01-05T04:30:00Z',
      'confirmed',
    );
    const res = await get(alice.cookie, orgA, main);
    expect(res.status).toBe(200);
    expect(res.body.slots).toEqual(THREE_SLOTS);
  });

  // Local 00:00 to 01:00 on Monday 2099-01-05 is 2099-01-04T18:30Z to 19:30Z.
  // The booking ends before UTC midnight of 2099-01-05, so a search range
  // that started at the requested date in UTC would miss it and offer 18:30Z
  // too.
  it('finds a booking on the UTC day before the requested local date', async () => {
    await insertBooking(
      orgA,
      midnight,
      '2099-01-04T18:00:00Z',
      '2099-01-04T18:45:00Z',
      'confirmed',
    );
    const res = await get(alice.cookie, orgA, midnight);
    expect(res.status).toBe(200);
    expect(starts(res)).toEqual([
      '2099-01-04T18:45:00Z',
      '2099-01-04T19:00:00Z',
    ]);
  });
});

describe('validation (400)', () => {
  const RANGE_MESSAGE = 'Date must be between 2000-01-01 and 2099-12-31';

  // [label, query string builder, path, message]. Every parameter not named
  // is valid. The query is built lazily because serviceA is set in beforeAll.
  const cases: Array<[string, () => string, string, string | undefined]> = [
    ['no query', () => '', 'serviceId', undefined],
    [
      'serviceId=abc',
      () => `serviceId=abc&from=${MONDAY}&to=${MONDAY}`,
      'serviceId',
      'Not a valid id',
    ],
    // The case abort: true exists for: without it the answer is 500.
    [
      'from=2026-02-30',
      () => `serviceId=${serviceA}&from=2026-02-30&to=${MONDAY}`,
      'from',
      'Invalid ISO date',
    ],
    [
      'from after to',
      () => `serviceId=${serviceA}&from=2099-01-06&to=${MONDAY}`,
      'to',
      'from must not be after to',
    ],
    [
      '15 days',
      () => `serviceId=${serviceA}&from=${MONDAY}&to=2099-01-19`,
      'to',
      'The range must be at most 14 days',
    ],
    [
      'from=1999-12-31',
      () => `serviceId=${serviceA}&from=1999-12-31&to=${MONDAY}`,
      'from',
      RANGE_MESSAGE,
    ],
    [
      'to=2100-01-01',
      () => `serviceId=${serviceA}&from=${MONDAY}&to=2100-01-01`,
      'to',
      RANGE_MESSAGE,
    ],
    [
      'a repeated key',
      () => `serviceId=${serviceA}&from=a&from=b&to=${MONDAY}`,
      'from',
      'Invalid input: expected string, received array',
    ],
    [
      'an extra key',
      () => `serviceId=${serviceA}&from=${MONDAY}&to=${MONDAY}&x=1`,
      '',
      'Unrecognized key: "x"',
    ],
  ];

  it.each(cases)('rejects %s', async (_label, query, issuePath, message) => {
    const res = await getRaw(alice.cookie, orgA, main, query());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.details[0].path).toBe(issuePath);
    if (message !== undefined) {
      expect(res.body.details[0].message).toBe(message);
    }
  });
});

describe('limits accepted (200)', () => {
  // The edge dates prove the booking search range reaches PostgreSQL
  // without an error.
  it.each([
    ['exactly 14 days', MONDAY, '2099-01-18'],
    ['the first allowed date', '2000-01-01', '2000-01-01'],
    ['the last allowed date', '2099-12-31', '2099-12-31'],
  ])('accepts %s', async (_label, from, to) => {
    const res = await get(alice.cookie, orgA, main, { from, to });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.slots)).toBe(true);
  });
});

describe('404: unknown and malformed IDs', () => {
  it.each([UNKNOWN, '0', '01', 'abc', '1.5', '9223372036854775808', '-1'])(
    'returns 404 for the resource ID %s',
    async (id) => {
      const res = await get(alice.cookie, orgA, id);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    },
  );

  it('returns 404 for an unknown serviceId', async () => {
    const res = await get(alice.cookie, orgA, main, { serviceId: UNKNOWN });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});

describe('isolation (D-030)', () => {
  // Dave (a member of B only) and Carol (a member of nothing) must see on
  // organization A exactly what they see on an organization that does not
  // exist.
  it.each([
    ['dave', () => dave],
    ['carol', () => carol],
  ])('%s on A gets the unknown-organization 404', async (_n, who) => {
    const user = who();
    const unknown = observed(await get(user.cookie, UNKNOWN, main));
    const onA = observed(await get(user.cookie, orgA, main));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'Not found' });
    expect(onA).toEqual(unknown);
  });

  // The D-030 failure scenario: a valid member of B uses B's URL with A's
  // resource ID. Without the org_id filter this would show A's free times.
  it("dave on B's URL with A's resource gets the same 404 as a nonexistent resource", async () => {
    const other = observed(
      await get(dave.cookie, orgB, main, { serviceId: serviceB }),
    );
    const missing = observed(
      await get(dave.cookie, orgB, UNKNOWN, { serviceId: serviceB }),
    );
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Not found' });
    expect(other).toEqual(missing);
  });

  // The same scenario for the service: B's resource with A's service ID.
  it("dave on B's URL with A's service gets the same 404 as a nonexistent service", async () => {
    const other = observed(
      await get(dave.cookie, orgB, resourceB, { serviceId: serviceA }),
    );
    const missing = observed(
      await get(dave.cookie, orgB, resourceB, { serviceId: UNKNOWN }),
    );
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Not found' });
    expect(other).toEqual(missing);
  });

  it("dave gets B's own slots (the isolation 404s are not just a broken route)", async () => {
    const res = await get(dave.cookie, orgB, resourceB, {
      serviceId: serviceB,
    });
    expect(res.status).toBe(200);
    expect(res.body.slots).toHaveLength(3);
  });
});
