// Organization members through the real app on the test database
// (D-030). Covers the session check (401), the origin check (403), list and
// remove, the owner-only role check (403), that no route adds a member by
// email, and isolation between organizations (404 identical to an unknown
// route). People join through invite links (invitations.test.ts).
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
const PASSWORD = 'org-members-pw-15chars';

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;

let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
let dave: TestUser;
let erin: TestUser;
let orgA: string;
let orgB: string;

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

const removeMember = (cookie: string, orgId: string, userId: string) =>
  request(app)
    .delete(`/api/orgs/${orgId}/members/${encodeURIComponent(userId)}`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie);

const listMembers = (cookie: string, orgId: string) =>
  request(app).get(`/api/orgs/${orgId}/members`).set('Cookie', cookie);

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser(app, client, {
    email: 'org-alice@example.com',
    password: PASSWORD,
    name: 'Alice',
  });
  bob = await createUser(app, client, {
    email: 'org-bob@example.com',
    password: PASSWORD,
    name: 'Bob',
  });
  carol = await createUser(app, client, {
    email: 'org-carol@example.com',
    password: PASSWORD,
    name: 'Carol',
  });
  dave = await createUser(app, client, {
    email: 'org-dave@example.com',
    password: PASSWORD,
    name: 'Dave',
  });
  erin = await createUser(app, client, {
    email: 'org-erin@example.com',
    password: PASSWORD,
    name: 'Erin',
  });
  orgA = await createOrg(app, alice.cookie, 'Members Org A');
  orgB = await createOrg(app, dave.cookie, 'Members Org B');
  await client.query(
    "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'staff'), ($3, $4, 'staff')",
    [orgB, erin.id, orgA, bob.id],
  );
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('401: the session check', () => {
  it('returns 401 without a cookie on list and remove', async () => {
    const list = await request(app).get(`/api/orgs/${orgA}/members`);
    const remove = await request(app)
      .delete(`/api/orgs/${orgA}/members/${alice.id}`)
      .set('Origin', TRUSTED_ORIGIN);

    for (const res of [list, remove]) {
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
    it(`rejects remove with Origin ${label}, leaving memberships unchanged`, async () => {
      const before = await countMemberships(orgA);

      let remove = request(app)
        .delete(`/api/orgs/${orgA}/members/${alice.id}`)
        .set('Cookie', alice.cookie);
      if (origin !== undefined) {
        remove = remove.set('Origin', origin);
      }

      const res = await remove;
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
      expect(await countMemberships(orgA)).toBe(before);
      expect(await membershipRole(orgA, alice.id)).toBe('owner');
    });
  }
});

describe('no adding by email', () => {
  it('answers the owner POST /members with the unknown-route 404 and adds no row', async () => {
    const unknownRoute = observed(
      await request(app).get('/api/does-not-exist').set('Cookie', alice.cookie),
    );
    const before = await countMemberships(orgA);
    const res = await request(app)
      .post(`/api/orgs/${orgA}/members`)
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', alice.cookie)
      .send({ email: carol.email });
    expect(observed(res)).toEqual(unknownRoute);
    expect(await countMemberships(orgA)).toBe(before);
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

describe('role check: staff cannot remove', () => {
  it('returns 403 to Bob removing Alice and removing himself', async () => {
    const attempts: Array<[string, () => request.Test]> = [
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

  it('gets the unknown-route 404 on list and remove, and A is unchanged', async () => {
    const unknownRoute = observed(
      await request(app).get('/api/does-not-exist').set('Cookie', dave.cookie),
    );
    expect(unknownRoute.status).toBe(404);
    expect(unknownRoute.body).toEqual({ error: 'Not found' });

    const before = await countMemberships(orgA);
    const attempts: Array<[string, () => request.Test]> = [
      ['list', () => listMembers(dave.cookie, orgA)],
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
