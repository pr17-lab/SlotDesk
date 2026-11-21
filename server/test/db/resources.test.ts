// Resources routes through the real app on the test database
// (D-032). Covers the session check (401), the origin check (403), create,
// the owner-only role check (403), validation (400), rename, list and view,
// and isolation between organizations (404 identical to an unknown one).
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const TRUSTED_ORIGIN = 'http://localhost:3000';
const EVIL_ORIGIN = 'https://evil.example';
// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'resources-test-pw-15chars';
const BAD_ZONE = 'Not a valid IANA time zone name';

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;

let alice: TestUser; // owner of org A
let bob: TestUser; // staff of org A
let carol: TestUser; // in no organization
let dave: TestUser; // owner of org B
let orgA: string;
let orgB: string;
let resourceA: string; // a resource of org A
let resourceB: string; // a resource of org B

type Row = { id: string; org_id: string; name: string; time_zone: string };

// Every resource row in the database, in id order: a snapshot to prove a
// rejected request changed nothing.
async function allRows(): Promise<Row[]> {
  const result = await client.query<Row>(
    'SELECT id, org_id, name, time_zone FROM resources ORDER BY id',
  );
  return result.rows;
}

const base = (orgId: string) => `/api/orgs/${orgId}/resources`;

const post = (cookie: string, orgId: string) =>
  request(app)
    .post(base(orgId))
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie);

const patch = (cookie: string, orgId: string, resourceId: string) =>
  request(app)
    .patch(`${base(orgId)}/${resourceId}`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie);

const list = (cookie: string, orgId: string) =>
  request(app).get(base(orgId)).set('Cookie', cookie);

const view = (cookie: string, orgId: string, resourceId: string) =>
  request(app)
    .get(`${base(orgId)}/${resourceId}`)
    .set('Cookie', cookie);

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser(app, client, {
    email: 'res-alice@example.com',
    password: PASSWORD,
    name: 'Alice',
  });
  bob = await createUser(app, client, {
    email: 'res-bob@example.com',
    password: PASSWORD,
    name: 'Bob',
  });
  carol = await createUser(app, client, {
    email: 'res-carol@example.com',
    password: PASSWORD,
    name: 'Carol',
  });
  dave = await createUser(app, client, {
    email: 'res-dave@example.com',
    password: PASSWORD,
    name: 'Dave',
  });
  orgA = await createOrg(app, alice.cookie, 'Resources Org A');
  orgB = await createOrg(app, dave.cookie, 'Resources Org B');
  await client.query(
    "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'staff')",
    [orgA, bob.id],
  );
  const a = await post(alice.cookie, orgA).send({
    name: 'Room A',
    timeZone: 'Europe/London',
  });
  const b = await post(dave.cookie, orgB).send({
    name: 'Room B',
    timeZone: 'America/New_York',
  });
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  resourceA = a.body.id as string;
  resourceB = b.body.id as string;
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
      await request(app).get(`${base(orgA)}/${resourceA}`),
      await request(app)
        .post(base(orgA))
        .set('Origin', TRUSTED_ORIGIN)
        .send({ name: 'X', timeZone: 'UTC' }),
      await request(app)
        .patch(`${base(orgA)}/${resourceA}`)
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
      let rename = request(app)
        .patch(`${base(orgA)}/${resourceA}`)
        .set('Cookie', alice.cookie);
      if (origin !== undefined) {
        create = create.set('Origin', origin);
        rename = rename.set('Origin', origin);
      }

      for (const res of [
        await create.send({ name: 'X', timeZone: 'UTC' }),
        await rename.send({ name: 'X' }),
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
  it('returns 201 with { id, name, timeZone } and trims the name', async () => {
    const res = await post(alice.cookie, orgA).send({
      name: '  Court 1  ',
      timeZone: 'Asia/Kolkata',
    });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['id', 'name', 'timeZone']);
    expect(typeof res.body.id).toBe('string');
    expect(res.body.name).toBe('Court 1');
    expect(res.body.timeZone).toBe('Asia/Kolkata');
  });

  it('stores asia/kolkata as Asia/Kolkata and returns the same', async () => {
    const res = await post(alice.cookie, orgA).send({
      name: 'Lowercase zone',
      timeZone: 'asia/kolkata',
    });
    expect(res.status).toBe(201);
    expect(res.body.timeZone).toBe('Asia/Kolkata');
    const row = await client.query<{ time_zone: string; org_id: string }>(
      'SELECT time_zone, org_id FROM resources WHERE id = $1',
      [res.body.id],
    );
    expect(row.rows[0]).toEqual({ time_zone: 'Asia/Kolkata', org_id: orgA });
  });

  it('allows a second resource with the same name', async () => {
    const first = await post(alice.cookie, orgA).send({
      name: 'Twin',
      timeZone: 'UTC',
    });
    const second = await post(alice.cookie, orgA).send({
      name: 'Twin',
      timeZone: 'UTC',
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
      timeZone: 'UTC',
    });
    const rename = await patch(bob.cookie, orgA, resourceA).send({ name: 'X' });
    for (const res of [create, rename]) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
    }
    expect(await allRows()).toEqual(before);
  });

  it('lets Bob list and view', async () => {
    const listed = await list(bob.cookie, orgA);
    expect(listed.status).toBe(200);
    expect((listed.body as Array<{ id: string }>).map((r) => r.id)).toContain(
      resourceA,
    );

    const one = await view(bob.cookie, orgA, resourceA);
    expect(one.status).toBe(200);
    expect(one.body).toEqual({
      id: resourceA,
      name: 'Room A',
      timeZone: 'Europe/London',
    });
  });
});

describe('POST validation (400)', () => {
  // With no body, Express leaves req.body undefined, so Zod reports the issue
  // on the whole body (path ''). With {} the missing field is named.
  const long = 'a'.repeat(101);
  const cases: Array<[string, unknown, string, string | undefined]> = [
    ['no body', undefined, '', undefined],
    ['{}', {}, 'name', undefined],
    ['an empty name', { name: '', timeZone: 'UTC' }, 'name', undefined],
    [
      'a 101-character name',
      { name: long, timeZone: 'UTC' },
      'name',
      undefined,
    ],
    ['a missing timeZone', { name: 'X' }, 'timeZone', undefined],
    ['Mars/Base', { name: 'X', timeZone: 'Mars/Base' }, 'timeZone', BAD_ZONE],
    ['+05:30', { name: 'X', timeZone: '+05:30' }, 'timeZone', BAD_ZONE],
    [
      'a 65-character time zone',
      { name: 'X', timeZone: 'a'.repeat(65) },
      'timeZone',
      undefined,
    ],
    [
      'a non-string time zone',
      { name: 'X', timeZone: 5 },
      'timeZone',
      undefined,
    ],
  ];

  it.each(cases)('rejects %s', async (_label, body, path, message) => {
    const before = await allRows();
    const req = post(alice.cookie, orgA);
    const res = await (body === undefined ? req : req.send(body as object));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.details[0].path).toBe(path);
    if (message !== undefined) {
      expect(res.body.details[0].message).toBe(message);
    }
    expect(await allRows()).toEqual(before);
  });

  // A 65-character name is not a real zone either, so the 400 would happen
  // even without the length check. This test fails if .max(64) is removed:
  // the message would then be the invalid-zone message.
  it('stops an over-long time zone at the length check, before conversion', async () => {
    const res = await post(alice.cookie, orgA).send({
      name: 'X',
      timeZone: 'a'.repeat(65),
    });
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe('timeZone');
    expect(res.body.details[0].message).not.toBe(BAD_ZONE);
  });
});

describe('PATCH', () => {
  it('renames, trims, and the response matches the database', async () => {
    const created = await post(alice.cookie, orgA).send({
      name: 'Before',
      timeZone: 'Asia/Kolkata',
    });
    const id = created.body.id as string;

    const res = await patch(alice.cookie, orgA, id).send({ name: '  After ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id,
      name: 'After',
      timeZone: 'Asia/Kolkata',
    });
    const row = await client.query<{ name: string; time_zone: string }>(
      'SELECT name, time_zone FROM resources WHERE id = $1',
      [id],
    );
    expect(row.rows[0]).toEqual({ name: 'After', time_zone: 'Asia/Kolkata' });
  });

  it('refuses a body with timeZone, even with a valid name, and changes nothing', async () => {
    const before = await allRows();
    const res = await patch(alice.cookie, orgA, resourceA).send({
      name: 'Renamed',
      timeZone: 'UTC',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    // One issue: unrecognized_keys, reported on the whole body.
    expect(res.body.details).toHaveLength(1);
    expect(res.body.details[0].path).toBe('');
    expect(await allRows()).toEqual(before);
  });

  // No body gives path '' (body is undefined); {} names the missing field.
  it.each([
    ['no body', undefined, ''],
    ['{}', {}, 'name'],
    ['an empty name', { name: '' }, 'name'],
    ['a 101-character name', { name: 'a'.repeat(101) }, 'name'],
  ])('rejects %s', async (_label, body, path) => {
    const before = await allRows();
    const req = patch(alice.cookie, orgA, resourceA);
    const res = await (body === undefined ? req : req.send(body));
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
    expect(rows.map((r) => r.id)).toContain(resourceA);
    expect(rows.map((r) => r.id)).not.toContain(resourceB);

    const inA = await client.query(
      'SELECT count(*)::int AS count FROM resources WHERE org_id = $1',
      [orgA],
    );
    expect(rows).toHaveLength(inA.rows[0].count);
  });

  it('views one resource', async () => {
    const res = await view(alice.cookie, orgA, resourceA);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(resourceA);
    expect(res.body.timeZone).toBe('Europe/London');
  });

  it.each(['999999', '0', '01', 'abc', '1.5', '9223372036854775808', '-1'])(
    'returns 404 for the ID %s',
    async (id) => {
      const res = await view(alice.cookie, orgA, id);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    },
  );

  it('returns 404 on PATCH for an unknown or malformed ID', async () => {
    for (const id of ['999999', 'abc']) {
      const res = await patch(alice.cookie, orgA, id).send({ name: 'X' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    }
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
        view(user.cookie, orgId, resourceA),
        post(user.cookie, orgId).send({ name: 'X', timeZone: 'UTC' }),
        patch(user.cookie, orgId, resourceA).send({ name: 'X' }),
      ];
      const unknown = (await Promise.all(attempts(UNKNOWN_ORG))).map(observed);
      const onA = (await Promise.all(attempts(orgA))).map(observed);

      expect(unknown[0]!.status).toBe(404);
      expect(unknown[0]!.body).toEqual({ error: 'Not found' });
      expect(onA).toEqual(unknown);
      expect(await allRows()).toEqual(before);
    },
  );

  it("dave on B's URL asking for A's resource gets the same 404 as a nonexistent ID", async () => {
    const before = await allRows();
    const missing = '999999';

    const viewOther = observed(await view(dave.cookie, orgB, resourceA));
    const viewMissing = observed(await view(dave.cookie, orgB, missing));
    expect(viewMissing.status).toBe(404);
    expect(viewOther).toEqual(viewMissing);

    const patchOther = observed(
      await patch(dave.cookie, orgB, resourceA).send({ name: 'Hijacked' }),
    );
    const patchMissing = observed(
      await patch(dave.cookie, orgB, missing).send({ name: 'Hijacked' }),
    );
    expect(patchMissing.status).toBe(404);
    expect(patchOther).toEqual(patchMissing);

    // A's resource is unchanged.
    expect(await allRows()).toEqual(before);
    const row = await client.query<{ name: string }>(
      'SELECT name FROM resources WHERE id = $1',
      [resourceA],
    );
    expect(row.rows[0]!.name).toBe('Room A');
  });

  it("keeps each organization's list free of the other's resources", async () => {
    const listA = (await list(alice.cookie, orgA)).body as Array<{
      id: string;
    }>;
    const listB = (await list(dave.cookie, orgB)).body as Array<{
      id: string;
    }>;
    expect(listB.map((r) => r.id)).toEqual([resourceB]);
    expect(listA.map((r) => r.id)).not.toContain(resourceB);
    expect(listB.map((r) => r.id)).not.toContain(resourceA);
  });
});
