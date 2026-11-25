// The public booking routes under /api/public, through the real app on the
// test database, with no session. Covers the business page, free times with
// the 30-day horizon, booking (201, 400, 409, 403), the identical 404 for an
// unknown, turned-off or malformed link, isolation (one business's link never
// reaches another business's rooms or services) and the bot check, which runs
// before the booking's transaction and never inside it.
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
  observed,
  type TestUser,
} from './helpers/auth-app.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';
import {
  fakeSiteverify,
  siteverifyPasses,
  TEST_TOKEN,
  verifyCalls,
} from './helpers/turnstile-fake.js';
import { logger } from '../../src/logger.js';

const TRUSTED_ORIGIN = 'http://localhost:3000';
// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'public-book-pw-15ch';
const UNKNOWN = '999999';
const DAY = 24 * 60 * 60 * 1000;

// Times relative to today, because the horizon is relative to now. Every
// room here is UTC and open all day, every day, so any :00 start is offered.
const utcDayStart = (daysFromToday: number) => {
  const today = new Date();
  return (
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) +
    daysFromToday * DAY
  );
};
const at10 = (daysFromToday: number) =>
  new Date(utcDayStart(daysFromToday) + 10 * 60 * 60 * 1000).toISOString();
const localDate = (daysFromToday: number) =>
  new Date(utcDayStart(daysFromToday)).toISOString().slice(0, 10);

// Inside the horizon, and far enough ahead never to be in the past.
const SOON = at10(2);
// Day 31 at 10:00 is always more than 30 days from now.
const TOO_FAR = at10(31);

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;
let alice: TestUser; // owner of org A
let dave: TestUser; // owner of org B
let orgA: string;
let orgB: string;
let roomA: string;
let roomA2: string;
let serviceA: string;
let roomB: string;
let serviceB: string;

const asOwner = (
  cookie: string,
  method: 'post' | 'put' | 'patch',
  path: string,
  body: object,
) =>
  request(app)
    [method](path)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie)
    .send(body);

async function createRoom(
  cookie: string,
  orgId: string,
  name: string,
): Promise<string> {
  const res = await asOwner(cookie, 'post', `/api/orgs/${orgId}/resources`, {
    name,
    timeZone: 'UTC',
  });
  expect(res.status).toBe(201);
  const id = res.body.id as string;
  const windows = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    startMinute: 0,
    endMinute: 1440,
  }));
  const hours = await asOwner(
    cookie,
    'put',
    `/api/orgs/${orgId}/resources/${id}/working-hours`,
    { windows },
  );
  expect(hours.status).toBe(200);
  return id;
}

async function createService(cookie: string, orgId: string): Promise<string> {
  const res = await asOwner(cookie, 'post', `/api/orgs/${orgId}/services`, {
    name: 'Half hour',
    durationMinutes: 30,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function setLink(cookie: string, orgId: string, slug: string | null) {
  const res = await asOwner(cookie, 'patch', `/api/orgs/${orgId}`, {
    bookingSlug: slug,
  });
  expect(res.status).toBe(200);
}

const validBody = (extra: Record<string, unknown> = {}) => ({
  resourceId: roomA,
  serviceId: serviceA,
  startsAt: SOON,
  customerName: 'Online Customer',
  customerEmail: 'online@example.com',
  ...extra,
});

// Sends a bot check token unless the body sets its own.
const book = (slug: string, body: object, origin = TRUSTED_ORIGIN) =>
  request(app)
    .post(`/api/public/${slug}/bookings`)
    .set('Origin', origin)
    .send({ turnstileToken: TEST_TOKEN, ...body });

const freeTimes = (slug: string, resourceId: string, query: object) =>
  request(app)
    .get(`/api/public/${slug}/resources/${resourceId}/availability`)
    .query(query);

const staffFreeTimes = (resourceId: string, query: object) =>
  request(app)
    .get(`/api/orgs/${orgA}/resources/${resourceId}/availability`)
    .query(query)
    .set('Cookie', alice.cookie);

const countBookings = async (): Promise<number> => {
  const result = await client.query<{ count: string }>(
    'SELECT count(*) FROM bookings',
  );
  return Number(result.rows[0]!.count);
};

// What an unknown route answers. Every refused link must look like this.
const unknownRoute = async () =>
  observed(await request(app).get('/api/no-such-route'));

beforeAll(async () => {
  siteverifyPasses();
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser(app, client, {
    email: 'public-alice@example.com',
    password: PASSWORD,
    name: 'Alice',
  });
  dave = await createUser(app, client, {
    email: 'public-dave@example.com',
    password: PASSWORD,
    name: 'Dave',
  });
  orgA = await createOrg(app, alice.cookie, 'Sunrise Physio');
  orgB = await createOrg(app, dave.cookie, 'Other Clinic');
  roomA = await createRoom(alice.cookie, orgA, 'Room one');
  roomA2 = await createRoom(alice.cookie, orgA, 'Room two');
  serviceA = await createService(alice.cookie, orgA);
  roomB = await createRoom(dave.cookie, orgB, 'B room');
  serviceB = await createService(dave.cookie, orgB);
  await setLink(alice.cookie, orgA, 'sunrise-physio');
  await setLink(dave.cookie, orgB, 'other-clinic');
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

describe('GET /api/public/:slug', () => {
  it('shows the business, its rooms and its services, and nothing else', async () => {
    const res = await request(app).get('/api/public/sunrise-physio');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: 'Sunrise Physio',
      resources: [
        { id: roomA, name: 'Room one', timeZone: 'UTC' },
        { id: roomA2, name: 'Room two', timeZone: 'UTC' },
      ],
      services: [{ id: serviceA, name: 'Half hour', durationMinutes: 30 }],
      turnstileSiteKey: '1x00000000000000000000AA',
    });
  });

  it('finds the business when the link is typed in capitals', async () => {
    const res = await request(app).get('/api/public/Sunrise-Physio');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Sunrise Physio');
  });

  it('needs no session and no Origin header', async () => {
    const res = await request(app).get('/api/public/other-clinic');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Other Clinic');
  });

  it('answers an unknown link exactly like an unknown route', async () => {
    const res = await request(app).get('/api/public/no-such-business');
    expect(observed(res)).toEqual(await unknownRoute());
  });

  it('answers a turned-off link exactly like an unknown route', async () => {
    const orgC = await createOrg(app, alice.cookie, 'Closed Clinic');
    await setLink(alice.cookie, orgC, 'closed-clinic');
    expect((await request(app).get('/api/public/closed-clinic')).status).toBe(
      200,
    );
    await setLink(alice.cookie, orgC, null);
    const res = await request(app).get('/api/public/closed-clinic');
    expect(observed(res)).toEqual(await unknownRoute());
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(41)],
    ['an underscore', 'sunrise_physio'],
    ['a leading hyphen', '-sunrise'],
    ['an encoded space', 'sun%20rise'],
  ])('refuses a malformed link (%s) before any query', async (_label, slug) => {
    const query = vi.spyOn(pool, 'query');
    const res = await request(app).get(`/api/public/${slug}`);
    expect(observed(res)).toEqual(await unknownRoute());
    expect(query).not.toHaveBeenCalled();
  });

  it('does not reach any staff route', async () => {
    const res = await request(app).get('/api/public/sunrise-physio/bookings');
    expect(observed(res)).toEqual(await unknownRoute());
  });
});

describe('free times', () => {
  const week = () => ({
    serviceId: serviceA,
    from: localDate(1),
    to: localDate(7),
  });

  it('match the staff route inside the horizon', async () => {
    const res = await freeTimes('sunrise-physio', roomA, week());
    const staff = await staffFreeTimes(roomA, week());
    expect(res.status).toBe(200);
    expect(res.body.timeZone).toBe('UTC');
    expect(res.body.slots.length).toBeGreaterThan(0);
    expect(res.body).toEqual(staff.body);
  });

  it('never include a time that is booked', async () => {
    expect((await book('sunrise-physio', validBody())).status).toBe(201);
    const res = await freeTimes('sunrise-physio', roomA, week());
    const starts = res.body.slots.map((slot: { startsAt: string }) =>
      new Date(slot.startsAt).toISOString(),
    );
    expect(starts).not.toContain(SOON);
    expect(Object.keys(res.body).sort()).toEqual(['slots', 'timeZone']);
  });

  it('leave out every start 30 days or more from now', async () => {
    const query = {
      serviceId: serviceA,
      from: localDate(27),
      to: localDate(33),
    };
    const before = Date.now();
    const res = await freeTimes('sunrise-physio', roomA, query);
    const staff = await staffFreeTimes(roomA, query);
    const after = Date.now();
    expect(res.status).toBe(200);

    const publicStarts: number[] = res.body.slots.map(
      (slot: { startsAt: string }) => Date.parse(slot.startsAt),
    );
    const staffStarts: number[] = staff.body.slots.map(
      (slot: { startsAt: string }) => Date.parse(slot.startsAt),
    );
    // Staff still see the later times, so the public list is shorter.
    expect(staffStarts.some((start) => start >= after + 30 * DAY)).toBe(true);
    expect(publicStarts.every((start) => start < after + 30 * DAY)).toBe(true);
    expect(publicStarts).toEqual(
      staffStarts.filter((start) => start < before + 30 * DAY),
    );
  });

  it('are empty for a week entirely past the horizon', async () => {
    const res = await freeTimes('sunrise-physio', roomA, {
      serviceId: serviceA,
      from: localDate(32),
      to: localDate(38),
    });
    expect(res.status).toBe(200);
    expect(res.body.slots).toEqual([]);
  });

  it('keep the staff route query rules', async () => {
    const tooLong = await freeTimes('sunrise-physio', roomA, {
      serviceId: serviceA,
      from: localDate(1),
      to: localDate(15),
    });
    const extraKey = await freeTimes('sunrise-physio', roomA, {
      ...week(),
      orgId: orgB,
    });
    expect(tooLong.status).toBe(400);
    expect(extraKey.status).toBe(400);
  });

  it('answer 404 for an unknown room or service', async () => {
    const room = await freeTimes('sunrise-physio', UNKNOWN, week());
    const malformedRoom = await freeTimes('sunrise-physio', 'abc', week());
    const service = await freeTimes('sunrise-physio', roomA, {
      ...week(),
      serviceId: UNKNOWN,
    });
    for (const res of [room, malformedRoom, service]) {
      expect(observed(res)).toEqual(await unknownRoute());
    }
  });
});

describe('booking', () => {
  it('answers 201 with what was booked, and nothing about the booking row', async () => {
    const res = await book('sunrise-physio', validBody());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      startsAt: SOON,
      endsAt: new Date(Date.parse(SOON) + 30 * 60 * 1000).toISOString(),
      serviceName: 'Half hour',
      resourceName: 'Room one',
      timeZone: 'UTC',
    });
  });

  it("stores the booking in the link's business, marked public", async () => {
    await book(
      'sunrise-physio',
      validBody({
        customerName: '  Online Customer ',
        customerEmail: ' online@example.com ',
      }),
    );
    const rows = await client.query(
      `SELECT org_id, resource_id, service_id, status, source,
         customer_name, customer_email
       FROM bookings`,
    );
    expect(rows.rows).toEqual([
      {
        org_id: orgA,
        resource_id: roomA,
        service_id: serviceA,
        status: 'confirmed',
        source: 'public',
        customer_name: 'Online Customer',
        customer_email: 'online@example.com',
      },
    ]);
  });

  it('shows staff the online booking with its source', async () => {
    await book('sunrise-physio', validBody());
    const list = await request(app)
      .get(`/api/orgs/${orgA}/bookings`)
      .query({ resourceId: roomA, from: localDate(1), to: localDate(7) })
      .set('Cookie', alice.cookie);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].source).toBe('public');
    expect(list.body[0].customerName).toBe('Online Customer');
  });

  it('refuses a time that is not offered', async () => {
    const res = await book(
      'sunrise-physio',
      validBody({ startsAt: SOON.replace(':00:00', ':05:00') }),
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Bad Request',
      details: [
        { path: 'startsAt', message: 'This start time is not offered' },
      ],
    });
    expect(await countBookings()).toBe(0);
  });

  it('refuses a time 30 days or more ahead, which staff can still book', async () => {
    const res = await book('sunrise-physio', validBody({ startsAt: TOO_FAR }));
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { path: 'startsAt', message: 'This start time is not offered' },
    ]);
    expect(await countBookings()).toBe(0);

    const staff = await asOwner(
      alice.cookie,
      'post',
      `/api/orgs/${orgA}/bookings`,
      validBody({ startsAt: TOO_FAR }),
    );
    expect(staff.status).toBe(201);
  });

  it('answers 409 when the time was just taken', async () => {
    expect((await book('sunrise-physio', validBody())).status).toBe(201);
    const again = await book('sunrise-physio', validBody());
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'Conflict' });
    expect(await countBookings()).toBe(1);
  });

  it('answers 409 when staff booked the time first', async () => {
    const staff = await asOwner(
      alice.cookie,
      'post',
      `/api/orgs/${orgA}/bookings`,
      validBody(),
    );
    expect(staff.status).toBe(201);
    expect((await book('sunrise-physio', validBody())).status).toBe(409);
  });

  it.each([
    ['no Origin header', undefined],
    ['another site', 'https://evil.example'],
    ['a look-alike origin', 'http://localhost:3000.evil.example'],
  ])('answers 403 from %s and writes nothing', async (_label, origin) => {
    const req = request(app).post('/api/public/sunrise-physio/bookings');
    if (origin !== undefined) {
      req.set('Origin', origin);
    }
    const res = await req.send(validBody());
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
    expect(await countBookings()).toBe(0);
  });

  it.each([
    ['an unknown link', 'no-such-business'],
    ['a malformed link', 'a_b'],
  ])('answers %s like an unknown route', async (_label, slug) => {
    const res = await book(slug, validBody());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(await countBookings()).toBe(0);
  });

  it('refuses the old link once the owner turns booking off', async () => {
    const orgC = await createOrg(app, alice.cookie, 'Pop-up Clinic');
    const roomC = await createRoom(alice.cookie, orgC, 'Pop-up room');
    const serviceC = await createService(alice.cookie, orgC);
    await setLink(alice.cookie, orgC, 'pop-up-clinic');
    const body = validBody({ resourceId: roomC, serviceId: serviceC });
    expect((await book('pop-up-clinic', body)).status).toBe(201);

    await setLink(alice.cookie, orgC, null);
    const res = await book('pop-up-clinic', {
      ...body,
      startsAt: at10(3),
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(await countBookings()).toBe(1);
  });

  it.each([
    ['an unknown key', { orgId: '1' }, ''],
    ['a missing email', { customerEmail: undefined }, 'customerEmail'],
    ['a bad email', { customerEmail: 'not-an-email' }, 'customerEmail'],
    ['an empty name', { customerName: '  ' }, 'customerName'],
    ['a start without an offset', { startsAt: '2099-01-05T10:00' }, 'startsAt'],
  ])('refuses %s with 400', async (_label, extra, path) => {
    const res = await book('sunrise-physio', validBody(extra));
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe(path);
    expect(await countBookings()).toBe(0);
  });
});

describe("isolation: one business's link never reaches another's", () => {
  // The warn spy tells the two possible 404s apart, as in bookings.test.ts:
  // a lookup scoped to the link's business finds nothing and answers 404
  // itself; an unscoped one would find B's row and fail later on a foreign
  // key, which also answers 404 but logs a warning.
  it.each([
    ["B's room", () => ({ resourceId: roomB })],
    ["B's service", () => ({ serviceId: serviceB })],
    [
      "B's room and B's service",
      () => ({ resourceId: roomB, serviceId: serviceB }),
    ],
  ])("refuses a booking for %s on A's link", async (_label, extra) => {
    const warn = vi.spyOn(logger, 'warn');
    const res = await book('sunrise-physio', validBody(extra()));
    expect(observed(res)).toEqual(await unknownRoute());
    expect(warn).not.toHaveBeenCalled();
    expect(await countBookings()).toBe(0);
  });

  it("refuses free times for B's room or B's service on A's link", async () => {
    const week = { from: localDate(1), to: localDate(7) };
    const bRoom = await freeTimes('sunrise-physio', roomB, {
      ...week,
      serviceId: serviceA,
    });
    const bService = await freeTimes('sunrise-physio', roomA, {
      ...week,
      serviceId: serviceB,
    });
    const bBoth = await freeTimes('sunrise-physio', roomB, {
      ...week,
      serviceId: serviceB,
    });
    for (const res of [bRoom, bService, bBoth]) {
      expect(observed(res)).toEqual(await unknownRoute());
    }
  });

  it("books B's room on B's link, not A's", async () => {
    const res = await book(
      'other-clinic',
      validBody({ resourceId: roomB, serviceId: serviceB }),
    );
    expect(res.status).toBe(201);
    const row = await client.query('SELECT org_id FROM bookings');
    expect(row.rows).toEqual([{ org_id: orgB }]);
  });
});

describe('the bot check', () => {
  // Each test sets its own Cloudflare answer; the rest of the file expects
  // every check to pass.
  afterEach(() => {
    siteverifyPasses();
  });

  const failsWith = (code: string) =>
    fakeSiteverify(async () =>
      Response.json({ success: false, 'error-codes': [code] }),
    );

  it("sends the page's token and our secret before booking", async () => {
    const fake = siteverifyPasses();
    const res = await book(
      'sunrise-physio',
      validBody({ turnstileToken: 'token-from-the-page' }),
    );
    expect(res.status).toBe(201);
    expect(verifyCalls(fake)).toBe(1);
    const sent = fake.mock.calls[0]![1]!.body as URLSearchParams;
    expect(sent.get('response')).toBe('token-from-the-page');
    // The always-pass test secret set in vitest.db.config.ts.
    expect(sent.get('secret')).toBe('1x0000000000000000000000000000000AA');
  });

  it('refuses a failed check with 400 and writes nothing', async () => {
    failsWith('invalid-input-response');
    const res = await book('sunrise-physio', validBody());
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Bad Request',
      details: [
        { path: 'turnstileToken', message: 'Please complete the check again' },
      ],
    });
    expect(await countBookings()).toBe(0);
  });

  it.each([
    ['Cloudflare has an internal error', () => failsWith('internal-error')],
    [
      'Cloudflare cannot be reached',
      () =>
        fakeSiteverify(async () => {
          throw new TypeError('fetch failed');
        }),
    ],
  ])('answers 503 when %s, and writes nothing', async (_label, fake) => {
    fake();
    const res = await book('sunrise-physio', validBody());
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body).toEqual({ error: 'Service Unavailable' });
    expect(await countBookings()).toBe(0);
  });

  it.each([
    ['a missing token', undefined],
    ['an empty token', ''],
    ['a token over 2048 characters', 'x'.repeat(2049)],
  ])('refuses %s with 400 before asking Cloudflare', async (_label, token) => {
    const fake = siteverifyPasses();
    const res = await book(
      'sunrise-physio',
      validBody({ turnstileToken: token }),
    );
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe('turnstileToken');
    expect(verifyCalls(fake)).toBe(0);
    expect(await countBookings()).toBe(0);
  });

  it('accepts a token of exactly 2048 characters', async () => {
    const res = await book(
      'sunrise-physio',
      validBody({ turnstileToken: 'x'.repeat(2048) }),
    );
    expect(res.status).toBe(201);
  });

  it('spends no check on a bad body or an unknown link', async () => {
    const fake = siteverifyPasses();
    const bad = await book(
      'sunrise-physio',
      validBody({ customerEmail: 'not-an-email' }),
    );
    expect(bad.status).toBe(400);
    const unknown = await book('no-such-business', validBody());
    expect(unknown.status).toBe(404);
    expect(verifyCalls(fake)).toBe(0);
  });

  // createBooking locks the room's row. If the check ever ran inside that
  // transaction, one slow Cloudflare answer would hold up every booking for
  // the room, staff ones too.
  it('does not hold up a staff booking on the same room while Cloudflare is slow', async () => {
    let asked!: () => void;
    const askedCloudflare = new Promise<void>((resolve) => (asked = resolve));
    let answer!: () => void;
    const cloudflareAnswers = new Promise<void>(
      (resolve) => (answer = resolve),
    );
    fakeSiteverify(async () => {
      asked();
      await cloudflareAnswers;
      return Response.json({ success: true });
    });

    const online = book('sunrise-physio', validBody()).then((res) => res);
    try {
      await askedCloudflare;
      const staff = asOwner(
        alice.cookie,
        'post',
        `/api/orgs/${orgA}/bookings`,
        validBody({ startsAt: at10(3) }),
      ).then((res) => res.status);
      const tooSlow = new Promise<'still waiting'>((resolve) =>
        setTimeout(() => resolve('still waiting'), 3000),
      );
      expect(await Promise.race([staff, tooSlow])).toBe(201);
    } finally {
      answer();
    }
    expect((await online).status).toBe(201);
    expect(await countBookings()).toBe(2);
  });
});
