// The customer's cancel link, through the real app on the test database. The
// page sends a secret with each online booking; we store only its SHA-256.
// Whoever holds the secret can look the booking up until it starts, and
// cancel it until 24 hours before. Covers what is stored, repeats, the
// column's rules, lookup, cancel, the cut-off, the one 404 for every link
// that doesn't work, and the origin check.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  siteverifyPasses,
  TEST_TOKEN,
  verifyCalls,
} from './helpers/turnstile-fake.js';

const TRUSTED_ORIGIN = 'http://localhost:3000';
// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'cancel-link-pw-15ch';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Times relative to today, because the public horizon is relative to now.
// The room is UTC and open all day, so any :00 start is offered.
const utcDayStart = (daysFromToday: number) => {
  const today = new Date();
  return (
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) +
    daysFromToday * DAY
  );
};
const at = (daysFromToday: number, hour: number) =>
  new Date(utcDayStart(daysFromToday) + hour * HOUR).toISOString();
const plus = (iso: string, ms: number) =>
  new Date(Date.parse(iso) + ms).toISOString();
// Three days ahead: well past the 24-hour cut-off.
const SOON = at(3, 10);

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;
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

const validBody = (extra: Record<string, unknown> = {}) => ({
  resourceId: roomId,
  serviceId,
  startsAt: SOON,
  customerName: 'Online Customer',
  customerEmail: 'online@example.com',
  ...extra,
});

const bookOnline = (body: object, key = randomUUID()) =>
  request(app)
    .post('/api/public/cancel-clinic/bookings')
    .set('Origin', TRUSTED_ORIGIN)
    .set('Idempotency-Key', `"${key}"`)
    .send({ turnstileToken: TEST_TOKEN, ...body });

const bookAsStaff = (body: object) =>
  asOwner('post', `/api/orgs/${orgId}/bookings`, body);

const manage = (
  action: 'lookup' | 'cancel',
  body: unknown,
  origin: string | null = TRUSTED_ORIGIN,
) => {
  const req = request(app).post(`/api/manage/${action}`);
  if (origin !== null) req.set('Origin', origin);
  return req.send(body as object);
};
const lookup = (token: string) => manage('lookup', { token });
const cancel = (token: string) => manage('cancel', { token });

const staffCancel = (bookingId: string) =>
  asOwner('post', `/api/orgs/${orgId}/bookings/${bookingId}/cancel`, {});

// An online booking row put straight into the table, starting `hours` from
// the database's now. For times the public page won't take: inside the
// 24 hours, or already started.
async function insertOnline(
  hours: number,
  secret: string,
  status = 'confirmed',
): Promise<string> {
  const row = await client.query<{ id: string }>(
    `INSERT INTO bookings
       (org_id, resource_id, service_id, starts_at, ends_at, status,
        customer_name, customer_email, source, manage_token_hash)
     VALUES ($1, $2, $3, now() + $4::float8 * interval '1 hour',
       now() + $4::float8 * interval '1 hour' + interval '30 minutes', $5,
       'Row', 'row@example.com', 'public', $6)
     RETURNING id`,
    [orgId, roomId, serviceId, hours, status, sha256(secret)],
  );
  return row.rows[0]!.id;
}

const statusOf = async (bookingId: string) => {
  const row = await client.query<{ status: string }>(
    'SELECT status FROM bookings WHERE id = $1',
    [bookingId],
  );
  return row.rows[0]!.status;
};

const countBookings = async (): Promise<number> => {
  const result = await client.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM bookings',
  );
  return result.rows[0]!.count;
};

// What lookup and cancel answer for the booking made by validBody().
const soonAnswer = (status: 'confirmed' | 'cancelled') => ({
  businessName: 'Cancel Clinic',
  serviceName: 'Half hour',
  resourceName: 'Room one',
  startsAt: SOON,
  endsAt: plus(SOON, 30 * 60 * 1000),
  timeZone: 'UTC',
  status,
  cancelBefore: plus(SOON, -DAY),
});

const TOO_LATE = { error: 'Too late to cancel online' };

// What an unknown route answers. Every link that doesn't work must look like
// this.
const unknownRoute = async () =>
  observed(await request(app).get('/api/no-such-route'));

beforeAll(async () => {
  siteverifyPasses();
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser(app, client, {
    email: 'cancel-alice@example.com',
    password: PASSWORD,
    name: 'Alice',
  });
  orgId = await createOrg(app, alice.cookie, 'Cancel Clinic');
  const room = await asOwner('post', `/api/orgs/${orgId}/resources`, {
    name: 'Room one',
    timeZone: 'UTC',
  });
  expect(room.status).toBe(201);
  roomId = room.body.id as string;
  const windows = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    startMinute: 0,
    endMinute: 1440,
  }));
  const hours = await asOwner(
    'put',
    `/api/orgs/${orgId}/resources/${roomId}/working-hours`,
    { windows },
  );
  expect(hours.status).toBe(200);
  const service = await asOwner('post', `/api/orgs/${orgId}/services`, {
    name: 'Half hour',
    durationMinutes: 30,
  });
  expect(service.status).toBe(201);
  serviceId = service.body.id as string;
  const link = await asOwner('patch', `/api/orgs/${orgId}`, {
    bookingSlug: 'cancel-clinic',
  });
  expect(link.status).toBe(200);
});

afterEach(async () => {
  await client.query('DELETE FROM bookings');
  vi.restoreAllMocks();
  siteverifyPasses();
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('booking online with a cancel secret', () => {
  it.each([
    ['missing', undefined],
    ['42 characters', 'a'.repeat(42)],
    ['44 characters', 'a'.repeat(44)],
    ['not base64url', `${'a'.repeat(42)}+`],
    ['padded', `${'a'.repeat(42)}=`],
    ['not a string', 12345],
  ])(
    'refuses a %s secret with 400, before the bot check',
    async (_label, manageToken) => {
      const fake = siteverifyPasses();
      const res = await bookOnline(validBody({ manageToken }));
      expect(res.status).toBe(400);
      expect(res.body.details[0].path).toBe('manageToken');
      expect(verifyCalls(fake)).toBe(0);
      expect(await countBookings()).toBe(0);
    },
  );

  it('stores only the SHA-256 of the secret and never answers with it', async () => {
    const secret = newSecret();
    const res = await bookOnline(validBody({ manageToken: secret }));
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual([
      'endsAt',
      'resourceName',
      'serviceName',
      'startsAt',
      'timeZone',
    ]);

    const row = await client.query<{ hash: Buffer; json: string }>(
      'SELECT manage_token_hash AS hash, row_to_json(b)::text AS json FROM bookings b',
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.hash.equals(sha256(secret))).toBe(true);
    expect(row.rows[0]!.json).not.toContain(secret);

    const list = await request(app)
      .get(`/api/orgs/${orgId}/bookings`)
      .query({
        resourceId: roomId,
        from: SOON.slice(0, 10),
        to: SOON.slice(0, 10),
      })
      .set('Cookie', alice.cookie);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    const text = JSON.stringify(list.body);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(sha256(secret).toString('hex'));
    expect(text).not.toContain(sha256(secret).toString('base64'));
    expect(list.body[0]).not.toHaveProperty('manageTokenHash');
  });

  it('gives staff bookings no hash, and refuses a secret from staff', async () => {
    expect((await bookAsStaff(validBody())).status).toBe(201);
    const rows = await client.query('SELECT manage_token_hash FROM bookings');
    expect(rows.rows).toEqual([{ manage_token_hash: null }]);

    const res = await bookAsStaff(
      validBody({ startsAt: at(3, 11), manageToken: newSecret() }),
    );
    expect(res.status).toBe(400);
    expect(await countBookings()).toBe(1);
  });

  it('answers a repeat with the same key and secret with the same booking', async () => {
    const key = randomUUID();
    const secret = newSecret();
    const first = await bookOnline(validBody({ manageToken: secret }), key);
    const second = await bookOnline(validBody({ manageToken: secret }), key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(await countBookings()).toBe(1);
    expect((await lookup(secret)).status).toBe(200);
  });

  it('answers 422 to the same key with a different secret, and keeps the first', async () => {
    const key = randomUUID();
    const secret = newSecret();
    expect(
      (await bookOnline(validBody({ manageToken: secret }), key)).status,
    ).toBe(201);
    const other = newSecret();
    const res = await bookOnline(validBody({ manageToken: other }), key);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'Idempotency key reused' });
    expect(await countBookings()).toBe(1);
    expect((await lookup(secret)).status).toBe(200);
    expect((await lookup(other)).status).toBe(404);
  });

  it('answers 409 to a second booking with a secret already in use', async () => {
    const secret = newSecret();
    expect((await bookOnline(validBody({ manageToken: secret }))).status).toBe(
      201,
    );
    const res = await bookOnline(
      validBody({ startsAt: at(3, 12), manageToken: secret }),
    );
    expect(res.status).toBe(409);
    expect(await countBookings()).toBe(1);
  });
});

describe('POST /api/manage/lookup', () => {
  it('shows when and what, and nothing about who, without a session', async () => {
    const secret = newSecret();
    expect((await bookOnline(validBody({ manageToken: secret }))).status).toBe(
      201,
    );
    const res = await lookup(secret);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(soonAnswer('confirmed'));
  });

  it('still works inside the last 24 hours', async () => {
    const secret = newSecret();
    await insertOnline(23, secret);
    const res = await lookup(secret);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('confirmed');
    expect(Date.parse(res.body.cancelBefore)).toBe(
      Date.parse(res.body.startsAt) - DAY,
    );
  });
});

describe('POST /api/manage/cancel', () => {
  it('cancels, frees the time, and answers the same on a second try', async () => {
    const secret = newSecret();
    expect((await bookOnline(validBody({ manageToken: secret }))).status).toBe(
      201,
    );

    const first = await cancel(secret);
    expect(first.status).toBe(200);
    expect(first.body).toEqual(soonAnswer('cancelled'));
    const rows = await client.query('SELECT status FROM bookings');
    expect(rows.rows).toEqual([{ status: 'cancelled' }]);

    const free = await request(app)
      .get(`/api/public/cancel-clinic/resources/${roomId}/availability`)
      .query({
        serviceId,
        from: SOON.slice(0, 10),
        to: SOON.slice(0, 10),
      });
    expect(free.status).toBe(200);
    // Compared as instants: free times are written without milliseconds.
    expect(
      free.body.slots.map((s: { startsAt: string }) => Date.parse(s.startsAt)),
    ).toContain(Date.parse(SOON));

    const second = await cancel(secret);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(soonAnswer('cancelled'));
    expect((await lookup(secret)).body).toEqual(soonAnswer('cancelled'));
  });

  it('answers 409 inside the last 24 hours and changes nothing', async () => {
    const secret = newSecret();
    const id = await insertOnline(23, secret);
    const res = await cancel(secret);
    expect(res.status).toBe(409);
    expect(res.body).toEqual(TOO_LATE);
    expect(await statusOf(id)).toBe('confirmed');
    const still = await lookup(secret);
    expect(still.status).toBe(200);
    expect(still.body.status).toBe('confirmed');
  });

  it('cancels a booking 25 hours ahead', async () => {
    const secret = newSecret();
    const id = await insertOnline(25, secret);
    const res = await cancel(secret);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(await statusOf(id)).toBe('cancelled');
  });

  it('answers 200 for an already cancelled booking, even inside the 24 hours', async () => {
    const secret = newSecret();
    await insertOnline(23, secret, 'cancelled');
    const res = await cancel(secret);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  it('still lets staff cancel inside the 24 hours', async () => {
    const secret = newSecret();
    const id = await insertOnline(23, secret);
    expect((await staffCancel(id)).status).toBe(200);
    expect(await statusOf(id)).toBe('cancelled');
    expect((await cancel(secret)).status).toBe(200);
  });
});

describe('a link that does not work', () => {
  it('gets the unknown-route 404 on lookup and cancel, whatever the reason', async () => {
    const expected = await unknownRoute();
    expect(expected.status).toBe(404);

    const started = newSecret();
    const startedId = await insertOnline(-1, started);
    // A staff booking can't have a hash, so no secret can reach it.
    const staff = await bookAsStaff(validBody({ startsAt: at(3, 14) }));
    expect(staff.status).toBe(201);

    const bodies: [string, unknown][] = [
      ['unknown', { token: newSecret() }],
      ['already started', { token: started }],
      ['malformed', { token: 'a'.repeat(42) }],
      ['not a string', { token: 42 }],
      ['empty', {}],
      ['a list', [newSecret()]],
    ];
    for (const action of ['lookup', 'cancel'] as const) {
      for (const [label, body] of bodies) {
        const res = observed(await manage(action, body));
        expect({ action, label, ...res }).toEqual({
          action,
          label,
          ...expected,
        });
      }
    }
    expect(await statusOf(startedId)).toBe('confirmed');
    expect(await statusOf(staff.body.id as string)).toBe('confirmed');
  });

  it('never reaches the database for a malformed secret', async () => {
    const query = vi.spyOn(pool, 'query');
    for (const action of ['lookup', 'cancel'] as const) {
      for (const body of [{ token: 'a'.repeat(42) }, {}, { token: 7 }]) {
        expect((await manage(action, body)).status).toBe(404);
      }
    }
    expect(query).not.toHaveBeenCalled();
  });
});

describe('the origin check', () => {
  it.each([
    ['no', null],
    ['a wrong', 'https://evil.example'],
    ['a "null"', 'null'],
  ])(
    'refuses lookup and cancel with %s Origin, and changes nothing',
    async (_label, origin) => {
      const secret = newSecret();
      expect(
        (await bookOnline(validBody({ manageToken: secret }))).status,
      ).toBe(201);
      for (const action of ['lookup', 'cancel'] as const) {
        const res = await manage(action, { token: secret }, origin);
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Forbidden' });
      }
      const rows = await client.query('SELECT status FROM bookings');
      expect(rows.rows).toEqual([{ status: 'confirmed' }]);
    },
  );
});

describe('bookings.manage_token_hash', () => {
  const insertRow = (source: string, hash: Buffer, hour: number) =>
    client.query(
      `INSERT INTO bookings
         (org_id, resource_id, service_id, starts_at, ends_at,
          customer_name, customer_email, source, manage_token_hash)
       VALUES ($1, $2, $3, $4, $5, 'Row', 'row@example.com', $6, $7)`,
      [orgId, roomId, serviceId, at(5, hour), at(5, hour + 1), source, hash],
    );

  it('refuses a hash on a staff booking', async () => {
    await expect(
      insertRow('staff', sha256(newSecret()), 1),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'bookings_manage_token_source_check',
    });
  });

  it('refuses a hash that is not 32 bytes', async () => {
    await expect(insertRow('public', randomBytes(31), 1)).rejects.toMatchObject(
      {
        code: '23514',
        constraint: 'bookings_manage_token_hash_check',
      },
    );
  });

  it('refuses the same hash twice', async () => {
    const hash = sha256(newSecret());
    await insertRow('public', hash, 1);
    await expect(insertRow('public', hash, 3)).rejects.toMatchObject({
      code: '23505',
      constraint: 'bookings_manage_token_hash_key',
    });
  });
});
