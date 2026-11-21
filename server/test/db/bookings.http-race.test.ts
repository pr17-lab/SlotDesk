// Layer 2 HTTP race test (D-016, D-033).
//
// Sends 10 simultaneous requests to POST /api/orgs/:orgId/bookings, over 20
// rounds, through the real app on a real port. Two shapes:
//
// 1. Identical slot: all 10 ask for the same start. Exactly one gets 201 and
//    the other nine get 409. The bookings_no_overlap constraint decides.
//
// 2. Staggered: the starts are 15 minutes apart and the service lasts 60, so
//    each request overlaps its neighbours. Every answer must be 201 or 409,
//    never 5xx. This proves the resource-row lock in createBooking: without
//    it, overlapping inserts can deadlock (40P01), which becomes a 503
//    (D-033 D). Only this shape can catch a missing lock.
//
// One server and fetch instead of supertest, because supertest starts a new
// server per request. 10 requests, because the app's pool has 10 connections,
// so each request can hold its own (D-033).
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import {
  createOrg,
  createUser,
  loadAppOnTestDatabase,
} from './helpers/auth-app.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

const REQUESTS = 10;
const ROUNDS = 20;
const TRUSTED_ORIGIN = 'http://localhost:3000';
// 15+ characters, the minimum set in src/auth.ts. Never printed.
const PASSWORD = 'http-race-pw-15chars';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// The service length. Every booking lasts this long.
const DURATION = 60 * MINUTE;

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;
let server: Server;
let baseUrl: string;
let cookie: string;
let orgId: string;
let resourceId: string;
let serviceId: string;

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);

  const owner = await createUser(app, client, {
    email: 'http-race@example.com',
    password: PASSWORD,
    name: 'Race Owner',
  });
  cookie = owner.cookie;
  orgId = await createOrg(app, cookie, 'HTTP Race Org');

  // A UTC resource open all day, every day (weekdays 1 to 7, minutes 0 to
  // 1440), so every start in both tests is offered and the only reason
  // for a 409 is an overlap.
  const resource = await request(app)
    .post(`/api/orgs/${orgId}/resources`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie)
    .send({ name: 'Race Room', timeZone: 'UTC' });
  expect(resource.status).toBe(201);
  resourceId = resource.body.id as string;

  const windows = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    startMinute: 0,
    endMinute: 1440,
  }));
  const hours = await request(app)
    .put(`/api/orgs/${orgId}/resources/${resourceId}/working-hours`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie)
    .send({ windows });
  expect(hours.status).toBe(200);

  const service = await request(app)
    .post(`/api/orgs/${orgId}/services`)
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie)
    .send({ name: 'One hour', durationMinutes: 60 });
  expect(service.status).toBe(201);
  serviceId = service.body.id as string;

  // Port 0 lets the system pick a free port.
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

// Each test starts with no bookings, so its database checks see only its
// own rows.
afterEach(async () => {
  await client.query('DELETE FROM bookings');
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await truncateTables(client);
  await client.end();
  await pool.end();
});

type Answer = {
  startsAt: string;
  status: number;
  body: { id?: string; startsAt?: string; error?: string };
};

// Sends one booking request per start, all in one synchronous loop, and
// waits for every answer.
//
// It also checks that the requests really were in flight together: the
// last fetch call must happen before the first answer arrives. This guards
// against the test quietly sending one request at a time, which would still
// pass both tests. It measures when each fetch was called, not when the
// server received it.
async function fireRound(starts: string[]): Promise<Answer[]> {
  let lastSent = 0;
  let firstAnswered = Infinity;
  const requests = starts.map((startsAt) => {
    lastSent = performance.now();
    return fetch(`${baseUrl}/api/orgs/${orgId}/bookings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: TRUSTED_ORIGIN,
        cookie,
      },
      body: JSON.stringify({
        resourceId,
        serviceId,
        startsAt,
        customerName: 'Race Guest',
        customerEmail: 'race-guest@example.com',
      }),
    }).then(async (res) => {
      firstAnswered = Math.min(firstAnswered, performance.now());
      return { startsAt, status: res.status, body: await res.json() };
    });
  });
  const answers = await Promise.all(requests);
  expect(
    lastSent < firstAnswered,
    'An answer arrived before the last request was sent: the requests did not race',
  ).toBe(true);
  return answers;
}

// True if two bookings of DURATION starting at a and b overlap. The ranges
// are half-open, like the constraint: one ending at 10:00 and the next
// starting at 10:00 do not overlap.
function overlaps(a: string, b: string): boolean {
  const aStart = Date.parse(a);
  const bStart = Date.parse(b);
  return aStart < bStart + DURATION && bStart < aStart + DURATION;
}

// Confirmed booking IDs for the race resource, sorted, to compare with the
// IDs that the 201 answers returned.
async function confirmedIds(): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM bookings WHERE resource_id = $1 AND status = 'confirmed' ORDER BY id",
    [resourceId],
  );
  return result.rows.map((row) => row.id);
}

// Pairs of confirmed bookings on the same resource whose ranges overlap.
// Must always be 0.
async function overlappingPairs(): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM bookings a
       JOIN bookings b ON a.resource_id = b.resource_id
         AND a.id < b.id
         AND tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
      WHERE a.status = 'confirmed' AND b.status = 'confirmed'`,
  );
  return Number(result.rows[0]!.count);
}

// Status counts over a whole test, for the summary line.
function tally(answers: Answer[], counts: Record<number, number>): void {
  for (const answer of answers) {
    counts[answer.status] = (counts[answer.status] ?? 0) + 1;
  }
}

it('identical slot: exactly one 201 and nine 409s per round, over 20 rounds', async () => {
  // Rounds are one hour apart, so no two rounds overlap.
  const base = Date.parse('2099-01-05T00:00:00Z');
  const winnerIds: string[] = [];
  const counts: Record<number, number> = {};

  for (let round = 0; round < ROUNDS; round++) {
    const start = new Date(base + round * HOUR).toISOString();
    const answers = await fireRound(Array(REQUESTS).fill(start));
    tally(answers, counts);
    const statuses = JSON.stringify(answers.map((a) => a.status));

    const winners = answers.filter((a) => a.status === 201);
    const losers = answers.filter((a) => a.status === 409);
    expect(
      winners.length,
      `Round ${round}: expected exactly one 201. Statuses: ${statuses}`,
    ).toBe(1);
    expect(
      losers.length,
      `Round ${round}: expected nine 409s and nothing else. Statuses: ${statuses}`,
    ).toBe(REQUESTS - 1);
    for (const loser of losers) {
      expect(loser.body).toEqual({ error: 'Conflict' });
    }
    // The stored start is the requested instant (toISOString and the
    // response both use the .000Z form).
    expect(winners[0]!.body.startsAt).toBe(start);
    winnerIds.push(winners[0]!.body.id!);
  }

  // The database holds exactly the 20 bookings that got a 201, and no two
  // of them overlap.
  expect(await confirmedIds()).toEqual(
    [...winnerIds].sort((a, b) => Number(a) - Number(b)),
  );
  expect(await overlappingPairs()).toBe(0);

  // Deliberate test output only (the pino logger is silent under test).
  process.stdout.write(
    `[http-race] identical requests=${REQUESTS} rounds=${ROUNDS} statuses=${JSON.stringify(counts)}\n`,
  );
}, 60000);

it('staggered starts: only 201s and 409s, never a 5xx, over 20 rounds', async () => {
  // A different day from the identical-slot test. Rounds are four hours
  // apart; one round spans 3 hours 15 minutes (the last start is 135
  // minutes in and lasts 60), so no two rounds overlap and every round
  // fits in one day.
  const base = Date.parse('2099-02-02T00:00:00Z');
  const winnerIds: string[] = [];
  const counts: Record<number, number> = {};

  for (let round = 0; round < ROUNDS; round++) {
    const roundStart = base + round * 4 * HOUR;
    const starts = Array.from({ length: REQUESTS }, (_, i) =>
      new Date(roundStart + i * 15 * MINUTE).toISOString(),
    );
    const answers = await fireRound(starts);
    tally(answers, counts);
    const statuses = JSON.stringify(
      answers.map((a) => `${a.startsAt.slice(11, 16)} ${a.status}`),
    );

    // The lock proof: a 503 here means a deadlock, which the resource-row
    // lock exists to prevent.
    const unexpected = answers.filter(
      (a) => a.status !== 201 && a.status !== 409,
    );
    expect(
      unexpected.length,
      `Round ${round}: answers other than 201 or 409 (a 503 means a deadlock). Answers: ${statuses}`,
    ).toBe(0);

    const winners = answers.filter((a) => a.status === 201);
    const losers = answers.filter((a) => a.status === 409);

    // No two winners overlap.
    for (let i = 0; i < winners.length; i++) {
      for (let j = i + 1; j < winners.length; j++) {
        expect(
          overlaps(winners[i]!.startsAt, winners[j]!.startsAt),
          `Round ${round}: two overlapping 201s. Answers: ${statuses}`,
        ).toBe(false);
      }
    }

    // Every 409 lost to a real booking: it overlaps at least one winner of
    // this round.
    for (const loser of losers) {
      expect(loser.body).toEqual({ error: 'Conflict' });
      expect(
        winners.some((w) => overlaps(w.startsAt, loser.startsAt)),
        `Round ${round}: a 409 at ${loser.startsAt} overlaps no 201. Answers: ${statuses}`,
      ).toBe(true);
    }

    winnerIds.push(...winners.map((w) => w.body.id!));
  }

  // The database holds exactly the bookings that got a 201, and no two of
  // them overlap.
  expect(await confirmedIds()).toEqual(
    [...winnerIds].sort((a, b) => Number(a) - Number(b)),
  );
  expect(await overlappingPairs()).toBe(0);

  process.stdout.write(
    `[http-race] staggered requests=${REQUESTS} rounds=${ROUNDS} statuses=${JSON.stringify(counts)}\n`,
  );
}, 60000);
