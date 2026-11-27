// The cancel link under concurrent requests, through a real port on the test
// database: a customer and staff cancelling one booking at the same moment,
// two customer cancels at once, and two copies of one online booking.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import { siteverifyPasses, TEST_TOKEN } from './helpers/turnstile-fake.js';

const TRUSTED_ORIGIN = 'http://localhost:3000';
// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'cancel-race-pw-15ch';
const ROUNDS = 20;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const utcDayStart = (daysFromToday: number) => {
  const today = new Date();
  return (
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) +
    daysFromToday * DAY
  );
};
const at = (daysFromToday: number, hour: number) =>
  new Date(utcDayStart(daysFromToday) + hour * HOUR).toISOString();

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;
let server: Server;
let baseUrl: string;
let alice: TestUser;
let orgId: string;
let roomId: string;
let serviceId: string;

const newSecret = () => randomBytes(32).toString('base64url');
const sha256 = (secret: string) => createHash('sha256').update(secret).digest();

const asOwner = (
  method: 'post' | 'put' | 'patch',
  path: string,
  body: object,
) =>
  request(app)
    [method](path)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', alice.cookie)
    .send(body);

// A booking row put straight into the table, `hours` from the database's
// now. Each round gets its own hour, so no two rows overlap.
async function insertOnline(hours: number, secret: string): Promise<string> {
  const row = await client.query<{ id: string }>(
    `INSERT INTO bookings
       (org_id, resource_id, service_id, starts_at, ends_at,
        customer_name, customer_email, source, manage_token_hash)
     VALUES ($1, $2, $3, now() + $4::float8 * interval '1 hour',
       now() + $4::float8 * interval '1 hour' + interval '30 minutes',
       'Row', 'row@example.com', 'public', $5)
     RETURNING id`,
    [orgId, roomId, serviceId, hours, sha256(secret)],
  );
  return row.rows[0]!.id;
}

type Answer = { status: number; body: { status?: string } };

// Sends every request in one tick and checks they really overlapped: no
// answer may arrive before the last one is sent.
async function together(
  requests: { path: string; body: object; headers?: Record<string, string> }[],
): Promise<Answer[]> {
  let lastSent = 0;
  let firstAnswered = Infinity;
  const sent = requests.map(({ path, body, headers }) => {
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
  const answers = await Promise.all(sent);
  expect(
    lastSent < firstAnswered,
    'An answer arrived before the last request was sent: the requests did not race',
  ).toBe(true);
  return answers;
}

const customerCancel = (secret: string) => ({
  path: '/api/manage/cancel',
  body: { token: secret },
});
const staffCancel = (bookingId: string) => ({
  path: `/api/orgs/${orgId}/bookings/${bookingId}/cancel`,
  body: {},
  headers: { cookie: alice.cookie },
});

const statusOf = async (bookingId: string) => {
  const row = await client.query<{ status: string }>(
    'SELECT status FROM bookings WHERE id = $1',
    [bookingId],
  );
  return row.rows[0]!.status;
};

beforeAll(async () => {
  siteverifyPasses();
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser(app, client, {
    email: 'cancel-race-alice@example.com',
    password: PASSWORD,
    name: 'Alice',
  });
  orgId = await createOrg(app, alice.cookie, 'Race Clinic');
  const room = await asOwner('post', `/api/orgs/${orgId}/resources`, {
    name: 'Room one',
    timeZone: 'UTC',
  });
  roomId = room.body.id as string;
  const windows = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    startMinute: 0,
    endMinute: 1440,
  }));
  expect(
    (
      await asOwner(
        'put',
        `/api/orgs/${orgId}/resources/${roomId}/working-hours`,
        { windows },
      )
    ).status,
  ).toBe(200);
  const service = await asOwner('post', `/api/orgs/${orgId}/services`, {
    name: 'Half hour',
    durationMinutes: 30,
  });
  serviceId = service.body.id as string;
  expect(
    (
      await asOwner('patch', `/api/orgs/${orgId}`, {
        bookingSlug: 'race-clinic',
      })
    ).status,
  ).toBe(200);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await client.query('DELETE FROM bookings');
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('cancelling one booking from two places at once', () => {
  it(`customer and staff both get 200, over ${ROUNDS} rounds`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const secret = newSecret();
      const id = await insertOnline(48 + round, secret);
      const answers = await together([customerCancel(secret), staffCancel(id)]);
      expect(answers.map((a) => a.status)).toEqual([200, 200]);
      expect(answers.map((a) => a.body.status)).toEqual([
        'cancelled',
        'cancelled',
      ]);
      expect(await statusOf(id)).toBe('cancelled');
    }
  });

  it(`inside the 24 hours: staff 200, the customer 409 or 200, never anything else, over ${ROUNDS} rounds`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const secret = newSecret();
      const id = await insertOnline(1 + round / 2, secret);
      const [customer, staff] = await together([
        customerCancel(secret),
        staffCancel(id),
      ]);
      expect(staff!.status).toBe(200);
      expect([200, 409]).toContain(customer!.status);
      if (customer!.status === 200) {
        expect(customer!.body.status).toBe('cancelled');
      }
      expect(await statusOf(id)).toBe('cancelled');
    }
  });

  it(`two customer cancels both get 200, over ${ROUNDS} rounds`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const secret = newSecret();
      const id = await insertOnline(48 + round, secret);
      const answers = await together([
        customerCancel(secret),
        customerCancel(secret),
      ]);
      expect(answers.map((a) => a.status)).toEqual([200, 200]);
      expect(answers[1]!.body).toEqual(answers[0]!.body);
      expect(await statusOf(id)).toBe('cancelled');
    }
  });
});

describe('two copies of one online booking at once', () => {
  it('store one row, and the one secret works, over 10 rounds', async () => {
    for (let round = 0; round < 10; round++) {
      const secret = newSecret();
      const copy = {
        path: '/api/public/race-clinic/bookings',
        body: {
          resourceId: roomId,
          serviceId,
          startsAt: at(3, round),
          customerName: 'Race Customer',
          customerEmail: 'race@example.com',
          turnstileToken: TEST_TOKEN,
          manageToken: secret,
        },
        headers: { 'idempotency-key': `"${randomUUID()}"` },
      };
      const answers = await together([copy, copy]);
      expect(answers.map((a) => a.status)).toEqual([201, 201]);
      expect(answers[1]!.body).toEqual(answers[0]!.body);
      const looked = await request(app)
        .post('/api/manage/lookup')
        .set('Origin', TRUSTED_ORIGIN)
        .send({ token: secret });
      expect(looked.status).toBe(200);
    }
    const rows = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM bookings',
    );
    expect(rows.rows[0]!.count).toBe(10);
  });
});
