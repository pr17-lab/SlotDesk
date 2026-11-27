// Invite links through the real app on the test database. The owner makes a
// one-time link; whoever holds its secret can accept or decline it once,
// within 24 hours. Covers the session and origin checks, the owner-only
// check, what is stored, accept, decline, the one 404 for every dead link,
// the email squatter, the cap, and isolation between organizations.
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
const PASSWORD = 'invitations-pw-15chars';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;

let alice: TestUser;
let bob: TestUser;
let dave: TestUser;
let erin: TestUser;
let mallory: TestUser;
let orgA: string;
let orgB: string;

const sha256 = (token: string) => createHash('sha256').update(token).digest();

// A token in the right format that no invitation has.
const unknownToken = () => randomBytes(32).toString('base64url');

const post = (path: string, cookie: string) =>
  request(app).post(path).set('Origin', TRUSTED_ORIGIN).set('Cookie', cookie);

const create = (cookie: string, orgId: string, label = 'Priya, front desk') =>
  post(`/api/orgs/${orgId}/invitations`, cookie).send({ label });

const list = (cookie: string, orgId: string) =>
  request(app).get(`/api/orgs/${orgId}/invitations`).set('Cookie', cookie);

const cancel = (cookie: string, orgId: string, id: string) =>
  request(app)
    .delete(`/api/orgs/${orgId}/invitations/${id}`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie);

const lookup = (cookie: string, token: unknown) =>
  post('/api/invitations/lookup', cookie).send({ token });
const accept = (cookie: string, token: unknown) =>
  post('/api/invitations/accept', cookie).send({ token });
const decline = (cookie: string, token: unknown) =>
  post('/api/invitations/decline', cookie).send({ token });

// Alice invites someone to A and gets the link's secret.
async function newInvite(
  cookie = alice.cookie,
  orgId = orgA,
): Promise<{ id: string; token: string }> {
  const res = await create(cookie, orgId);
  expect(res.status).toBe(201);
  return { id: res.body.id as string, token: res.body.token as string };
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${sql}`,
    params,
  );
  return result.rows[0]!.count;
}

const invitationCount = (orgId: string) =>
  count('invitations WHERE org_id = $1', [orgId]);
const membershipCount = () => count('memberships');

async function role(orgId: string, userId: string) {
  const result = await client.query<{ role: string }>(
    'SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2',
    [orgId, userId],
  );
  return result.rows[0]?.role;
}

async function expire(id: string): Promise<void> {
  await client.query(
    "UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1",
    [id],
  );
}

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  const user = (name: string, email: string) =>
    createUser(app, client, { email, password: PASSWORD, name });
  alice = await user('Alice', 'inv-alice@example.com');
  bob = await user('Bob', 'inv-bob@example.com');
  dave = await user('Dave', 'inv-dave@example.com');
  erin = await user('Erin', 'inv-erin@example.com');
  // Signs up with the address Alice means to invite, without the link.
  mallory = await user('Mallory', 'priya@example.com');
  orgA = await createOrg(app, alice.cookie, 'Invites Org A');
  orgB = await createOrg(app, dave.cookie, 'Invites Org B');
});

// Every test starts with no invitations and Erin as A's only staff member.
beforeEach(async () => {
  await client.query('DELETE FROM invitations');
  await client.query("DELETE FROM memberships WHERE role = 'staff'");
  await client.query(
    "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'staff')",
    [orgA, erin.id],
  );
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('401 and 403: the session and origin checks', () => {
  it('returns 401 without a cookie on all six routes, and nothing changes', async () => {
    const { id, token } = await newInvite();
    const before = await membershipCount();

    const answers = [
      await request(app)
        .post(`/api/orgs/${orgA}/invitations`)
        .set('Origin', TRUSTED_ORIGIN)
        .send({ label: 'x' }),
      await request(app).get(`/api/orgs/${orgA}/invitations`),
      await request(app)
        .delete(`/api/orgs/${orgA}/invitations/${id}`)
        .set('Origin', TRUSTED_ORIGIN),
      ...(await Promise.all(
        ['lookup', 'accept', 'decline'].map((action) =>
          request(app)
            .post(`/api/invitations/${action}`)
            .set('Origin', TRUSTED_ORIGIN)
            .send({ token }),
        ),
      )),
    ];
    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized' });
    }
    expect(await invitationCount(orgA)).toBe(1);
    expect(await membershipCount()).toBe(before);
  });

  // GET skips the origin check (it changes nothing), so five routes here.
  for (const origin of [undefined, EVIL_ORIGIN]) {
    it(`returns 403 on the five writes with Origin ${origin ?? 'missing'}, and nothing changes`, async () => {
      const { id, token } = await newInvite();
      const before = await membershipCount();

      const withOrigin = (req: request.Test) =>
        origin === undefined ? req : req.set('Origin', origin);
      const owner = (req: request.Test) => req.set('Cookie', alice.cookie);
      const invitee = (path: string) =>
        withOrigin(request(app).post(path).set('Cookie', bob.cookie)).send({
          token,
        });
      const answers = [
        await withOrigin(
          owner(request(app).post(`/api/orgs/${orgA}/invitations`)),
        ).send({ label: 'x' }),
        await withOrigin(
          owner(request(app).delete(`/api/orgs/${orgA}/invitations/${id}`)),
        ),
        await invitee('/api/invitations/lookup'),
        await invitee('/api/invitations/accept'),
        await invitee('/api/invitations/decline'),
      ];
      for (const res of answers) {
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Forbidden' });
      }
      expect(await invitationCount(orgA)).toBe(1);
      expect(await membershipCount()).toBe(before);
    });
  }
});

describe('create', () => {
  it('answers 201 with the secret once and stores only its SHA-256', async () => {
    const res = await create(alice.cookie, orgA, '  Priya, front desk  ');

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'label',
      'token',
    ]);
    expect(res.body.label).toBe('Priya, front desk');
    const token = res.body.token as string;
    expect(TOKEN_PATTERN.test(token)).toBe(true);

    const rows = await client.query(
      'SELECT * FROM invitations WHERE org_id = $1',
      [orgA],
    );
    expect(rows.rowCount).toBe(1);
    const row = rows.rows[0];
    expect(Buffer.isBuffer(row.token_hash)).toBe(true);
    expect(row.token_hash.length).toBe(32);
    expect(row.token_hash.equals(sha256(token))).toBe(true);
    // The secret itself is in no column, in any form we could print.
    const stored = JSON.stringify(row) + row.token_hash.toString('base64url');
    expect(stored.includes(token)).toBe(false);
  });

  it('makes the link last exactly 24 hours', async () => {
    const res = await create(alice.cookie, orgA);
    const lifetime =
      Date.parse(res.body.expiresAt) - Date.parse(res.body.createdAt);
    expect(lifetime).toBe(24 * 60 * 60 * 1000);
    const row = await client.query<{ seconds: number }>(
      'SELECT extract(epoch FROM expires_at - created_at)::int AS seconds FROM invitations WHERE id = $1',
      [res.body.id],
    );
    expect(row.rows[0]!.seconds).toBe(24 * 60 * 60);
  });

  it('gives every invitation its own secret', async () => {
    const first = await newInvite();
    const second = await newInvite();
    expect(first.token).not.toBe(second.token);
  });

  it('rejects a bad label with 400 and stores nothing', async () => {
    const cases: Array<[string, request.Test]> = [
      ['no body', post(`/api/orgs/${orgA}/invitations`, alice.cookie)],
      ['{}', post(`/api/orgs/${orgA}/invitations`, alice.cookie).send({})],
      ['empty', create(alice.cookie, orgA, '')],
      ['spaces', create(alice.cookie, orgA, '   ')],
      ['101 characters', create(alice.cookie, orgA, 'a'.repeat(101))],
      [
        'a number',
        post(`/api/orgs/${orgA}/invitations`, alice.cookie).send({ label: 7 }),
      ],
    ];
    for (const [label, req] of cases) {
      const res = await req;
      expect({ label, status: res.status, error: res.body.error }).toEqual({
        label,
        status: 400,
        error: 'Bad Request',
      });
    }
    expect(await invitationCount(orgA)).toBe(0);
  });
});

describe('role check: staff cannot create, list or cancel', () => {
  it('returns 403 to Erin on all three, and nothing changes', async () => {
    const { id } = await newInvite();
    const answers = [
      await create(erin.cookie, orgA),
      await list(erin.cookie, orgA),
      await cancel(erin.cookie, orgA, id),
    ];
    for (const res of answers) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
    }
    expect(await invitationCount(orgA)).toBe(1);
  });
});

describe('list', () => {
  it("shows the organization's pending invitations, newest first, four keys, no hash", async () => {
    await create(alice.cookie, orgA, 'First');
    const old = await newInvite();
    await expire(old.id);
    await create(alice.cookie, orgA, 'Second');
    await create(dave.cookie, orgB, 'In B');

    const res = await list(alice.cookie, orgA);
    expect(res.status).toBe(200);
    const rows = res.body as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.label)).toEqual(['Second', 'First']);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        'createdAt',
        'expiresAt',
        'id',
        'label',
      ]);
    }
  });
});

describe('cancel', () => {
  it('deletes the invitation with 204, after which its link is dead', async () => {
    const { id, token } = await newInvite();
    const res = await cancel(alice.cookie, orgA, id);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await invitationCount(orgA)).toBe(0);
    expect((await accept(bob.cookie, token)).status).toBe(404);
  });

  it('returns 404 for an unknown or malformed id', async () => {
    await newInvite();
    for (const id of ['999999', 'abc', '0']) {
      const res = await cancel(alice.cookie, orgA, id);
      expect({ id, status: res.status, body: res.body as unknown }).toEqual({
        id,
        status: 404,
        body: { error: 'Not found' },
      });
    }
    expect(await invitationCount(orgA)).toBe(1);
  });
});

describe('accept', () => {
  it('shows the organization first, then makes Bob staff and uses up the link', async () => {
    const { token } = await newInvite();

    // Looking does not use the link up.
    for (let i = 0; i < 2; i++) {
      const seen = await lookup(bob.cookie, token);
      expect(seen.status).toBe(200);
      expect(Object.keys(seen.body).sort()).toEqual(['expiresAt', 'orgName']);
      expect(seen.body.orgName).toBe('Invites Org A');
    }

    const res = await accept(bob.cookie, token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orgId: orgA,
      orgName: 'Invites Org A',
      role: 'staff',
    });
    expect(await role(orgA, bob.id)).toBe('staff');
    expect(await invitationCount(orgA)).toBe(0);

    const view = await request(app)
      .get(`/api/orgs/${orgA}`)
      .set('Cookie', bob.cookie);
    expect(view.status).toBe(200);
    expect(view.body.role).toBe('staff');

    const again = await accept(bob.cookie, token);
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ error: 'Not found' });
  });

  it('lets exactly one of two people accept one link at the same moment', async () => {
    const { token } = await newInvite();
    const answers = await Promise.all([
      accept(bob.cookie, token),
      accept(mallory.cookie, token),
    ]);
    expect(answers.map((res) => res.status).sort()).toEqual([200, 404]);
    expect(
      await count("memberships WHERE role = 'staff' AND user_id <> $1", [
        erin.id,
      ]),
    ).toBe(1);
  });

  it('answers 409 to someone already in the organization, and the link stays', async () => {
    const { token } = await newInvite();
    for (const user of [alice, erin]) {
      const res = await accept(user.cookie, token);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'Conflict' });
    }
    expect(await invitationCount(orgA)).toBe(1);
    expect(await role(orgA, alice.id)).toBe('owner');
    expect(await role(orgA, erin.id)).toBe('staff');
  });

  it('lets someone in two organizations join through a link to the second', async () => {
    const { token } = await newInvite(dave.cookie, orgB);
    const res = await accept(erin.cookie, token);
    expect(res.status).toBe(200);
    expect(await role(orgB, erin.id)).toBe('staff');
    expect(await role(orgA, erin.id)).toBe('staff');
  });
});

describe('decline', () => {
  it('answers 204, adds no one and uses up the link', async () => {
    const { token } = await newInvite();
    const before = await membershipCount();

    const res = await decline(bob.cookie, token);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await membershipCount()).toBe(before);
    expect(await invitationCount(orgA)).toBe(0);

    expect((await accept(bob.cookie, token)).status).toBe(404);
    expect((await decline(bob.cookie, token)).status).toBe(404);
  });
});

describe('a dead link', () => {
  it('gets the unknown-route 404 on lookup, accept and decline, whatever the reason', async () => {
    const unknownRoute = observed(
      await request(app).get('/api/does-not-exist').set('Cookie', bob.cookie),
    );
    expect(unknownRoute.status).toBe(404);

    // Created first and expired last: a create clears expired rows.
    const expired = await newInvite();
    const cancelled = await newInvite();
    await cancel(alice.cookie, orgA, cancelled.id);
    const used = await newInvite();
    await expire(expired.id);
    expect((await accept(bob.cookie, used.token)).status).toBe(200);
    await client.query('DELETE FROM memberships WHERE user_id = $1', [bob.id]);

    const tokens: Array<[string, unknown]> = [
      ['unknown', unknownToken()],
      ['expired', expired.token],
      ['cancelled', cancelled.token],
      ['used', used.token],
      ['42 characters', unknownToken().slice(0, 42)],
      ['44 characters', unknownToken() + 'A'],
      ['a plus sign', '+' + unknownToken().slice(1)],
      ['padding', unknownToken().slice(0, 42) + '='],
      ['a number', 42],
      ['missing', undefined],
    ];
    const before = await membershipCount();
    for (const [label, token] of tokens) {
      for (const send of [lookup, accept, decline]) {
        const res = observed(await send(bob.cookie, token));
        expect({ label, ...res }).toEqual({ label, ...unknownRoute });
      }
    }
    // Without any body at all, too.
    const empty = observed(await post('/api/invitations/accept', bob.cookie));
    expect(empty).toEqual(unknownRoute);

    expect(await membershipCount()).toBe(before);
    // The expired row is still there: only its owner's next create clears it.
    expect(await invitationCount(orgA)).toBe(1);
  });
});

describe('the email squatter', () => {
  it('gets nothing from signing up with the invited address; only the link works', async () => {
    const created = await create(alice.cookie, orgA, 'priya@example.com');
    const token = created.body.token as string;

    // Mallory signed up as priya@example.com but has no link.
    const orgs = await request(app)
      .get('/api/orgs')
      .set('Cookie', mallory.cookie);
    expect(orgs.body).toEqual([]);
    for (const send of [lookup, accept]) {
      expect((await send(mallory.cookie, unknownToken())).status).toBe(404);
    }
    expect(await role(orgA, mallory.id)).toBeUndefined();

    // The holder of the link joins, whatever their email.
    expect((await accept(bob.cookie, token)).status).toBe(200);
    expect(await role(orgA, bob.id)).toBe('staff');
    expect(await role(orgA, mallory.id)).toBeUndefined();
  });
});

describe('the cap of 20 pending invitations', () => {
  it('refuses the 21st with 409, counts only live ones, and clears expired ones', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await newInvite()).id);

    const full = await create(alice.cookie, orgA);
    expect(full.status).toBe(409);
    expect(full.body).toEqual({ error: 'Too many pending invitations' });
    expect(await invitationCount(orgA)).toBe(20);

    // B has its own count.
    expect((await create(dave.cookie, orgB)).status).toBe(201);

    for (const id of ids.slice(0, 5)) await expire(id);
    expect((await create(alice.cookie, orgA)).status).toBe(201);
    expect(
      await count('invitations WHERE org_id = $1 AND expires_at <= now()', [
        orgA,
      ]),
    ).toBe(0);
    expect(await invitationCount(orgA)).toBe(16);
  });
});

describe('isolation: Dave (owner of B) on organization A', () => {
  it('gets the unknown-route 404 on list, create and cancel, and A is unchanged', async () => {
    const { id } = await newInvite();
    const unknownRoute = observed(
      await request(app).get('/api/does-not-exist').set('Cookie', dave.cookie),
    );

    const attempts: Array<[string, () => request.Test]> = [
      ['list', () => list(dave.cookie, orgA)],
      ['create', () => create(dave.cookie, orgA)],
      ['cancel', () => cancel(dave.cookie, orgA, id)],
      ['Bob creating', () => create(bob.cookie, orgA)],
    ];
    for (const [label, attempt] of attempts) {
      const res = observed(await attempt());
      expect({ label, ...res }).toEqual({ label, ...unknownRoute });
    }
    expect(await invitationCount(orgA)).toBe(1);
  });

  it("can't cancel A's invitation through B, and B's list never shows it", async () => {
    const { id, token } = await newInvite();

    const res = await cancel(dave.cookie, orgB, id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(await invitationCount(orgA)).toBe(1);

    const listB = await list(dave.cookie, orgB);
    expect(listB.status).toBe(200);
    expect(listB.body).toEqual([]);

    // A's link still works.
    expect((await accept(bob.cookie, token)).status).toBe(200);
  });
});
