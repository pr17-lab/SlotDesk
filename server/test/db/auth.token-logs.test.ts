// Step 5 checklist: the session token must never be logged, even when the
// database fails underneath a request (docs/trade-off-record.md 4.1, D-029).
//
// Two scenarios, each against a real signed-in session:
//   1. Query failure -- the sessions.token column is renamed out from under
//      a running app, so any query that reads it fails.
//   2. Connection failure -- the app's own pool is ended, so every query
//      rejects immediately.
// In both, GET /api/auth/get-session and POST /api/auth/sign-out are called
// with the valid cookie, and everything written to console, to the process
// streams, and to our pino logger during those two calls is scanned for the
// raw token.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  findSessionCookie,
  loadAppOnTestDatabase,
  tokenFromSessionCookie,
} from './helpers/auth-app.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';
import { logger } from '../../src/logger.js';

const TRUSTED_ORIGIN = 'http://localhost:3000';
const PASSWORD = 'token-logs-pw-15chars';

const { app, pool } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;
let poolEnded = false;

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  if (!poolEnded) {
    await pool.end();
  }
});

// Turns a captured console/stream/logger argument into searchable text,
// including an Error's message, stack and cause chain (requirement 22).
function toSearchableText(value: unknown): string {
  if (value instanceof Error) {
    const parts = [value.message, value.stack ?? ''];
    let cause: unknown = (value as { cause?: unknown }).cause;
    let guard = 0;
    while (cause !== undefined && guard < 5) {
      if (cause instanceof Error) {
        parts.push(cause.message, cause.stack ?? '');
        cause = (cause as { cause?: unknown }).cause;
      } else {
        parts.push(safeStringify(cause));
        break;
      }
      guard += 1;
    }
    return parts.join('\n');
  }
  if (typeof value === 'string') return value;
  return safeStringify(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) =>
      v instanceof Error ? { message: v.message, stack: v.stack } : v,
    );
  } catch {
    return String(value);
  }
}

// Spies on every console method, both process streams, and the pino logger,
// recording searchable text for each call while still letting real output
// through (so the test run's own reporting is unaffected).
function installCaptureSpies(captured: string[]): { restore: () => void } {
  // Restoring spies and forwarding to the ORIGINAL (pre-spy) function is
  // deliberate: it lets this file observe every call without silencing
  // Vitest's own console/stream output while the spies are active.
  const restores: Array<() => void> = [];

  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  for (const method of consoleMethods) {
    const original = console[method].bind(console);
    const spy = vi
      .spyOn(console, method)
      .mockImplementation((...args: unknown[]) => {
        for (const arg of args) captured.push(toSearchableText(arg));
        original(...args);
      });
    restores.push(() => spy.mockRestore());
  }

  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    // `write` is overloaded (chunk, [encoding], [callback]); forwarding a
    // generic argument list to it needs `any` -- there is no practical way
    // to type a pass-through proxy over every overload.
    const spy = vi
      .spyOn(stream, 'write')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((chunk: any, ...rest: any[]) => {
        captured.push(toSearchableText(chunk));
        return original(chunk, ...rest);
      });
    restores.push(() => spy.mockRestore());
  }

  const loggerLevels = [
    'trace',
    'debug',
    'info',
    'warn',
    'error',
    'fatal',
  ] as const;
  const loggerRecord = logger as unknown as Record<
    string,
    (...args: unknown[]) => void
  >;
  for (const level of loggerLevels) {
    if (typeof loggerRecord[level] !== 'function') continue;
    const spy = vi
      .spyOn(loggerRecord, level)
      .mockImplementation((...args: unknown[]) => {
        for (const arg of args) captured.push(toSearchableText(arg));
      });
    restores.push(() => spy.mockRestore());
  }

  return {
    restore: () => {
      for (const restore of restores) restore();
    },
  };
}

it('never logs the session token when the database fails underneath get-session or sign-out', async () => {
  const email = 'token-logs@example.com';
  await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD, name: 'Token Logs' });
  const signIn = await request(app)
    .post('/api/auth/sign-in/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD });
  const cookie = findSessionCookie(signIn.get('Set-Cookie') ?? []);
  expect(cookie !== undefined).toBe(true);
  const rawToken = tokenFromSessionCookie(cookie!);

  const captured: string[] = [];
  const spies = installCaptureSpies(captured);

  let scenario1: { getSessionStatus: number; signOutStatus: number };
  let scenario2: { getSessionStatus: number; signOutStatus: number };

  try {
    // Scenario 1: query failure. Rename the column with a SEPARATE client
    // (not the app's pool), then restore it in a finally block.
    await client.query(
      'ALTER TABLE sessions RENAME COLUMN token TO token_renamed',
    );
    const scenario1Start = captured.length;
    let getSessionRes: request.Response;
    let signOutRes: request.Response;
    try {
      getSessionRes = await request(app)
        .get('/api/auth/get-session')
        .set('Cookie', cookie!);
      signOutRes = await request(app)
        .post('/api/auth/sign-out')
        .set('Origin', TRUSTED_ORIGIN)
        .set('Cookie', cookie!);
    } finally {
      await client.query(
        'ALTER TABLE sessions RENAME COLUMN token_renamed TO token',
      );
    }
    scenario1 = {
      getSessionStatus: getSessionRes.status,
      signOutStatus: signOutRes.status,
    };
    expect(getSessionRes.status).not.toBe(200);
    expect(getSessionRes.text.includes(rawToken)).toBe(false);
    expect(signOutRes.text.includes(rawToken)).toBe(false);

    const scenario1Texts = captured.slice(scenario1Start);
    const scenario1TokenHits = scenario1Texts.filter((text) =>
      text.includes(rawToken),
    );
    expect(scenario1TokenHits.length).toBe(0);
    const scenario1BetterAuthLines = scenario1Texts.filter((text) =>
      text.includes('[Better Auth]'),
    ).length;

    // Scenario 2: connection failure. End the app's own pool, then make
    // the same two requests against it.
    const scenario2Start = captured.length;
    await pool.end();
    poolEnded = true;

    const getSessionRes2 = await request(app)
      .get('/api/auth/get-session')
      .set('Cookie', cookie!);
    const signOutRes2 = await request(app)
      .post('/api/auth/sign-out')
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', cookie!);
    scenario2 = {
      getSessionStatus: getSessionRes2.status,
      signOutStatus: signOutRes2.status,
    };
    expect(getSessionRes2.status).not.toBe(200);
    expect(getSessionRes2.text.includes(rawToken)).toBe(false);
    expect(signOutRes2.text.includes(rawToken)).toBe(false);

    const scenario2Texts = captured.slice(scenario2Start);
    const scenario2TokenHits = scenario2Texts.filter((text) =>
      text.includes(rawToken),
    );
    expect(scenario2TokenHits.length).toBe(0);
    const scenario2BetterAuthLines = scenario2Texts.filter((text) =>
      text.includes('[Better Auth]'),
    ).length;

    spies.restore();

    // Summary lines: counts only, per requirement 25. If either scenario
    // produced zero captured lines, Better Auth logged nothing for it --
    // requirement 26 says the test still passes, and that is recorded here.
    // process.stdout.write (not console.log) because Vitest's default
    // reporter only surfaces console output for failing tests; the other
    // database test files use the same pattern for their summary lines.
    process.stdout.write(
      `[token-logs] scenario 1 (query failure): lines=${scenario1Texts.length} ` +
        `betterAuthLines=${scenario1BetterAuthLines} ` +
        `getSessionStatus=${scenario1.getSessionStatus} signOutStatus=${scenario1.signOutStatus}\n`,
    );
    process.stdout.write(
      `[token-logs] scenario 2 (connection failure): lines=${scenario2Texts.length} ` +
        `betterAuthLines=${scenario2BetterAuthLines} ` +
        `getSessionStatus=${scenario2.getSessionStatus} signOutStatus=${scenario2.signOutStatus}\n`,
    );
  } finally {
    spies.restore();
  }
}, 15000);
