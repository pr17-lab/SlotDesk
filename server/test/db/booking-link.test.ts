// Turning online booking on and off: PATCH /api/orgs/:orgId with a
// bookingSlug, through the real app on the test database. Covers who may
// change it (owner only), the format and trimming rules, a link another
// business has (409), and that clearing it closes the public page at once.
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
// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'booking-link-pw-15ch';

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;
let alice: TestUser; // owner of org A
let bob: TestUser; // staff of org A
let carol: TestUser; // in no organization
let dave: TestUser; // owner of org B
let orgA: string;
let orgB: string;

const patch = (cookie: string, orgId: string, body: unknown) =>
  request(app)
    .patch(`/api/orgs/${orgId}`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie)
    .send(body as object);

const storedSlug = async (orgId: string): Promise<string | null> => {
  const row = await client.query<{ booking_slug: string | null }>(
    'SELECT booking_slug FROM organizations WHERE id = $1',
    [orgId],
  );
  return row.rows[0]!.booking_slug;
};

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser(app, client, {
    email: 'link-alice@example.com',
    password: PASSWORD,
    name: 'Alice',
  });
  bob = await createUser(app, client, {
    email: 'link-bob@example.com',
    password: PASSWORD,
    name: 'Bob',
  });
  carol = await createUser(app, client, {
    email: 'link-carol@example.com',
    password: PASSWORD,
    name: 'Carol',
  });
  dave = await createUser(app, client, {
    email: 'link-dave@example.com',
    password: PASSWORD,
    name: 'Dave',
  });
  orgA = await createOrg(app, alice.cookie, 'Sunrise Physio');
  orgB = await createOrg(app, dave.cookie, 'Other Clinic');
  await client.query(
    "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'staff')",
    [orgA, bob.id],
  );
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('setting the link', () => {
  it('lets the owner set it, and answers with the organization', async () => {
    const res = await patch(alice.cookie, orgA, {
      bookingSlug: 'sunrise-physio',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: orgA,
      name: 'Sunrise Physio',
      role: 'owner',
      bookingSlug: 'sunrise-physio',
    });
    expect(await storedSlug(orgA)).toBe('sunrise-physio');
  });

  it('trims and lowercases what the owner typed', async () => {
    const res = await patch(alice.cookie, orgA, {
      bookingSlug: '  Sunrise-Physio-2 ',
    });
    expect(res.status).toBe(200);
    expect(res.body.bookingSlug).toBe('sunrise-physio-2');
    expect(await storedSlug(orgA)).toBe('sunrise-physio-2');
  });

  it('shows the link to every member when they view the organization', async () => {
    await patch(alice.cookie, orgA, { bookingSlug: 'sunrise-physio' });
    const view = await request(app)
      .get(`/api/orgs/${orgA}`)
      .set('Cookie', bob.cookie);
    expect(view.status).toBe(200);
    expect(view.body).toEqual({
      id: orgA,
      name: 'Sunrise Physio',
      role: 'staff',
      bookingSlug: 'sunrise-physio',
    });
  });

  it('turns the public page off with null, on the next request', async () => {
    await patch(alice.cookie, orgA, { bookingSlug: 'sunrise-physio' });
    expect((await request(app).get('/api/public/sunrise-physio')).status).toBe(
      200,
    );

    const res = await patch(alice.cookie, orgA, { bookingSlug: null });
    expect(res.status).toBe(200);
    expect(res.body.bookingSlug).toBeNull();
    expect(await storedSlug(orgA)).toBeNull();

    const after = await request(app).get('/api/public/sunrise-physio');
    expect(observed(after)).toEqual(
      observed(await request(app).get('/api/public/no-such-business')),
    );
    expect(after.status).toBe(404);
  });
});

describe('who may change it', () => {
  it('refuses a staff member with 403 and changes nothing', async () => {
    await patch(alice.cookie, orgA, { bookingSlug: 'sunrise-physio' });
    const res = await patch(bob.cookie, orgA, { bookingSlug: 'taken-over' });
    expect(res.status).toBe(403);
    expect(await storedSlug(orgA)).toBe('sunrise-physio');
  });

  it('answers 404 to someone outside the organization', async () => {
    const outsider = await patch(carol.cookie, orgA, { bookingSlug: 'mine' });
    const otherOwner = await patch(dave.cookie, orgA, { bookingSlug: 'mine' });
    expect(outsider.status).toBe(404);
    expect(otherOwner.status).toBe(404);
    expect(outsider.body).toEqual({ error: 'Not found' });
  });

  it('answers 401 without a session and 403 without the Origin header', async () => {
    const noSession = await request(app)
      .patch(`/api/orgs/${orgA}`)
      .set('Origin', TRUSTED_ORIGIN)
      .send({ bookingSlug: 'mine' });
    const noOrigin = await request(app)
      .patch(`/api/orgs/${orgA}`)
      .set('Cookie', alice.cookie)
      .send({ bookingSlug: 'mine' });
    expect(noSession.status).toBe(401);
    expect(noOrigin.status).toBe(403);
  });
});

describe('a link another business has', () => {
  it('answers 409, even when typed in other capitals', async () => {
    expect(
      (await patch(alice.cookie, orgA, { bookingSlug: 'sunrise-physio' }))
        .status,
    ).toBe(200);
    const res = await patch(dave.cookie, orgB, {
      bookingSlug: 'Sunrise-Physio',
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Conflict' });
    expect(await storedSlug(orgB)).toBeNull();
  });

  it('lets the owner save the link they already have', async () => {
    await patch(alice.cookie, orgA, { bookingSlug: 'sunrise-physio' });
    const res = await patch(alice.cookie, orgA, {
      bookingSlug: 'sunrise-physio',
    });
    expect(res.status).toBe(200);
  });
});

describe('400: validation', () => {
  it.each([
    ['too short', { bookingSlug: 'ab' }, 'bookingSlug'],
    ['too long', { bookingSlug: 'a'.repeat(41) }, 'bookingSlug'],
    ['a leading hyphen', { bookingSlug: '-abc' }, 'bookingSlug'],
    ['a space inside', { bookingSlug: 'sun rise' }, 'bookingSlug'],
    ['a slash', { bookingSlug: 'a/b/c' }, 'bookingSlug'],
    ['a number', { bookingSlug: 123 }, 'bookingSlug'],
    ['a missing key', {}, 'bookingSlug'],
    ['an unknown key', { bookingSlug: 'abc', name: 'x' }, ''],
  ])('refuses %s', async (_label, body, path) => {
    await patch(alice.cookie, orgA, { bookingSlug: 'sunrise-physio' });
    const res = await patch(alice.cookie, orgA, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.details[0].path).toBe(path);
    expect(await storedSlug(orgA)).toBe('sunrise-physio');
  });

  it('says what a link may contain', async () => {
    const res = await patch(alice.cookie, orgA, { bookingSlug: 'ab' });
    expect(res.body.details).toEqual([
      {
        path: 'bookingSlug',
        message:
          'Use 3 to 40 letters, digits or hyphens, starting and ending with a letter or digit',
      },
    ]);
  });
});
