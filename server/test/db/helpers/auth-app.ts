// Shared helper for database-integration test files that exercise the real
// app through Better Auth (Step 5c, D-029).
//
// Why the dynamic import: the app's pool in src/db.ts reads DATABASE_URL at
// import time, which otherwise points at the development database. We must
// point DATABASE_URL at the test database BEFORE the app (and therefore
// db.ts and auth.ts) is loaded. Vitest gives each test file a fresh module
// registry, so this does not leak into other files.
import pg from 'pg';
import { requireTestDatabase } from './db-guard.js';

export type AppUnderTest = {
  app: Awaited<ReturnType<typeof loadApp>>['app'];
  pool: Awaited<ReturnType<typeof loadApp>>['pool'];
  auth: Awaited<ReturnType<typeof loadApp>>['auth'];
};

async function loadApp() {
  const { app } = await import('../../../src/app.js');
  const { pool } = await import('../../../src/db.js');
  const { auth } = await import('../../../src/auth.js');
  return { app, pool, auth };
}

// Does exactly what auth.smoke.test.ts did before this helper existed:
// guard on TEST_DATABASE_URL, point DATABASE_URL at it, load the app, then
// refuse to continue unless the app's own pool reports a _test database.
// Call this with top-level await so a failed check stops the whole file
// before any test runs.
export async function loadAppOnTestDatabase(): Promise<AppUnderTest> {
  const { url } = requireTestDatabase();

  process.env.DATABASE_URL = url;
  const { app, pool, auth } = await loadApp();

  const live = await pool.query<{ current_database: string }>(
    'select current_database()',
  );
  const liveDbName = live.rows[0]?.current_database ?? '';
  if (!liveDbName.endsWith('_test')) {
    await pool.end();
    throw new Error(
      `The app's pool is connected to "${liveDbName}", which does not end in _test. ` +
        'Refusing to run against a non-test database.',
    );
  }

  return { app, pool, auth };
}

const SESSION_COOKIE_NAME = 'better-auth.session_token';

// Finds the session cookie among a response's Set-Cookie entries and returns
// only the "name=value" part (no attributes), ready for a `Cookie` header.
export function findSessionCookie(setCookie: string[]): string | undefined {
  return setCookie
    .find((entry) => entry.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.split(';')[0];
}

// Extracts the raw token from a session cookie's "name=value" part. The
// value is URL-encoded `<token>.<signature>` (confirmed against the
// installed better-call cookie signing code, which also splits on the last
// "."). Never log the return value.
export function tokenFromSessionCookie(sessionCookie: string): string {
  const eq = sessionCookie.indexOf('=');
  const decoded = decodeURIComponent(sessionCookie.slice(eq + 1));
  const dot = decoded.lastIndexOf('.');
  if (dot < 1) {
    throw new Error('Session cookie value is not in <token>.<signature> form.');
  }
  return decoded.slice(0, dot);
}

// The cookie's name only, from one Set-Cookie entry (never its value).
export function cookieName(setCookieEntry: string): string {
  return setCookieEntry.slice(0, setCookieEntry.indexOf('='));
}

// The attribute names on one Set-Cookie entry, lower-cased, never the
// cookie's value.
export function cookieAttributeNames(setCookieEntry: string): string[] {
  return setCookieEntry
    .split(';')
    .slice(1)
    .map((part) => part.trim().split('=')[0]!.toLowerCase())
    .filter((name) => name.length > 0);
}

// Row count for one identity table. The table name is always one of our own
// literal constants below, never request input, so string interpolation is
// safe here.
export async function countRows(
  client: pg.Client,
  table: 'users' | 'sessions' | 'accounts' | 'verifications',
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::int AS count FROM ${table}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

export type IdentityCounts = {
  users: number;
  sessions: number;
  accounts: number;
  verifications: number;
};

export async function countIdentityTables(
  client: pg.Client,
): Promise<IdentityCounts> {
  return {
    users: await countRows(client, 'users'),
    sessions: await countRows(client, 'sessions'),
    accounts: await countRows(client, 'accounts'),
    verifications: await countRows(client, 'verifications'),
  };
}
