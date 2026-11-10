// Step 6c: organization members through the real app on the test database
// (D-030). Covers the session check (401), the origin check (403), list, add
// and remove, the owner-only role check (403), the duplicate-add race, and
// isolation between organizations (404 identical to an unknown route).
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
const PASSWORD = 'org-members-pw-15chars';

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;

type TestUser = { id: string; name: string; email: string; cookie: string };
let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
let dave: TestUser;
let erin: TestUser;
let orgA: string;
let orgB: string;

// Signs a user up and returns the session cookie from the sign-up response.
async function createUser(email: string, name: string): Promise<TestUser> {
  const cookie = await signUp(app, { email, password: PASSWORD, name });
  const row = await client.query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [email],
  );
  return { id: row.rows[0]!.id, name, email, cookie };
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

async function countMemberships(orgId: string): Promise<number> {
  const result = await client.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM memberships WHERE org_id = $1',
    [orgId],
  );
  return result.rows[0]!.count;
}

async function membershipRole(
  orgId: string,
  userId: string,
): Promise<string | undefined> {
  const result = await client.query<{ role: string }>(
    'SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2',
    [orgId, userId],
  );
  return result.rows[0]?.role;
}

const addMember = (cookie: string, orgId: string) =>
  request(app)
    .post(`/api/orgs/${orgId}/members`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie);

const removeMember = (cookie: string, orgId: string, userId: string) =>
  request(app)
    .delete(`/api/orgs/${orgId}/members/${encodeURIComponent(userId)}`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie);

const listMembers = (cookie: string, orgId: string) =>
  request(app).get(`/api/orgs/${orgId}/members`).set('Cookie', cookie);

// Status, body and content-type: what a caller can observe.
function observed(res: request.Response) {
  return {
    status: res.status,
    body: res.body as unknown,
    contentType: res.get('content-type'),
  };
}

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser('org-alice@example.com', 'Alice');
  bob = await createUser('org-bob@example.com', 'Bob');
  carol = await createUser('org-carol@example.com', 'Carol');
  dave = await createUser('org-dave@example.com', 'Dave');
  erin = await createUser('org-erin@example.com', 'Erin');
  orgA = await createOrg(alice.cookie, 'Members Org A');
  orgB = await createOrg(dave.cookie, 'Members Org B');
  await client.query(
    "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'staff')",
    [orgB, erin.id],
  );
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('401: the session check', () => {
  it('returns 401 without a cookie on list, add and remove', async () => {
    const list = await request(app).get(`/api/orgs/${orgA}/members`);
    const add = await request(app)
      .post(`/api/orgs/${orgA}/members`)
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: carol.email });
    const remove = await request(app)
      .delete(`/api/orgs/${orgA}/members/${alice.id}`)
      .set('Origin', TRUSTED_ORIGIN);

    for (const res of [list, add, remove]) {
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
    it(`rejects add and remove with Origin ${label}, leaving memberships unchanged`, async () => {
      const before = await countMemberships(orgA);

      let add = request(app)
        .post(`/api/orgs/${orgA}/members`)
        .set('Cookie', alice.cookie);
      let remove = request(app)
        .delete(`/api/orgs/${orgA}/members/${alice.id}`)
        .set('Cookie', alice.cookie);
      if (origin !== undefined) {
        add = add.set('Origin', origin);
        remove = remove.set('Origin', origin);
      }

      for (const res of [
        await add.send({ email: carol.email }),
        await remove,
      ]) {
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Forbidden' });
      }
      expect(await countMemberships(orgA)).toBe(before);
      expect(await membershipRole(orgA, alice.id)).toBe('owner');
    });
  }
});

describe('add', () => {
  it('adds Bob as staff from his email with spaces and capitals', async () => {
    const res = await addMember(alice.cookie, orgA).send({
      email: '  ORG-BOB@Example.com ',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      userId: bob.id,
      name: 'Bob',
      email: 'org-bob@example.com',
      role: 'staff',
    });
    expect(await membershipRole(orgA, bob.id)).toBe('staff');
  });

  it('returns 404 for an unknown email and adds no row', async () => {
    const before = await countMemberships(orgA);
    const res = await addMember(alice.cookie, orgA).send({
      email: 'nobody-here@example.com',
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(await countMemberships(orgA)).toBe(before);
  });

  it('returns 409 for Bob again and for Alice adding herself', async () => {
    const before = await countMemberships(orgA);

    const bobAgain = await addMember(alice.cookie, orgA).send({
      email: bob.email,
    });
    expect(bobAgain.status).toBe(409);
    expect(bobAgain.body).toEqual({ error: 'Conflict' });

    const self = await addMember(alice.cookie, orgA).send({
      email: alice.email,
    });
    expect(self.status).toBe(409);
    expect(self.body).toEqual({ error: 'Conflict' });

    expect(await countMemberships(orgA)).toBe(before);
    expect(await membershipRole(orgA, alice.id)).toBe('owner');
  });

  it('rejects invalid bodies with 400 and adds no row', async () => {
    const before = await countMemberships(orgA);

    // With no body, Express leaves req.body undefined, so Zod reports the
    // issue on the whole body (path ''), not on 'email'.
    const cases: Array<[string, request.Test, string]> = [
      ['no body', addMember(alice.cookie, orgA), ''],
      ['{}', addMember(alice.cookie, orgA).send({}), 'email'],
      ['a number', addMember(alice.cookie, orgA).send({ email: 42 }), 'email'],
      ['nope', addMember(alice.cookie, orgA).send({ email: 'nope' }), 'email'],
      [
        '255 characters',
        addMember(alice.cookie, orgA).send({
          email: 'a'.repeat(243) + '@example.com',
        }),
        'email',
      ],
    ];
    for (const [label, req, path] of cases) {
      const res = await req;
      expect({ label, status: res.status, error: res.body.error }).toEqual({
        label,
        status: 400,
        error: 'Bad Request',
      });
      expect({ label, path: res.body.details[0].path }).toEqual({
        label,
        path,
      });
    }

    expect(await countMemberships(orgA)).toBe(before);
  });

  it('lets exactly one of two simultaneous adds of Carol win', async () => {
    const [first, second] = await Promise.all([
      addMember(alice.cookie, orgA).send({ email: carol.email }),
      addMember(alice.cookie, orgA).send({ email: carol.email }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);

    const rows = await client.query(
      'SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2',
      [orgA, carol.id],
    );
    expect(rows.rowCount).toBe(1);

    // Back to a known state: Carol in no organization.
    const remove = await removeMember(alice.cookie, orgA, carol.id);
    expect(remove.status).toBe(204);
    expect(await membershipRole(orgA, carol.id)).toBeUndefined();
  });
});

describe('list', () => {
  it('gives the owner and staff the same list, owner first, four keys each', async () => {
    for (const user of [alice, bob]) {
      const res = await listMembers(user.cookie, orgA);
      expect(res.status).toBe(200);
      const members = res.body as Array<Record<string, unknown>>;
      expect(members).toEqual([
        { userId: alice.id, name: 'Alice', email: alice.email, role: 'owner' },
        { userId: bob.id, name: 'Bob', email: bob.email, role: 'staff' },
      ]);
      for (const member of members) {
        expect(Object.keys(member).sort()).toEqual([
          'email',
          'name',
          'role',
          'userId',
        ]);
      }
    }
  });
});

describe('role check: staff cannot add or remove', () => {
  it('returns 403 to Bob adding Carol, removing Alice and removing himself', async () => {
    const attempts: Array<[string, () => request.Test]> = [
      [
        'add Carol',
        () => addMember(bob.cookie, orgA).send({ email: carol.email }),
      ],
      ['remove Alice', () => removeMember(bob.cookie, orgA, alice.id)],
      ['remove himself', () => removeMember(bob.cookie, orgA, bob.id)],
    ];
    for (const [label, attempt] of attempts) {
      const before = await countMemberships(orgA);
      const res = await attempt();
      expect({ label, status: res.status, body: res.body as unknown }).toEqual({
        label,
        status: 403,
        body: { error: 'Forbidden' },
      });
      expect(await countMemberships(orgA)).toBe(before);
      expect(await membershipRole(orgA, alice.id)).toBe('owner');
      expect(await membershipRole(orgA, bob.id)).toBe('staff');
      expect(await membershipRole(orgA, carol.id)).toBeUndefined();
    }
  });
});

describe('remove', () => {
  it('removes Bob with 204 and no body, after which Bob gets 404 on A', async () => {
    const res = await removeMember(alice.cookie, orgA, bob.id);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await membershipRole(orgA, bob.id)).toBeUndefined();

    const view = await request(app)
      .get(`/api/orgs/${orgA}`)
      .set('Cookie', bob.cookie);
    const list = await listMembers(bob.cookie, orgA);
    for (const after of [view, list]) {
      expect(after.status).toBe(404);
      expect(after.body).toEqual({ error: 'Not found' });
    }
  });

  it('returns 409 when Alice removes herself, and her owner row stays', async () => {
    const res = await removeMember(alice.cookie, orgA, alice.id);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Conflict' });
    expect(await membershipRole(orgA, alice.id)).toBe('owner');
  });

  it('returns 404 for a registered non-member and for an unknown ID', async () => {
    for (const userId of [carol.id, 'no-such-user']) {
      const res = await removeMember(alice.cookie, orgA, userId);
      expect({ userId, status: res.status, body: res.body as unknown }).toEqual(
        { userId, status: 404, body: { error: 'Not found' } },
      );
    }
  });

  it('returns 404 for Erin (a member of B, not A) and leaves her row in B', async () => {
    const res = await removeMember(alice.cookie, orgA, erin.id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(await membershipRole(orgB, erin.id)).toBe('staff');
  });
});

describe('isolation: Dave (owner of B) on organization A', () => {
  beforeAll(async () => {
    await client.query(
      "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'staff')",
      [orgA, bob.id],
    );
  });

  it('gets the unknown-route 404 on list, add and remove, and A is unchanged', async () => {
    const unknownRoute = observed(
      await request(app).get('/api/does-not-exist').set('Cookie', dave.cookie),
    );
    expect(unknownRoute.status).toBe(404);
    expect(unknownRoute.body).toEqual({ error: 'Not found' });

    const before = await countMemberships(orgA);
    const attempts: Array<[string, () => request.Test]> = [
      ['list', () => listMembers(dave.cookie, orgA)],
      [
        'add Carol',
        () => addMember(dave.cookie, orgA).send({ email: carol.email }),
      ],
      ['remove Bob', () => removeMember(dave.cookie, orgA, bob.id)],
    ];
    for (const [label, attempt] of attempts) {
      const res = observed(await attempt());
      expect({ label, ...res }).toEqual({ label, ...unknownRoute });
    }

    expect(await countMemberships(orgA)).toBe(before);
    expect(await membershipRole(orgA, bob.id)).toBe('staff');
    expect(await membershipRole(orgA, carol.id)).toBeUndefined();
  });

  it('lists only Dave and Erin on B', async () => {
    const res = await listMembers(dave.cookie, orgB);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { userId: dave.id, name: 'Dave', email: dave.email, role: 'owner' },
      { userId: erin.id, name: 'Erin', email: erin.email, role: 'staff' },
    ]);
  });
});
