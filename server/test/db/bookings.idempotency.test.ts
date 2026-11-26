// Retrying a booking with an Idempotency-Key, through the real app on the
// test database. Covers the column's rules, the staff and public routes
// (a repeat gets the same booking, different details get 422, a bad key
// gets 400), isolation between businesses, the daily cap, and copies of one
// request sent at the same moment.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
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
import {
  fakeSiteverify,
  siteverifyPasses,
  TEST_TOKEN,
  verifyCalls,
} from './helpers/turnstile-fake.js';

const TRUSTED_ORIGIN = 'http://localhost:3000';
// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'retry-book-pw-15ch';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CAP = 20;
const ROUNDS = 20;

// Times relative to today, because the public horizon is relative to now.
// Every room here is UTC and open all day, so any :00 start is offered.
const utcDayStart = (daysFromToday: number) => {
  const today = new Date();
  return (
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) +
    daysFromToday * DAY
  );
};
const at = (daysFromToday: number, hour: number) =>
  new Date(utcDayStart(daysFromToday) + hour * HOUR).toISOString();
const SOON = at(2, 10);

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();
const { createBooking } = await import('../../src/data/bookings.js');

let client: pg.Client;
let server: Server;
let baseUrl: string;
let alice: TestUser; // owner of org A
let dave: TestUser; // owner of org B
let orgA: string;
let orgB: string;
let roomA: string;
let roomA2: string;
let serviceA: string;
let serviceA2: string;
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

async function createRoom(cookie: string, orgId: string, name: string) {
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

async function createService(
  cookie: string,
  orgId: string,
  durationMinutes: number,
) {
  const res = await asOwner(cookie, 'post', `/api/orgs/${orgId}/services`, {
    name: `${durationMinutes} minutes`,
    durationMinutes,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const validBody = (extra: Record<string, unknown> = {}) => ({
  resourceId: roomA,
  serviceId: serviceA,
  startsAt: SOON,
  customerName: 'Retry Customer',
  customerEmail: 'retry@example.com',
  ...extra,
});

// The header's value as the IETF draft writes it: a quoted string.
const quoted = (key: string) => `"${key}"`;

const asStaff = (
  body: object,
  key?: string,
  orgId = orgA,
  cookie = alice.cookie,
) => {
  const req = request(app)
    .post(`/api/orgs/${orgId}/bookings`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie);
  if (key !== undefined) req.set('Idempotency-Key', key);
  return req.send(body);
};

const online = (body: object, key?: string, slug = 'retry-clinic') => {
  const req = request(app)
    .post(`/api/public/${slug}/bookings`)
    .set('Origin', TRUSTED_ORIGIN);
  if (key !== undefined) req.set('Idempotency-Key', key);
  return req.send({ turnstileToken: TEST_TOKEN, ...body });
};

const countBookings = async (): Promise<number> => {
  const result = await client.query<{ count: string }>(
    'SELECT count(*) FROM bookings',
  );
  return Number(result.rows[0]!.count);
};

// Inserts a booking row straight into the table, for the column's rules.
const insertRow = (
  orgId: string,
  roomId: string,
  serviceId: string,
  key: unknown,
) =>
  client.query(
    `INSERT INTO bookings
       (org_id, resource_id, service_id, starts_at, ends_at, customer_name, customer_email, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'Row', 'row@example.com', $6)`,
    [orgId, roomId, serviceId, at(5, 0), at(5, 1), key],
  );

const KEY_REUSED = { error: 'Idempotency key reused' };
const BAD_KEY = {
  error: 'Bad Request',
  details: [{ path: 'Idempotency-Key', message: 'Must be a quoted UUID' }],
};

beforeAll(async () => {
  siteverifyPasses();
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser(app, client, {
    email: 'retry-alice@example.com',
    password: PASSWORD,
    name: 'Alice',
  });
  dave = await createUser(app, client, {
    email: 'retry-dave@example.com',
    password: PASSWORD,
    name: 'Dave',
  });
  orgA = await createOrg(app, alice.cookie, 'Retry Clinic');
  orgB = await createOrg(app, dave.cookie, 'Retry Other');
  roomA = await createRoom(alice.cookie, orgA, 'Room one');
  roomA2 = await createRoom(alice.cookie, orgA, 'Room two');
  serviceA = await createService(alice.cookie, orgA, 30);
  serviceA2 = await createService(alice.cookie, orgA, 60);
  roomB = await createRoom(dave.cookie, orgB, 'B room');
  serviceB = await createService(dave.cookie, orgB, 30);
  for (const [cookie, orgId, slug] of [
    [alice.cookie, orgA, 'retry-clinic'],
    [dave.cookie, orgB, 'retry-other'],
  ]) {
    const res = await asOwner(cookie!, 'patch', `/api/orgs/${orgId}`, {
      bookingSlug: slug,
    });
    expect(res.status).toBe(200);
  }

  // Port 0 lets the system pick a free port.
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await client.query('DELETE FROM bookings');
  siteverifyPasses();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('bookings.idempotency_key', () => {
  it('is null for a booking made without a key, however many there are', async () => {
    expect((await asStaff(validBody())).status).toBe(201);
    expect((await asStaff(validBody({ startsAt: at(2, 11) }))).status).toBe(
      201,
    );
    const rows = await client.query('SELECT idempotency_key FROM bookings');
    expect(rows.rows).toEqual([
      { idempotency_key: null },
      { idempotency_key: null },
    ]);
  });

  it('refuses the same key twice in one business', async () => {
    const key = randomUUID();
    await insertRow(orgA, roomA, serviceA, key);
    await expect(insertRow(orgA, roomA2, serviceA, key)).rejects.toMatchObject({
      code: '23505',
      constraint: 'bookings_org_idempotency_key_key',
    });
  });

  it('allows the same key in two businesses', async () => {
    const key = randomUUID();
    await insertRow(orgA, roomA, serviceA, key);
    await insertRow(orgB, roomB, serviceB, key);
    expect(await countBookings()).toBe(2);
  });

  it('refuses a value that is not a UUID', async () => {
    await expect(
      insertRow(orgA, roomA, serviceA, 'not-a-uuid'),
    ).rejects.toMatchObject({ code: '22P02' });
  });
});

describe('staff bookings with a key', () => {
  it('answers a repeat with the same booking, and stores one row', async () => {
    const key = randomUUID();
    const first = await asStaff(validBody(), quoted(key));
    const second = await asStaff(validBody(), quoted(key));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    const rows = await client.query('SELECT idempotency_key FROM bookings');
    expect(rows.rows).toEqual([{ idempotency_key: key }]);
  });

  it('still refuses a repeat without a key, as before', async () => {
    expect((await asStaff(validBody())).status).toBe(201);
    expect((await asStaff(validBody())).status).toBe(409);
  });

  it('matches the start as an instant, however it is written', async () => {
    const key = randomUUID();
    const first = await asStaff(validBody(), quoted(key));
    const sameInstant = SOON.replace('T10:00:00.000Z', 'T15:30:00+05:30');
    expect(sameInstant).not.toBe(SOON);
    const second = await asStaff(
      validBody({ startsAt: sameInstant }),
      quoted(key),
    );
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
  });

  it('treats a key in capitals as the same key', async () => {
    const key = randomUUID();
    const first = await asStaff(validBody(), quoted(key));
    const second = await asStaff(validBody(), quoted(key.toUpperCase()));
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(await countBookings()).toBe(1);
  });

  it.each([
    ['room', () => ({ resourceId: roomA2 })],
    ['service', () => ({ serviceId: serviceA2 })],
    ['start', () => ({ startsAt: at(2, 11) })],
    ['name', () => ({ customerName: 'Someone Else' })],
    ['email', () => ({ customerEmail: 'other@example.com' })],
  ])(
    'answers 422 when the %s differs, and books nothing',
    async (_label, change) => {
      const key = randomUUID();
      expect((await asStaff(validBody(), quoted(key))).status).toBe(201);
      const res = await asStaff(validBody(change()), quoted(key));
      expect(res.status).toBe(422);
      expect(res.body).toEqual(KEY_REUSED);
      expect(await countBookings()).toBe(1);
    },
  );

  it.each([
    [
      '400 for a start that is not offered',
      { startsAt: at(2, 10).replace(':00:00', ':07:00') },
      400,
    ],
    ['409 for a taken slot', {}, 409],
  ])(
    'keeps nothing after a %s, so the next try with the key books',
    async (_label, change, status) => {
      if (status === 409) expect((await asStaff(validBody())).status).toBe(201);
      const key = randomUUID();
      expect((await asStaff(validBody(change), quoted(key))).status).toBe(
        status,
      );
      const res = await asStaff(
        validBody({ startsAt: at(2, 12) }),
        quoted(key),
      );
      expect(res.status).toBe(201);
    },
  );

  it.each([
    ['no quotes', () => randomUUID()],
    ['not a UUID', () => quoted('not-a-uuid')],
    ['an empty string', () => quoted('')],
    ['nothing', () => ''],
    ['two keys', () => `${quoted(randomUUID())}, ${quoted(randomUUID())}`],
    ['single quotes', () => `'${randomUUID()}'`],
    ['a very long value', () => quoted('a'.repeat(300))],
  ])(
    'answers 400 for a key with %s, and books nothing',
    async (_label, key) => {
      const res = await asStaff(validBody(), key());
      expect(res.status).toBe(400);
      expect(res.body).toEqual(BAD_KEY);
      expect(await countBookings()).toBe(0);
    },
  );

  it("never finds another business's booking by its key", async () => {
    const key = randomUUID();
    const mine = await asStaff(validBody(), quoted(key));
    const theirs = await asStaff(
      validBody({ resourceId: roomB, serviceId: serviceB }),
      quoted(key),
      orgB,
      dave.cookie,
    );
    expect(theirs.status).toBe(201);
    expect(theirs.body.id).not.toBe(mine.body.id);
    expect(theirs.body.resourceId).toBe(roomB);
    expect(await countBookings()).toBe(2);
  });

  it('answers a repeat after the booking was cancelled with the cancelled booking', async () => {
    const key = randomUUID();
    const first = await asStaff(validBody(), quoted(key));
    const cancel = await asOwner(
      alice.cookie,
      'post',
      `/api/orgs/${orgA}/bookings/${first.body.id}/cancel`,
      {},
    );
    expect(cancel.status).toBe(200);
    const res = await asStaff(validBody(), quoted(key));
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(first.body.id);
    expect(res.body.status).toBe('cancelled');
  });

  it('answers a repeat even once its start has passed', async () => {
    const key = randomUUID();
    const booking = {
      resourceId: roomA,
      serviceId: serviceA,
      startsAt: SOON,
      customerName: 'Retry Customer',
      customerEmail: 'retry@example.com',
    };
    const first = await createBooking(
      orgA,
      { ...booking, idempotencyKey: key },
      new Date(),
    );
    expect(first.status).toBe('created');
    const later = new Date(Date.parse(SOON) + HOUR);
    // Without the key, the same request is refused by then.
    expect((await createBooking(orgA, booking, later)).status).toBe(
      'notOffered',
    );
    const repeat = await createBooking(
      orgA,
      { ...booking, idempotencyKey: key },
      later,
    );
    expect(repeat.status).toBe('created');
    if (first.status === 'created' && repeat.status === 'created') {
      expect(repeat.booking.id).toBe(first.booking.id);
    }
  });
});

describe('online bookings with a key', () => {
  it('answers a repeat with the same answer, and stores one row', async () => {
    const key = randomUUID();
    const first = await online(validBody(), quoted(key));
    const second = await online(validBody(), quoted(key));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    const rows = await client.query('SELECT source FROM bookings');
    expect(rows.rows).toEqual([{ source: 'public' }]);
  });

  it('answers 422 when the details differ', async () => {
    const key = randomUUID();
    expect((await online(validBody(), quoted(key))).status).toBe(201);
    const res = await online(
      validBody({ customerEmail: 'other@example.com' }),
      quoted(key),
    );
    expect(res.status).toBe(422);
    expect(res.body).toEqual(KEY_REUSED);
    expect(await countBookings()).toBe(1);
  });

  it('still needs a passing bot check for a repeat', async () => {
    const key = randomUUID();
    expect((await online(validBody(), quoted(key))).status).toBe(201);
    fakeSiteverify(async () =>
      Response.json({
        success: false,
        'error-codes': ['invalid-input-response'],
      }),
    );
    const res = await online(validBody(), quoted(key));
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe('turnstileToken');
  });

  it('checks the key before the bot check, so a bad key never spends one', async () => {
    const fake = siteverifyPasses();
    const res = await online(validBody(), randomUUID());
    expect(res.status).toBe(400);
    expect(res.body).toEqual(BAD_KEY);
    expect(verifyCalls(fake)).toBe(0);
  });

  it.each([
    ['an online request reuses a staff booking key', asStaff, online],
    ['a staff request reuses an online booking key', online, asStaff],
  ])('answers 422 when %s', async (_label, firstWay, secondWay) => {
    const key = randomUUID();
    expect((await firstWay(validBody(), quoted(key))).status).toBe(201);
    const res = await secondWay(validBody(), quoted(key));
    expect(res.status).toBe(422);
    expect(res.body).toEqual(KEY_REUSED);
  });

  it('answers a repeat once the daily cap is reached, without counting it again', async () => {
    const keys = Array.from({ length: CAP }, () => randomUUID());
    for (const [hour, key] of keys.entries()) {
      const res = await online(
        validBody({ startsAt: at(2, hour) }),
        quoted(key),
      );
      expect(res.status).toBe(201);
    }
    const repeat = await online(
      validBody({ startsAt: at(2, CAP - 1) }),
      quoted(keys[CAP - 1]!),
    );
    expect(repeat.status).toBe(201);
    const next = await online(
      validBody({ startsAt: at(2, CAP) }),
      quoted(randomUUID()),
    );
    expect(next.status).toBe(429);
    expect(await countBookings()).toBe(CAP);
  });
});

// Copies of one request sent at the same moment, through a real port. The
// copies name the same room, so they wait on its lock; the second must then
// find the first one's booking and answer with it.
type Answer = { status: number; body: { id?: string; startsAt?: string } };

async function fireCopies(
  copies: number,
  path: string,
  body: object,
  headers: Record<string, string>,
): Promise<Answer[]> {
  let lastSent = 0;
  let firstAnswered = Infinity;
  const requests = Array.from({ length: copies }, () => {
    lastSent = performance.now();
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: TRUSTED_ORIGIN,
        ...headers,
      },
      body: JSON.stringify(body),
    }).then(async (res) => {
      firstAnswered = Math.min(firstAnswered, performance.now());
      return { status: res.status, body: await res.json() };
    });
  });
  const answers = await Promise.all(requests);
  expect(
    lastSent < firstAnswered,
    'An answer arrived before the last request was sent: the requests did not race',
  ).toBe(true);
  return answers;
}

describe('copies of one request at the same moment', () => {
  it.each([2, 10])(
    `staff: %i copies all get the same booking, over ${ROUNDS} rounds`,
    async (copies) => {
      for (let round = 0; round < ROUNDS; round++) {
        const answers = await fireCopies(
          copies,
          `/api/orgs/${orgA}/bookings`,
          validBody({ startsAt: at(3, round) }),
          { cookie: alice.cookie, 'idempotency-key': quoted(randomUUID()) },
        );
        expect(answers.map((a) => a.status)).toEqual(Array(copies).fill(201));
        expect(new Set(answers.map((a) => a.body.id)).size).toBe(1);
      }
      expect(await countBookings()).toBe(ROUNDS);
    },
  );

  it('online: 2 copies both get the same answer, over 10 rounds', async () => {
    for (let round = 0; round < 10; round++) {
      const answers = await fireCopies(
        2,
        '/api/public/retry-clinic/bookings',
        {
          ...validBody({ startsAt: at(3, round) }),
          turnstileToken: TEST_TOKEN,
        },
        { 'idempotency-key': quoted(randomUUID()) },
      );
      expect(answers.map((a) => a.status)).toEqual([201, 201]);
      expect(answers[1]!.body).toEqual(answers[0]!.body);
    }
    expect(await countBookings()).toBe(10);
  });
});
