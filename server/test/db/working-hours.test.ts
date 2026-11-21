// Working-hours routes through the real app on the test database
// (D-032). Covers the session check (401), the origin check (403), GET, PUT
// (replaces the whole week), the owner-only role check (403), validation
// (400), unknown and malformed IDs (404), and isolation between
// organizations (404 identical to an unknown one).
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
const PASSWORD = 'working-hours-pw-15chars';
const START_BEFORE_END = 'startMinute must be before endMinute';
const NO_OVERLAP = 'Windows on the same weekday must not overlap';

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;

type Window = { weekday: number; startMinute: number; endMinute: number };
let alice: TestUser; // owner of org A
let bob: TestUser; // staff of org A
let carol: TestUser; // in no organization
let dave: TestUser; // owner of org B
let orgA: string;
let orgB: string;
let resourceA: string; // a resource of org A
let resourceB: string; // a resource of org B

async function createResource(
  cookie: string,
  orgId: string,
  name: string,
): Promise<string> {
  const res = await request(app)
    .post(`/api/orgs/${orgId}/resources`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie)
    .send({ name, timeZone: 'Europe/London' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

type Row = {
  id: string;
  org_id: string;
  resource_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
};

// Every working_hours row in the database, in id order: a snapshot to prove
// a rejected request changed nothing. The id is included, so even a replace
// with the same windows would show up as a change.
async function allRows(): Promise<Row[]> {
  const result = await client.query<Row>(
    `SELECT id, org_id, resource_id, weekday, start_minute, end_minute
     FROM working_hours ORDER BY id`,
  );
  return result.rows;
}

// The stored week of one resource, read directly, sorted like the API.
async function storedWeek(resourceId: string): Promise<Window[]> {
  const result = await client.query<Window>(
    `SELECT weekday, start_minute AS "startMinute", end_minute AS "endMinute"
     FROM working_hours WHERE resource_id = $1
     ORDER BY weekday, start_minute`,
    [resourceId],
  );
  return result.rows;
}

const path = (orgId: string, resourceId: string) =>
  `/api/orgs/${orgId}/resources/${resourceId}/working-hours`;

const get = (cookie: string, orgId: string, resourceId: string) =>
  request(app).get(path(orgId, resourceId)).set('Cookie', cookie);

const put = (cookie: string, orgId: string, resourceId: string) =>
  request(app)
    .put(path(orgId, resourceId))
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie);

const MONDAY_MORNING = { weekday: 1, startMinute: 540, endMinute: 780 };

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
  alice = await createUser(app, client, {
    email: 'wh-alice@example.com',
    password: PASSWORD,
    name: 'Alice',
  });
  bob = await createUser(app, client, {
    email: 'wh-bob@example.com',
    password: PASSWORD,
    name: 'Bob',
  });
  carol = await createUser(app, client, {
    email: 'wh-carol@example.com',
    password: PASSWORD,
    name: 'Carol',
  });
  dave = await createUser(app, client, {
    email: 'wh-dave@example.com',
    password: PASSWORD,
    name: 'Dave',
  });
  orgA = await createOrg(app, alice.cookie, 'Working Hours Org A');
  orgB = await createOrg(app, dave.cookie, 'Working Hours Org B');
  await client.query(
    "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'staff')",
    [orgA, bob.id],
  );
  resourceA = await createResource(alice.cookie, orgA, 'Chair A');
  resourceB = await createResource(dave.cookie, orgB, 'Chair B');
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

describe('401: the session check', () => {
  it('returns 401 without a cookie on GET and PUT', async () => {
    const responses = [
      await request(app).get(path(orgA, resourceA)),
      await request(app)
        .put(path(orgA, resourceA))
        .set('Origin', TRUSTED_ORIGIN)
        .send({ windows: [] }),
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

  it.each(badOrigins)(
    'rejects PUT with Origin %s, leaving the database unchanged',
    async (_label, origin) => {
      const before = await allRows();
      let req = request(app)
        .put(path(orgA, resourceA))
        .set('Cookie', alice.cookie);
      if (origin !== undefined) req = req.set('Origin', origin);
      const res = await req.send({ windows: [MONDAY_MORNING] });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
      expect(await allRows()).toEqual(before);
    },
  );

  it('lets GET work without an Origin header', async () => {
    const res = await get(alice.cookie, orgA, resourceA);
    expect(res.status).toBe(200);
  });
});

describe('GET and PUT', () => {
  it('returns { windows: [] } for a resource with no hours', async () => {
    const id = await createResource(alice.cookie, orgA, 'Empty');
    const res = await get(alice.cookie, orgA, id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ windows: [] });
  });

  it('returns windows sorted by weekday then startMinute, as numbers, on PUT and GET', async () => {
    const id = await createResource(alice.cookie, orgA, 'Sorted');
    // Deliberately out of order: Wednesday before Monday, and the Monday
    // afternoon before the Monday morning.
    const sent = [
      { weekday: 3, startMinute: 600, endMinute: 720 },
      { weekday: 1, startMinute: 840, endMinute: 1020 },
      { weekday: 1, startMinute: 540, endMinute: 780 },
    ];
    const expected = [
      { weekday: 1, startMinute: 540, endMinute: 780 },
      { weekday: 1, startMinute: 840, endMinute: 1020 },
      { weekday: 3, startMinute: 600, endMinute: 720 },
    ];

    const saved = await put(alice.cookie, orgA, id).send({ windows: sent });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ windows: expected });

    const read = await get(alice.cookie, orgA, id);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ windows: expected });
    for (const window of read.body.windows as Window[]) {
      expect(typeof window.weekday).toBe('number');
      expect(typeof window.startMinute).toBe('number');
      expect(typeof window.endMinute).toBe('number');
    }

    expect(await storedWeek(id)).toEqual(expected);
  });

  it('replaces the whole week, and [] empties it', async () => {
    const id = await createResource(alice.cookie, orgA, 'Replaced');
    const first = await put(alice.cookie, orgA, id).send({
      windows: [
        MONDAY_MORNING,
        { weekday: 2, startMinute: 540, endMinute: 780 },
      ],
    });
    expect(first.status).toBe(200);

    const secondWeek = [{ weekday: 5, startMinute: 600, endMinute: 900 }];
    const second = await put(alice.cookie, orgA, id).send({
      windows: secondWeek,
    });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ windows: secondWeek });
    expect(await storedWeek(id)).toEqual(secondWeek);

    const emptied = await put(alice.cookie, orgA, id).send({ windows: [] });
    expect(emptied.status).toBe(200);
    expect(emptied.body).toEqual({ windows: [] });
    expect(await storedWeek(id)).toEqual([]);
  });

  it('accepts touching windows (540 to 780 and 780 to 1020)', async () => {
    const id = await createResource(alice.cookie, orgA, 'Touching');
    const windows = [
      { weekday: 1, startMinute: 540, endMinute: 780 },
      { weekday: 1, startMinute: 780, endMinute: 1020 },
    ];
    const res = await put(alice.cookie, orgA, id).send({ windows });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ windows });
    expect(await storedWeek(id)).toEqual(windows);
  });
});

describe('role check: staff', () => {
  it('returns 403 to Bob on PUT, and the database is unchanged', async () => {
    const before = await allRows();
    const res = await put(bob.cookie, orgA, resourceA).send({
      windows: [MONDAY_MORNING],
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
    expect(await allRows()).toEqual(before);
  });

  it('lets Bob GET', async () => {
    const res = await get(bob.cookie, orgA, resourceA);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.windows)).toBe(true);
  });
});

describe('PUT validation (400)', () => {
  // 71 one-minute windows spread over the week, none overlapping: only the
  // max(70) limit can refuse them.
  const seventyOne = Array.from({ length: 71 }, (_, i) => ({
    weekday: (i % 7) + 1,
    startMinute: Math.floor(i / 7) * 10,
    endMinute: Math.floor(i / 7) * 10 + 1,
  }));

  // [label, body, path, message]. The message is checked wherever two cases
  // share a path ('', 'windows' and 'windows.0'), so each case proves its own
  // rule. The Zod messages are Zod 4.6.7's own text (an exact pin).
  const cases: Array<[string, unknown, string, string | undefined]> = [
    [
      'no body',
      undefined,
      '',
      'Invalid input: expected object, received undefined',
    ],
    ['{}', {}, 'windows', 'Invalid input: expected array, received undefined'],
    [
      'an unknown top-level key',
      { windows: [], extra: 1 },
      '',
      'Unrecognized key: "extra"',
    ],
    [
      'an unknown key inside a window',
      { windows: [{ ...MONDAY_MORNING, extra: 1 }] },
      'windows.0',
      'Unrecognized key: "extra"',
    ],
    [
      'weekday 0',
      { windows: [{ ...MONDAY_MORNING, weekday: 0 }] },
      'windows.0.weekday',
      undefined,
    ],
    [
      'weekday 8',
      { windows: [{ ...MONDAY_MORNING, weekday: 8 }] },
      'windows.0.weekday',
      undefined,
    ],
    [
      'startMinute -1',
      { windows: [{ ...MONDAY_MORNING, startMinute: -1 }] },
      'windows.0.startMinute',
      undefined,
    ],
    [
      'endMinute 1441',
      { windows: [{ ...MONDAY_MORNING, endMinute: 1441 }] },
      'windows.0.endMinute',
      undefined,
    ],
    // The case z.int() exists for: PostgreSQL would refuse 540.5 for an
    // integer column, which would be a 500.
    [
      'startMinute 540.5',
      { windows: [{ ...MONDAY_MORNING, startMinute: 540.5 }] },
      'windows.0.startMinute',
      undefined,
    ],
    [
      'start equal to end',
      { windows: [{ weekday: 1, startMinute: 600, endMinute: 600 }] },
      'windows.0',
      START_BEFORE_END,
    ],
    [
      'two overlapping Monday windows',
      {
        windows: [
          { weekday: 1, startMinute: 540, endMinute: 780 },
          { weekday: 1, startMinute: 779, endMinute: 1020 },
        ],
      },
      'windows',
      NO_OVERLAP,
    ],
    [
      '71 windows',
      { windows: seventyOne },
      'windows',
      'Too big: expected array to have <=70 items',
    ],
  ];

  it.each(cases)('rejects %s', async (_label, body, issuePath, message) => {
    const before = await allRows();
    const req = put(alice.cookie, orgA, resourceA);
    const res = await (body === undefined ? req : req.send(body as object));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.details[0].path).toBe(issuePath);
    if (message !== undefined) {
      expect(res.body.details[0].message).toBe(message);
    }
    expect(await allRows()).toEqual(before);
  });
});

describe('404: unknown and malformed resource IDs', () => {
  const badIds = [
    '999999',
    '0',
    '01',
    'abc',
    '1.5',
    '9223372036854775808',
    '-1',
  ];

  it.each(badIds)('returns 404 on GET for the ID %s', async (id) => {
    const res = await get(alice.cookie, orgA, id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it.each(badIds)('returns 404 on PUT for the ID %s', async (id) => {
    const res = await put(alice.cookie, orgA, id).send({
      windows: [MONDAY_MORNING],
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});

describe('isolation (D-030)', () => {
  const UNKNOWN = '999999';
  const weekA = [
    { weekday: 1, startMinute: 540, endMinute: 1020 },
    { weekday: 4, startMinute: 600, endMinute: 720 },
  ];
  const hijack = { windows: [{ weekday: 7, startMinute: 0, endMinute: 1440 }] };

  beforeAll(async () => {
    const res = await put(alice.cookie, orgA, resourceA).send({
      windows: weekA,
    });
    expect(res.status).toBe(200);
  });

  // Dave (a member of B only) and Carol (a member of nothing) must see on
  // organization A exactly what they see on an organization that does not
  // exist.
  it.each([
    ['dave', () => dave],
    ['carol', () => carol],
  ])(
    '%s on A gets the unknown-organization 404 on GET and PUT',
    async (_n, who) => {
      const user = who();
      const before = await allRows();

      const attempts = (orgId: string) => [
        get(user.cookie, orgId, resourceA),
        put(user.cookie, orgId, resourceA).send(hijack),
      ];
      const unknown = (await Promise.all(attempts(UNKNOWN))).map(observed);
      const onA = (await Promise.all(attempts(orgA))).map(observed);

      expect(unknown[0]!.status).toBe(404);
      expect(unknown[0]!.body).toEqual({ error: 'Not found' });
      expect(onA).toEqual(unknown);
      expect(await allRows()).toEqual(before);
      expect(await storedWeek(resourceA)).toEqual(weekA);
    },
  );

  // The D-030 failure scenario: a valid member of B uses B's URL with A's
  // resource ID. Without the org_id filter this would read or replace A's
  // week.
  it("dave on B's URL asking for A's resource gets the same 404 as a nonexistent ID", async () => {
    const before = await allRows();

    const getOther = observed(await get(dave.cookie, orgB, resourceA));
    const getMissing = observed(await get(dave.cookie, orgB, UNKNOWN));
    expect(getMissing.status).toBe(404);
    expect(getMissing.body).toEqual({ error: 'Not found' });
    expect(getOther).toEqual(getMissing);

    const putOther = observed(
      await put(dave.cookie, orgB, resourceA).send(hijack),
    );
    const putMissing = observed(
      await put(dave.cookie, orgB, UNKNOWN).send(hijack),
    );
    expect(putMissing.status).toBe(404);
    expect(putOther).toEqual(putMissing);

    // A's windows are unchanged, and B's resource got nothing.
    expect(await allRows()).toEqual(before);
    expect(await storedWeek(resourceA)).toEqual(weekA);
    expect(await storedWeek(resourceB)).toEqual([]);
  });
});
