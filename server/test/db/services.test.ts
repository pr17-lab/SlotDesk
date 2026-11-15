// Step 9b: services routes through the real app on the test database (D-032).
// Covers the session check (401), the origin check (403), create, the
// owner-only role check (403), validation (400), update, list and view, and
// isolation between organizations (404 identical to an unknown one).
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAppOnTestDatabase, signUp } from './helpers/auth-app.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

const TRUSTED_ORIGIN = 'http://localhost:3000';
const EVIL_ORIGIN = 'https://evil.example';
// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'services-test-pw-15chars';
const NEEDS_ONE_FIELD = 'Provide name or durationMinutes';

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
let serviceA: string; // a service of org A
let serviceB: string; // a service of org B

// These small helpers now exist in three files (members.test.ts,
// resources.test.ts and this one): createUser, createOrg and observed. Not
// shared, because existing test files are not refactored.
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

// Status, body and content-type: what a caller can observe.
function observed(res: request.Response) {
  return {
    status: res.status,
    body: res.body as unknown,
    contentType: res.get('content-type'),
  };
}

type Row = {
  id: string;
  org_id: string;
  name: string;
  duration_minutes: number;
};

// Every service row in the database, in id order: a snapshot to prove a
// rejected request changed nothing.
async function allRows(): Promise<Row[]> {
  const result = await client.query<Row>(
    'SELECT id, org_id, name, duration_minutes FROM services ORDER BY id',
  );
  return result.rows;
}

const base = (orgId: string) => `/api/orgs/${orgId}/services`;

const post = (cookie: string, orgId: string) =>
  request(app)
    .post(base(orgId))
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie);

const patch = (cookie: string, orgId: string, serviceId: string) =>
  request(app)
    .patch(`${base(orgId)}/${serviceId}`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie);

const list = (cookie: string, orgId: string) =>
  request(app).get(base(orgId)).set('Cookie', cookie);

const view = (cookie: string, orgId: string, serviceId: string) =>
  request(app)
    .get(`${base(orgId)}/${serviceId}`)
    .set('Cookie', cookie);

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser('svc-alice@example.com', 'Alice');
  bob = await createUser('svc-bob@example.com', 'Bob');
  carol = await createUser('svc-carol@example.com', 'Carol');
  dave = await createUser('svc-dave@example.com', 'Dave');
  orgA = await createOrg(alice.cookie, 'Services Org A');
  orgB = await createOrg(dave.cookie, 'Services Org B');
  await client.query(
    "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'staff')",
    [orgA, bob.id],
  );
  const a = await post(alice.cookie, orgA).send({
    name: 'Haircut A',
    durationMinutes: 30,
  });
  const b = await post(dave.cookie, orgB).send({
    name: 'Haircut B',
    durationMinutes: 45,
  });
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  serviceA = a.body.id as string;
  serviceB = b.body.id as string;
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('401: the session check', () => {
  it('returns 401 without a cookie on all four routes', async () => {
    const responses = [
      await request(app).get(base(orgA)),
      await request(app).get(`${base(orgA)}/${serviceA}`),
      await request(app)
        .post(base(orgA))
        .set('Origin', TRUSTED_ORIGIN)
        .send({ name: 'X', durationMinutes: 30 }),
      await request(app)
        .patch(`${base(orgA)}/${serviceA}`)
        .set('Origin', TRUSTED_ORIGIN)
        .send({ name: 'X' }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized' });
    }
  });
});

describe('403: the origin check', () => {
  const badOrigins: Array<[string, string | undefined]> = [
    ['missing', undefined],
    [EVIL_ORIGIN, EVIL_ORIGIN],
  ];

  for (const [label, origin] of badOrigins) {
    it(`rejects POST and PATCH with Origin ${label}, leaving the database unchanged`, async () => {
      const before = await allRows();

      let create = request(app).post(base(orgA)).set('Cookie', alice.cookie);
      let update = request(app)
        .patch(`${base(orgA)}/${serviceA}`)
        .set('Cookie', alice.cookie);
      if (origin !== undefined) {
        create = create.set('Origin', origin);
        update = update.set('Origin', origin);
      }

      for (const res of [
        await create.send({ name: 'X', durationMinutes: 30 }),
        await update.send({ name: 'X' }),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Forbidden' });
      }
      expect(await allRows()).toEqual(before);
    });
  }

  it('lets GET work without an Origin header', async () => {
    const res = await list(alice.cookie, orgA);
    expect(res.status).toBe(200);
  });
});

describe('create', () => {
  it('returns 201 with { id, name, durationMinutes }, trims the name, and the database agrees', async () => {
    const res = await post(alice.cookie, orgA).send({
      name: '  Massage  ',
      durationMinutes: 60,
    });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual([
      'durationMinutes',
      'id',
      'name',
    ]);
    expect(typeof res.body.id).toBe('string');
    expect(typeof res.body.durationMinutes).toBe('number');
    expect(res.body.name).toBe('Massage');
    expect(res.body.durationMinutes).toBe(60);

    const row = await client.query<Omit<Row, 'id'>>(
      'SELECT org_id, name, duration_minutes FROM services WHERE id = $1',
      [res.body.id],
    );
    expect(row.rows[0]).toEqual({
      org_id: orgA,
      name: 'Massage',
      duration_minutes: 60,
    });
  });

  it('allows a second service with the same name', async () => {
    const first = await post(alice.cookie, orgA).send({
      name: 'Twin',
      durationMinutes: 15,
    });
    const second = await post(alice.cookie, orgA).send({
      name: 'Twin',
      durationMinutes: 15,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });
});

describe('role check: staff', () => {
  it('returns 403 to Bob on POST and PATCH, and the database is unchanged', async () => {
    const before = await allRows();
    const create = await post(bob.cookie, orgA).send({
      name: 'X',
      durationMinutes: 30,
    });
    const update = await patch(bob.cookie, orgA, serviceA).send({ name: 'X' });
    for (const res of [create, update]) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
    }
    expect(await allRows()).toEqual(before);
  });

  it('lets Bob list and view', async () => {
    const listed = await list(bob.cookie, orgA);
    expect(listed.status).toBe(200);
    expect((listed.body as Array<{ id: string }>).map((r) => r.id)).toContain(
      serviceA,
    );

    const one = await view(bob.cookie, orgA, serviceA);
    expect(one.status).toBe(200);
    expect(one.body).toEqual({
      id: serviceA,
      name: 'Haircut A',
      durationMinutes: 30,
    });
  });
});

describe('POST validation (400)', () => {
  // With no body, Express leaves req.body undefined, so Zod reports the issue
  // on the whole body (path ''). With {} the missing field is named.
  const cases: Array<[string, unknown, string]> = [
    ['no body', undefined, ''],
    ['{}', {}, 'name'],
    ['an empty name', { name: '', durationMinutes: 30 }, 'name'],
    [
      'a 101-character name',
      { name: 'a'.repeat(101), durationMinutes: 30 },
      'name',
    ],
    ['a missing durationMinutes', { name: 'X' }, 'durationMinutes'],
    ['0 minutes', { name: 'X', durationMinutes: 0 }, 'durationMinutes'],
    ['-5 minutes', { name: 'X', durationMinutes: -5 }, 'durationMinutes'],
    ['485 minutes', { name: 'X', durationMinutes: 485 }, 'durationMinutes'],
    ['7 minutes', { name: 'X', durationMinutes: 7 }, 'durationMinutes'],
    ['7.5 minutes', { name: 'X', durationMinutes: 7.5 }, 'durationMinutes'],
    [
      'the string "30"',
      { name: 'X', durationMinutes: '30' },
      'durationMinutes',
    ],
    [
      'a null duration',
      { name: 'X', durationMinutes: null },
      'durationMinutes',
    ],
  ];

  it.each(cases)('rejects %s', async (_label, body, path) => {
    const before = await allRows();
    const req = post(alice.cookie, orgA);
    const res = await (body === undefined ? req : req.send(body as object));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.details[0].path).toBe(path);
    expect(await allRows()).toEqual(before);
  });

  // This is the case z.int() exists for: Zod's multipleOf(5) alone accepts
  // 30.000000000000004 (it allows for floating-point error), and PostgreSQL
  // then refuses it for an integer column, which would be a 500. Sent as raw
  // JSON text so the number reaches the server exactly as written.
  it('rejects 30.000000000000004 with 400, not 500', async () => {
    const before = await allRows();
    const res = await post(alice.cookie, orgA)
      .set('Content-Type', 'application/json')
      .send('{"name":"X","durationMinutes":30.000000000000004}');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.details[0].path).toBe('durationMinutes');
    expect(await allRows()).toEqual(before);
  });
});

describe('PATCH', () => {
  async function createOne(): Promise<string> {
    const res = await post(alice.cookie, orgA).send({
      name: 'Before',
      durationMinutes: 20,
    });
    return res.body.id as string;
  }

  async function stored(id: string) {
    const row = await client.query<{ name: string; duration_minutes: number }>(
      'SELECT name, duration_minutes FROM services WHERE id = $1',
      [id],
    );
    return row.rows[0];
  }

  it('changes the name only, and the duration stays', async () => {
    const id = await createOne();
    const res = await patch(alice.cookie, orgA, id).send({ name: '  After ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, name: 'After', durationMinutes: 20 });
    expect(await stored(id)).toEqual({ name: 'After', duration_minutes: 20 });
  });

  it('changes the duration only, and the name stays', async () => {
    const id = await createOne();
    const res = await patch(alice.cookie, orgA, id).send({
      durationMinutes: 90,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, name: 'Before', durationMinutes: 90 });
    expect(await stored(id)).toEqual({ name: 'Before', duration_minutes: 90 });
  });

  it('changes both', async () => {
    const id = await createOne();
    const res = await patch(alice.cookie, orgA, id).send({
      name: 'Both',
      durationMinutes: 120,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, name: 'Both', durationMinutes: 120 });
    expect(await stored(id)).toEqual({ name: 'Both', duration_minutes: 120 });
  });

  // No body gives path '' (body is undefined), and so does {} (the refine).
  // The message tells them apart.
  it('rejects no body', async () => {
    const before = await allRows();
    const res = await patch(alice.cookie, orgA, serviceA);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.details[0].path).toBe('');
    expect(await allRows()).toEqual(before);
  });

  it('rejects {} with the "provide one" message', async () => {
    const before = await allRows();
    const res = await patch(alice.cookie, orgA, serviceA).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.details[0].path).toBe('');
    expect(res.body.details[0].message).toBe(NEEDS_ONE_FIELD);
    expect(await allRows()).toEqual(before);
  });

  // The misspelt key is Zod's unrecognized_keys issue, on the whole body. The
  // message is not the refine message, which is what fails if the schema stops
  // being strict (the refine would then see name and accept the request).
  it('rejects an unknown key, even with a valid name', async () => {
    const before = await allRows();
    const res = await patch(alice.cookie, orgA, serviceA).send({
      name: 'x',
      duration: 30,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0].path).toBe('');
    expect(res.body.details[0].message).not.toBe(NEEDS_ONE_FIELD);
    expect(await allRows()).toEqual(before);
  });

  it.each([
    ['an empty name', { name: '' }, 'name'],
    ['durationMinutes of 7', { durationMinutes: 7 }, 'durationMinutes'],
  ])('rejects %s', async (_label, body, path) => {
    const before = await allRows();
    const res = await patch(alice.cookie, orgA, serviceA).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.details[0].path).toBe(path);
    expect(await allRows()).toEqual(before);
  });
});

describe('list and view', () => {
  it('lists only this organization, ordered by id', async () => {
    const res = await list(alice.cookie, orgA);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ id: string }>;
    const ids = rows.map((r) => BigInt(r.id));
    expect(ids).toEqual([...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    expect(rows.map((r) => r.id)).toContain(serviceA);
    expect(rows.map((r) => r.id)).not.toContain(serviceB);

    const inA = await client.query(
      'SELECT count(*)::int AS count FROM services WHERE org_id = $1',
      [orgA],
    );
    expect(rows).toHaveLength(inA.rows[0].count);
  });

  it('views one service', async () => {
    const res = await view(alice.cookie, orgA, serviceA);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(serviceA);
    expect(res.body.durationMinutes).toBe(30);
  });

  const badIds = [
    '999999',
    '0',
    '01',
    'abc',
    '1.5',
    '9223372036854775808',
    '-1',
  ];

  it.each(badIds)('returns 404 on view for the ID %s', async (id) => {
    const res = await view(alice.cookie, orgA, id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it.each(badIds)('returns 404 on PATCH for the ID %s', async (id) => {
    const res = await patch(alice.cookie, orgA, id).send({ name: 'X' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});

describe('isolation (D-030)', () => {
  const UNKNOWN_ORG = '999999';

  // Dave (a member of B only) and Carol (a member of nothing) must see on
  // organization A exactly what they see on an organization that does not exist.
  it.each([
    ['dave', () => dave],
    ['carol', () => carol],
  ])(
    '%s on A gets the unknown-organization 404 everywhere',
    async (_n, who) => {
      const user = who();
      const before = await allRows();

      const attempts = (orgId: string) => [
        list(user.cookie, orgId),
        view(user.cookie, orgId, serviceA),
        post(user.cookie, orgId).send({ name: 'X', durationMinutes: 30 }),
        patch(user.cookie, orgId, serviceA).send({ name: 'X' }),
      ];
      const unknown = (await Promise.all(attempts(UNKNOWN_ORG))).map(observed);
      const onA = (await Promise.all(attempts(orgA))).map(observed);

      expect(unknown[0]!.status).toBe(404);
      expect(unknown[0]!.body).toEqual({ error: 'Not found' });
      expect(onA).toEqual(unknown);
      expect(await allRows()).toEqual(before);
    },
  );

  it("dave on B's URL asking for A's service gets the same 404 as a nonexistent ID", async () => {
    const before = await allRows();
    const missing = '999999';

    const viewOther = observed(await view(dave.cookie, orgB, serviceA));
    const viewMissing = observed(await view(dave.cookie, orgB, missing));
    expect(viewMissing.status).toBe(404);
    expect(viewOther).toEqual(viewMissing);

    const patchOther = observed(
      await patch(dave.cookie, orgB, serviceA).send({
        name: 'Hijacked',
        durationMinutes: 480,
      }),
    );
    const patchMissing = observed(
      await patch(dave.cookie, orgB, missing).send({
        name: 'Hijacked',
        durationMinutes: 480,
      }),
    );
    expect(patchMissing.status).toBe(404);
    expect(patchOther).toEqual(patchMissing);

    // A's service is unchanged.
    expect(await allRows()).toEqual(before);
    const row = await client.query<{ name: string; duration_minutes: number }>(
      'SELECT name, duration_minutes FROM services WHERE id = $1',
      [serviceA],
    );
    expect(row.rows[0]).toEqual({ name: 'Haircut A', duration_minutes: 30 });
  });

  it("keeps each organization's list free of the other's services", async () => {
    const listA = (await list(alice.cookie, orgA)).body as Array<{
      id: string;
    }>;
    const listB = (await list(dave.cookie, orgB)).body as Array<{
      id: string;
    }>;
    expect(listB.map((r) => r.id)).toEqual([serviceB]);
    expect(listA.map((r) => r.id)).not.toContain(serviceB);
    expect(listB.map((r) => r.id)).not.toContain(serviceA);
  });
});
