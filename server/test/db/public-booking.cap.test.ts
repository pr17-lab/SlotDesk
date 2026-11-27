// The daily cap on online bookings: each room takes at most 20 public
// bookings created in any 24 hours. Staff bookings neither count nor are
// blocked, other rooms and other businesses are unaffected, and two
// simultaneous requests at 19 can't both get in.
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
import { newManageToken } from './helpers/booking-data.js';
import { siteverifyPasses, TEST_TOKEN } from './helpers/turnstile-fake.js';

const TRUSTED_ORIGIN = 'http://localhost:3000';
// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'public-cap-pw-15chars';
const CAP = 20;
const ROUNDS = 10;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// Every room is UTC and open all day, every day, with a 30-minute service,
// so every :00 and :30 start in the next 30 days is offered.
const today = () => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};
// The n-th distinct start, all on days 2 to 4, never overlapping.
const start = (n: number) =>
  new Date(today() + 2 * DAY + n * 30 * 60 * 1000).toISOString();

const { app, pool } = await loadAppOnTestDatabase();
// Imported after the app, so its pool is already on the test database.
const { createBooking } = await import('../../src/data/bookings.js');
const { createClient } = requireTestDatabase();

let client: pg.Client;
let alice: TestUser;
let dave: TestUser;
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

async function createRoom(cookie: string, orgId: string): Promise<string> {
  const res = await asOwner(cookie, 'post', `/api/orgs/${orgId}/resources`, {
    name: 'Room',
    timeZone: 'UTC',
  });
  expect(res.status).toBe(201);
  const windows = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    startMinute: 0,
    endMinute: 1440,
  }));
  const hours = await asOwner(
    cookie,
    'put',
    `/api/orgs/${orgId}/resources/${res.body.id}/working-hours`,
    { windows },
  );
  expect(hours.status).toBe(200);
  return res.body.id as string;
}

async function createService(cookie: string, orgId: string): Promise<string> {
  const res = await asOwner(cookie, 'post', `/api/orgs/${orgId}/services`, {
    name: 'Half hour',
    durationMinutes: 30,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const body = (n: number, resourceId = roomA, serviceId = serviceA) => ({
  resourceId,
  serviceId,
  startsAt: start(n),
  customerName: 'Online Customer',
  customerEmail: 'online@example.com',
});

const bookOnline = (slug: string, payload: object) =>
  request(app)
    .post(`/api/public/${slug}/bookings`)
    .set('Origin', TRUSTED_ORIGIN)
    .send({
      turnstileToken: TEST_TOKEN,
      manageToken: newManageToken(),
      ...payload,
    });

const bookAsStaff = (orgId: string, payload: object) =>
  asOwner(alice.cookie, 'post', `/api/orgs/${orgId}/bookings`, payload);

// Inserts `count` bookings on a room directly, at starts first to
// first + count - 1, with the given source and creation time.
async function insertBookings(
  orgId: string,
  resourceId: string,
  serviceId: string,
  count: number,
  options: { source: 'staff' | 'public'; createdAt?: string; first?: number },
): Promise<void> {
  const first = options.first ?? 0;
  for (let n = first; n < first + count; n++) {
    await client.query(
      `INSERT INTO bookings
         (org_id, resource_id, service_id, starts_at, ends_at,
          customer_name, customer_email, source, created_at)
       VALUES ($1, $2, $3, $4, $4::timestamptz + interval '30 minutes',
         'Earlier', 'earlier@example.com', $5, COALESCE($6, now()))`,
      [
        orgId,
        resourceId,
        serviceId,
        start(n),
        options.source,
        options.createdAt ?? null,
      ],
    );
  }
}

const countFor = async (
  resourceId: string,
  source: string,
): Promise<number> => {
  const result = await client.query<{ n: string }>(
    'SELECT count(*) AS n FROM bookings WHERE resource_id = $1 AND source = $2',
    [resourceId, source],
  );
  return Number(result.rows[0]!.n);
};

beforeAll(async () => {
  siteverifyPasses();
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser(app, client, {
    email: 'cap-alice@example.com',
    password: PASSWORD,
    name: 'Alice',
  });
  dave = await createUser(app, client, {
    email: 'cap-dave@example.com',
    password: PASSWORD,
    name: 'Dave',
  });
  orgA = await createOrg(app, alice.cookie, 'Cap Clinic');
  orgB = await createOrg(app, dave.cookie, 'Other Clinic');
  roomA = await createRoom(alice.cookie, orgA);
  roomA2 = await createRoom(alice.cookie, orgA);
  serviceA = await createService(alice.cookie, orgA);
  roomB = await createRoom(dave.cookie, orgB);
  serviceB = await createService(dave.cookie, orgB);
  expect(
    (
      await asOwner(alice.cookie, 'patch', `/api/orgs/${orgA}`, {
        bookingSlug: 'cap-clinic',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await asOwner(dave.cookie, 'patch', `/api/orgs/${orgB}`, {
        bookingSlug: 'other-clinic',
      })
    ).status,
  ).toBe(200);
});

afterEach(async () => {
  await client.query('DELETE FROM bookings');
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('the cap', () => {
  it('takes 20 online bookings for a room through the route, then answers 429', async () => {
    for (let n = 0; n < CAP; n++) {
      expect((await bookOnline('cap-clinic', body(n))).status).toBe(201);
    }
    const res = await bookOnline('cap-clinic', body(CAP));
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'Daily limit reached' });
    expect(await countFor(roomA, 'public')).toBe(CAP);
  });

  it('counts cancelled online bookings too', async () => {
    await insertBookings(orgA, roomA, serviceA, CAP, { source: 'public' });
    await client.query("UPDATE bookings SET status = 'cancelled'");
    expect((await bookOnline('cap-clinic', body(CAP))).status).toBe(429);
  });

  it('does not count staff bookings', async () => {
    await insertBookings(orgA, roomA, serviceA, CAP, { source: 'staff' });
    expect((await bookOnline('cap-clinic', body(CAP))).status).toBe(201);
  });

  it('never blocks a staff booking', async () => {
    await insertBookings(orgA, roomA, serviceA, CAP, { source: 'public' });
    const res = await bookAsStaff(orgA, body(CAP));
    expect(res.status).toBe(201);
    expect(res.body.source).toBe('staff');
  });

  it('leaves another room of the same business open', async () => {
    await insertBookings(orgA, roomA, serviceA, CAP, { source: 'public' });
    expect((await bookOnline('cap-clinic', body(0, roomA2))).status).toBe(201);
  });

  it('leaves another business open', async () => {
    await insertBookings(orgA, roomA, serviceA, CAP, { source: 'public' });
    const res = await bookOnline('other-clinic', body(0, roomB, serviceB));
    expect(res.status).toBe(201);
  });

  it('forgets online bookings created more than 24 hours ago', async () => {
    const yesterday = new Date(Date.now() - DAY - HOUR).toISOString();
    await insertBookings(orgA, roomA, serviceA, CAP, {
      source: 'public',
      createdAt: yesterday,
    });
    expect((await bookOnline('cap-clinic', body(CAP))).status).toBe(201);
  });

  it('still counts one created 23 hours ago', async () => {
    const recent = new Date(Date.now() - 23 * HOUR).toISOString();
    await insertBookings(orgA, roomA, serviceA, CAP, {
      source: 'public',
      createdAt: recent,
    });
    expect((await bookOnline('cap-clinic', body(CAP))).status).toBe(429);
  });
});

// At 19, two online bookings for different free times of the same room
// arrive together. createBooking locks the room's row before it counts, so
// the second waits, counts again after the first commits, and sees 20.
// Without the lock both would count 19 and both would get in.
describe('two requests at the same moment', () => {
  it(`lets exactly one in, over ${ROUNDS} rounds`, async () => {
    const online = {
      latestStart: new Date(Date.now() + 30 * DAY),
      dailyCap: CAP,
    };
    for (let round = 0; round < ROUNDS; round++) {
      await client.query('DELETE FROM bookings');
      await insertBookings(orgA, roomA, serviceA, CAP - 1, {
        source: 'public',
      });
      const results = await Promise.all(
        [CAP, CAP + 1].map((n) =>
          createBooking(
            orgA,
            {
              resourceId: roomA,
              serviceId: serviceA,
              startsAt: start(n),
              customerName: 'Racer',
              customerEmail: 'racer@example.com',
            },
            new Date(),
            online,
          ),
        ),
      );
      expect(results.map((result) => result.status).sort()).toEqual([
        'capReached',
        'created',
      ]);
      expect(await countFor(roomA, 'public')).toBe(CAP);
    }
  });
});
