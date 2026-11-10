// Step 6b: organization routes through the real app on the test database
// (D-030). Covers the session check (401), our own origin check (403),
// create, list and view, tenant isolation (404), validation (400), the body
// limit (413) and that the session check never refreshes the session.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadAppOnTestDatabase,
  signIn,
  signUp,
  tokenFromSessionCookie,
} from './helpers/auth-app.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

const TRUSTED_ORIGIN = 'http://localhost:3000';
const EVIL_ORIGIN = 'https://evil.example';
// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'org-routes-pw-15chars';

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;

type TestUser = { id: string; email: string; cookie: string };
let alice: TestUser;
let bob: TestUser;
let carol: TestUser;

// Signs a user up and returns the session cookie from the sign-up response.
async function createUser(email: string, name: string): Promise<TestUser> {
  const cookie = await signUp(app, { email, password: PASSWORD, name });
  const row = await client.query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [email],
  );
  return { id: row.rows[0]!.id, email, cookie };
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

async function countOrganizations(): Promise<number> {
  const result = await client.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM organizations',
  );
  return result.rows[0]!.count;
}

async function sessionExpiresAt(token: string): Promise<Date | undefined> {
  const result = await client.query<{ expires_at: Date }>(
    'SELECT expires_at FROM sessions WHERE token = $1',
    [token],
  );
  return result.rows[0]?.expires_at;
}

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser('org-alice@example.com', 'Alice');
  bob = await createUser('org-bob@example.com', 'Bob');
  carol = await createUser('org-carol@example.com', 'Carol');
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('401: the session check', () => {
  it('returns 401 without a cookie on create, list and view', async () => {
    const orgId = await createOrg(alice.cookie, 'Alice 401 Org');

    const create = await request(app)
      .post('/api/orgs')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ name: 'No Cookie Org' });
    const list = await request(app).get('/api/orgs');
    const view = await request(app).get(`/api/orgs/${orgId}`);

    for (const res of [create, list, view]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized' });
    }
  });

  it('returns 401 for a cookie whose token has been tampered with', async () => {
    const cookie = await signIn(app, {
      email: alice.email,
      password: PASSWORD,
    });
    // Change the first character of the token part (just after "name=").
    const eq = cookie.indexOf('=');
    const first = cookie[eq + 1];
    const tampered =
      cookie.slice(0, eq + 1) +
      (first === 'a' ? 'b' : 'a') +
      cookie.slice(eq + 2);
    expect(tampered !== cookie).toBe(true);

    const res = await request(app).get('/api/orgs').set('Cookie', tampered);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 for a cookie from a signed-out session', async () => {
    const cookie = await signIn(app, {
      email: alice.email,
      password: PASSWORD,
    });
    const signOut = await request(app)
      .post('/api/auth/sign-out')
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', cookie);
    expect(signOut.status).toBe(200);

    const res = await request(app).get('/api/orgs').set('Cookie', cookie);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 for an expired session, and the library deletes its row', async () => {
    const cookie = await signIn(app, {
      email: alice.email,
      password: PASSWORD,
    });
    const token = tokenFromSessionCookie(cookie);
    await client.query(
      "UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE token = $1",
      [token],
    );

    const res = await request(app).get('/api/orgs').set('Cookie', cookie);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });

    const row = await client.query('SELECT 1 FROM sessions WHERE token = $1', [
      token,
    ]);
    expect(row.rowCount).toBe(0);
  });
});

describe('403: the origin check on our own routes', () => {
  const badOrigins: Array<[string, string | undefined]> = [
    ['missing', undefined],
    ['https://evil.example', EVIL_ORIGIN],
    ['http://localhost:3001', 'http://localhost:3001'],
    ['null', 'null'],
  ];

  for (const [label, origin] of badOrigins) {
    it(`rejects POST /api/orgs with Origin ${label} and adds no organization`, async () => {
      const before = await countOrganizations();
      let req = request(app).post('/api/orgs').set('Cookie', alice.cookie);
      if (origin !== undefined) {
        req = req.set('Origin', origin);
      }
      const res = await req.send({ name: 'Cross Origin Org' });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
      expect(await countOrganizations()).toBe(before);
    });
  }

  it('does not origin-check GET (positive control)', async () => {
    const res = await request(app)
      .get('/api/orgs')
      .set('Origin', EVIL_ORIGIN)
      .set('Cookie', alice.cookie);
    expect(res.status).toBe(200);
  });
});

describe('create, list and view', () => {
  it('creates an organization with Alice as owner, in the response and the database', async () => {
    const res = await request(app)
      .post('/api/orgs')
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', alice.cookie)
      .send({ name: 'Alice Clinic' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: res.body.id,
      name: 'Alice Clinic',
      role: 'owner',
    });
    expect(typeof res.body.id).toBe('string');
    expect(res.body.id).toMatch(/^[1-9][0-9]*$/);

    const org = await client.query<{ name: string }>(
      'SELECT name FROM organizations WHERE id = $1',
      [res.body.id],
    );
    expect(org.rows).toEqual([{ name: 'Alice Clinic' }]);
    const memberships = await client.query(
      'SELECT org_id, user_id, role FROM memberships WHERE org_id = $1',
      [res.body.id],
    );
    expect(memberships.rows).toEqual([
      { org_id: res.body.id, user_id: alice.id, role: 'owner' },
    ]);
  });

  it('stores and returns a trimmed name', async () => {
    const res = await request(app)
      .post('/api/orgs')
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', alice.cookie)
      .send({ name: '   Alice Annex  ' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Alice Annex');
    const org = await client.query<{ name: string }>(
      'SELECT name FROM organizations WHERE id = $1',
      [res.body.id],
    );
    expect(org.rows[0]!.name).toBe('Alice Annex');
  });

  it("lists Alice's organizations in ID order with role owner", async () => {
    const expected = await client.query<{ id: string; name: string }>(
      `SELECT o.id, o.name FROM organizations o
       JOIN memberships m ON m.org_id = o.id
       WHERE m.user_id = $1 ORDER BY o.id`,
      [alice.id],
    );
    expect(expected.rows.length >= 2).toBe(true);

    const res = await request(app).get('/api/orgs').set('Cookie', alice.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expected.rows.map((row) => ({ ...row, role: 'owner' })),
    );
    // ID order compared as numbers, not as text.
    const ids = (res.body as Array<{ id: string }>).map((org) =>
      BigInt(org.id),
    );
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('views one organization with the caller role', async () => {
    const orgId = await createOrg(alice.cookie, 'Alice View Org');
    const res = await request(app)
      .get(`/api/orgs/${orgId}`)
      .set('Cookie', alice.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: orgId,
      name: 'Alice View Org',
      role: 'owner',
    });
  });

  it('shows role staff to a staff member in list and view', async () => {
    const orgId = await createOrg(alice.cookie, 'Alice Staffed Org');
    await client.query(
      "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'staff')",
      [orgId, bob.id],
    );

    const list = await request(app).get('/api/orgs').set('Cookie', bob.cookie);
    expect(list.status).toBe(200);
    expect(list.body).toContainEqual({
      id: orgId,
      name: 'Alice Staffed Org',
      role: 'staff',
    });

    const view = await request(app)
      .get(`/api/orgs/${orgId}`)
      .set('Cookie', bob.cookie);
    expect(view.status).toBe(200);
    expect(view.body).toEqual({
      id: orgId,
      name: 'Alice Staffed Org',
      role: 'staff',
    });
  });
});

describe('isolation', () => {
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    orgA = await createOrg(alice.cookie, 'Isolation Org A');
    orgB = await createOrg(bob.cookie, 'Isolation Org B');
  });

  // Status, body and content-type: what a caller can observe.
  function observed(res: request.Response) {
    return {
      status: res.status,
      body: res.body as unknown,
      contentType: res.get('content-type'),
    };
  }

  it("gives Bob the same 404 on Alice's organization as on an unknown route and on every malformed ID", async () => {
    const onA = observed(
      await request(app).get(`/api/orgs/${orgA}`).set('Cookie', bob.cookie),
    );
    expect(onA.status).toBe(404);
    expect(onA.body).toEqual({ error: 'Not found' });

    const unknownRoute = observed(
      await request(app).get('/api/does-not-exist').set('Cookie', bob.cookie),
    );
    expect(unknownRoute).toEqual(onA);

    const otherIds = [
      '9223372036854775807',
      'abc',
      '0',
      '0123',
      '-1',
      '1.5',
      // These two would reach the query as out-of-range bigints and give a
      // database error (500) without the format check.
      '9223372036854775808',
      '99999999999999999999',
    ];
    for (const id of otherIds) {
      const res = observed(
        await request(app).get(`/api/orgs/${id}`).set('Cookie', bob.cookie),
      );
      expect({ id, ...res }).toEqual({ id, ...onA });
    }
  });

  it('lists B and not A for Bob, and nothing for Carol, who gets the same 404 on both', async () => {
    const bobList = await request(app)
      .get('/api/orgs')
      .set('Cookie', bob.cookie);
    expect(bobList.status).toBe(200);
    const bobIds = (bobList.body as Array<{ id: string }>).map((org) => org.id);
    expect(bobIds).toContain(orgB);
    expect(bobIds).not.toContain(orgA);

    const carolList = await request(app)
      .get('/api/orgs')
      .set('Cookie', carol.cookie);
    expect(carolList.status).toBe(200);
    expect(carolList.body).toEqual([]);

    const carolOnA = observed(
      await request(app).get(`/api/orgs/${orgA}`).set('Cookie', carol.cookie),
    );
    const carolOnB = observed(
      await request(app).get(`/api/orgs/${orgB}`).set('Cookie', carol.cookie),
    );
    expect(carolOnA.status).toBe(404);
    expect(carolOnA.body).toEqual({ error: 'Not found' });
    expect(carolOnB).toEqual(carolOnA);
  });
});

describe('400: body validation', () => {
  const postOrg = () =>
    request(app)
      .post('/api/orgs')
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', alice.cookie);

  function expectValidationError(res: request.Response): void {
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    const details = res.body.details as Array<{
      path: unknown;
      message: unknown;
    }>;
    expect(Array.isArray(details) && details.length > 0).toBe(true);
    for (const detail of details) {
      expect(typeof detail.path).toBe('string');
      expect(typeof detail.message).toBe('string');
    }
  }

  it('rejects no body, {}, a number, a blank name and 101 characters, adding no organization', async () => {
    const before = await countOrganizations();

    expectValidationError(await postOrg());
    expectValidationError(await postOrg().send({}));
    expectValidationError(await postOrg().send({ name: 42 }));
    expectValidationError(await postOrg().send({ name: '   ' }));
    const tooLong = await postOrg().send({ name: 'x'.repeat(101) });
    expectValidationError(tooLong);
    expect(tooLong.body.details[0].path).toBe('name');

    expect(await countOrganizations()).toBe(before);
  });

  it('accepts a 100-character name', async () => {
    const res = await postOrg().send({ name: 'x'.repeat(100) });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('x'.repeat(100));
  });
});

describe('413: the 10 KB body limit', () => {
  it('rejects an 11 KB body with 413, and a 9 KB body reaches validation (400)', async () => {
    const big = await request(app)
      .post('/api/orgs')
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', alice.cookie)
      .send({ name: 'x'.repeat(11 * 1024) });
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ error: 'Payload Too Large' });

    const underLimit = await request(app)
      .post('/api/orgs')
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', alice.cookie)
      .send({ name: 'x'.repeat(9 * 1024) });
    expect(underLimit.status).toBe(400);
    expect(underLimit.body.error).toBe('Bad Request');
  });
});

describe('read-only session check', () => {
  it('does not refresh a session inside the refresh window; /api/auth/get-session does (positive control)', async () => {
    const cookie = await signIn(app, {
      email: alice.email,
      password: PASSWORD,
    });
    const token = tokenFromSessionCookie(cookie);
    // Inside Better Auth's daily refresh window: with the default expiresIn of
    // 7 days and updateAge of 1 day, a session is refreshed once expires_at
    // is within 6 days of now (better-auth 1.7.18, dist/api/routes/session.mjs).
    await client.query(
      "UPDATE sessions SET expires_at = now() + interval '5 days' WHERE token = $1",
      [token],
    );
    const before = await sessionExpiresAt(token);
    expect(before !== undefined).toBe(true);

    const res = await request(app).get('/api/orgs').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'] === undefined).toBe(true);
    const afterOrgs = await sessionExpiresAt(token);
    expect(afterOrgs?.getTime()).toBe(before!.getTime());

    // Positive control: without it this test would prove nothing.
    const getSession = await request(app)
      .get('/api/auth/get-session')
      .set('Cookie', cookie);
    expect(getSession.status).toBe(200);
    const afterGetSession = await sessionExpiresAt(token);
    expect(afterGetSession!.getTime() > before!.getTime()).toBe(true);
  });
});
