// The sample-data route through the real app on the test database. Covers
// what it creates, the "only on an empty organization" rule (409), who may
// call it (owner only; 404 for outsiders), validation (400), 10 requests at
// the same moment (exactly one set of rows), and rollback when a write fails.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const TRUSTED_ORIGIN = 'http://localhost:3000';
// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'sample-data-pw-15chars';
const REQUESTS = 10;
const ROUNDS = 5;

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;
let alice: TestUser; // owner
let bob: TestUser; // staff in Alice's first organization
let carol: TestUser; // in no organization
let staffOrg: string;

function postSampleData(cookie: string, orgId: string, body: object) {
  return request(app)
    .post(`/api/orgs/${orgId}/sample-data`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie)
    .send(body);
}

async function countFor(table: string, orgId: string): Promise<number> {
  const result = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM ${table} WHERE org_id = $1`,
    [orgId],
  );
  return Number(result.rows[0]!.n);
}

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser(app, client, {
    email: 'sample-alice@example.com',
    password: PASSWORD,
    name: 'Alice',
  });
  bob = await createUser(app, client, {
    email: 'sample-bob@example.com',
    password: PASSWORD,
    name: 'Bob',
  });
  carol = await createUser(app, client, {
    email: 'sample-carol@example.com',
    password: PASSWORD,
    name: 'Carol',
  });
  staffOrg = await createOrg(app, alice.cookie, 'Sample Staff Org');
  await client.query(
    "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'staff')",
    [staffOrg, bob.id],
  );
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('creating sample data', () => {
  it('creates a resource, a service and weekday hours, and returns them', async () => {
    const orgId = await createOrg(app, alice.cookie, 'Sample Happy Org');
    const res = await postSampleData(alice.cookie, orgId, {
      timeZone: 'asia/kolkata',
    });

    expect(res.status).toBe(201);
    expect(res.body.resource).toEqual({
      id: expect.any(String),
      name: 'Consultation room',
      timeZone: 'Asia/Kolkata',
    });
    expect(res.body.service).toEqual({
      id: expect.any(String),
      name: 'Consultation',
      durationMinutes: 30,
    });
    expect(res.body.windows).toEqual(
      [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        startMinute: 540,
        endMinute: 1020,
      })),
    );

    // The rows belong to this organization, and the other routes see them.
    expect(await countFor('resources', orgId)).toBe(1);
    expect(await countFor('services', orgId)).toBe(1);
    expect(await countFor('working_hours', orgId)).toBe(5);
    const hours = await request(app)
      .get(`/api/orgs/${orgId}/resources/${res.body.resource.id}/working-hours`)
      .set('Cookie', alice.cookie);
    expect(hours.body.windows).toEqual(res.body.windows);
  });

  it('answers 409 when the organization already has a resource', async () => {
    const orgId = await createOrg(app, alice.cookie, 'Sample Resource Org');
    const resource = await request(app)
      .post(`/api/orgs/${orgId}/resources`)
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', alice.cookie)
      .send({ name: 'Existing room', timeZone: 'UTC' });
    expect(resource.status).toBe(201);

    const res = await postSampleData(alice.cookie, orgId, { timeZone: 'UTC' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'This organization already has data' });
    expect(await countFor('resources', orgId)).toBe(1);
    expect(await countFor('services', orgId)).toBe(0);
  });

  it('answers 409 when the organization already has a service', async () => {
    const orgId = await createOrg(app, alice.cookie, 'Sample Service Org');
    const service = await request(app)
      .post(`/api/orgs/${orgId}/services`)
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', alice.cookie)
      .send({ name: 'Existing service', durationMinutes: 15 });
    expect(service.status).toBe(201);

    const res = await postSampleData(alice.cookie, orgId, { timeZone: 'UTC' });

    expect(res.status).toBe(409);
    expect(await countFor('resources', orgId)).toBe(0);
    expect(await countFor('services', orgId)).toBe(1);
  });

  it('answers 409 the second time', async () => {
    const orgId = await createOrg(app, alice.cookie, 'Sample Twice Org');
    const first = await postSampleData(alice.cookie, orgId, {
      timeZone: 'UTC',
    });
    const second = await postSampleData(alice.cookie, orgId, {
      timeZone: 'UTC',
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(await countFor('resources', orgId)).toBe(1);
  });
});

describe('who may call it', () => {
  it('answers 403 for staff and creates nothing', async () => {
    const res = await postSampleData(bob.cookie, staffOrg, { timeZone: 'UTC' });

    expect(res.status).toBe(403);
    expect(await countFor('resources', staffOrg)).toBe(0);
  });

  it('answers 404 for someone outside the organization', async () => {
    const res = await postSampleData(carol.cookie, staffOrg, {
      timeZone: 'UTC',
    });

    expect(res.status).toBe(404);
    expect(await countFor('resources', staffOrg)).toBe(0);
  });

  it('answers 401 without a session', async () => {
    const res = await request(app)
      .post(`/api/orgs/${staffOrg}/sample-data`)
      .set('Origin', TRUSTED_ORIGIN)
      .send({ timeZone: 'UTC' });

    expect(res.status).toBe(401);
  });
});

describe('validation', () => {
  it.each([
    ['an invalid time zone', { timeZone: 'Mars/Base' }],
    ['an offset instead of a zone', { timeZone: '+05:30' }],
    ['no time zone', {}],
    ['an unknown field', { timeZone: 'UTC', name: 'My room' }],
  ])('answers 400 for %s and creates nothing', async (_case, body) => {
    const orgId = await createOrg(app, alice.cookie, 'Sample Invalid Org');
    const res = await postSampleData(alice.cookie, orgId, body);

    expect(res.status).toBe(400);
    expect(await countFor('resources', orgId)).toBe(0);
    expect(await countFor('services', orgId)).toBe(0);
  });
});

describe('many requests at once', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // A real port and fetch, so the requests really run at the same time.
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it(`gives exactly one 201 and ${REQUESTS - 1} 409s, and one set of rows, in every round`, async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const orgId = await createOrg(app, alice.cookie, `Sample Race ${round}`);
      const answers = await Promise.all(
        Array.from({ length: REQUESTS }, () =>
          fetch(`${baseUrl}/api/orgs/${orgId}/sample-data`, {
            method: 'POST',
            headers: {
              Origin: TRUSTED_ORIGIN,
              Cookie: alice.cookie,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ timeZone: 'UTC' }),
          }).then((res) => res.status),
        ),
      );

      expect(answers.filter((status) => status === 201)).toHaveLength(1);
      expect(answers.filter((status) => status === 409)).toHaveLength(
        REQUESTS - 1,
      );
      expect(await countFor('resources', orgId)).toBe(1);
      expect(await countFor('services', orgId)).toBe(1);
      expect(await countFor('working_hours', orgId)).toBe(5);
    }
  });
});

describe('when a write fails', () => {
  it('rolls back the resource and the service if the working hours fail', async () => {
    const orgId = await createOrg(app, alice.cookie, 'Sample Rollback Org');
    // A test-only trigger makes every working_hours insert fail, so the
    // failure comes after the resource and the service were inserted.
    await client.query(`
      CREATE FUNCTION sample_data_test_fail() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END $$;
      CREATE TRIGGER sample_data_test_fail BEFORE INSERT ON working_hours
      FOR EACH ROW EXECUTE FUNCTION sample_data_test_fail();
    `);
    try {
      const res = await postSampleData(alice.cookie, orgId, {
        timeZone: 'UTC',
      });

      expect(res.status).toBe(500);
      expect(await countFor('resources', orgId)).toBe(0);
      expect(await countFor('services', orgId)).toBe(0);
      expect(await countFor('working_hours', orgId)).toBe(0);
    } finally {
      await client.query(`
        DROP TRIGGER sample_data_test_fail ON working_hours;
        DROP FUNCTION sample_data_test_fail();
      `);
    }

    // With the trigger gone, the same organization can still get its data.
    const retry = await postSampleData(alice.cookie, orgId, {
      timeZone: 'UTC',
    });
    expect(retry.status).toBe(201);
  });
});
