// Step 5 authentication checklist tests (docs/trade-off-record.md 4.1, D-029).
//
// Covers checklist items 2, 3, 5, 8, 9 and the http part of item 4, plus the
// password-reset routes and the password length limits. Item 1 was covered
// in auth.smoke.test.ts (Step 5b). Items 6, 7 and 10 are out of scope here
// (deferred to Step 7 / Week 4 per the trade-off record's update note).
//
// Cross-origin findings (checklist item 5), read from the installed
// better-auth@1.7.18 source:
//
//   node_modules/better-auth/dist/api/middlewares/origin-check.mjs
//     - `originCheckMiddleware` is mounted globally on every route (path
//       "/**" in node_modules/better-auth/dist/api/index.mjs). For any
//       non-GET/OPTIONS/HEAD request it calls `validateOrigin`, which:
//         * returns immediately (no check) if the request has neither a
//           `Cookie` header nor `forceValidate` -- so a first sign-up/sign-in
//           with no cookie is never origin-checked here;
//         * otherwise requires `Origin` (falling back to `Referer`) to be
//           present and to match `trustedOrigins`, else throws FORBIDDEN
//           with code MISSING_OR_NULL_ORIGIN (no origin/referer) or
//           INVALID_ORIGIN (present but not trusted).
//     - `formCsrfMiddleware` is additionally mounted on sign-up/email and
//       sign-in/email (the routes with no cookie to anchor a check). With no
//       `Cookie` header it reads `Sec-Fetch-Site`/`Mode`/`Dest`: a
//       cross-site + navigate combination is rejected immediately with
//       CROSS_SITE_NAVIGATION_LOGIN_BLOCKED; any other Fetch-Metadata value,
//       or a bare Origin/Referer with no Fetch-Metadata at all, forces the
//       same validateOrigin check (so an untrusted Origin on a cookie-less
//       sign-in is also rejected: "login CSRF").
//     - Default `trustedOrigins` is exactly the origin of BETTER_AUTH_URL
//       (node_modules/better-auth/dist/context/helpers.mjs,
//       getTrustedOrigins) -- http://localhost:3000 here, per
//       vitest.db.config.ts. auth.ts sets no `trustedOrigins` option.
//
// Reset-password routes in core 1.7.18 (no organization/SSO/etc. plugins
// installed), all in node_modules/better-auth/dist/api/routes/password.mjs:
//   - POST /request-password-reset
//   - GET  /reset-password/:token   (redirect-based callback)
//   - POST /reset-password
// There is no "forget-password" alias in this version's core. All three are
// exercised below; auth.ts configures no `sendResetPassword`, so D-029's "no
// reset in the MVP" holds and the request route always answers 400.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
// Type-only: auth.options is typed as the literal object passed to
// betterAuth() in src/auth.ts, which omits plugins/secondaryStorage/cookie
// cache entirely (absent, not merely undefined), so TypeScript rejects
// reading them off it directly. BetterAuthOptions (confirmed present in
// node_modules/@better-auth/core/dist/types/init-options.d.mts, a
// dependency of the installed better-auth package) is the full options
// shape and lets this test check that those fields are genuinely absent.
import type { BetterAuthOptions } from '@better-auth/core';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  cookieAttributeNames,
  cookieName,
  countIdentityTables,
  findSessionCookie,
  loadAppOnTestDatabase,
  tokenFromSessionCookie,
} from './helpers/auth-app.js';
import {
  connectAndVerify,
  requireTestDatabase,
  truncateTables,
} from './helpers/db-guard.js';

// The test base URL a browser on this origin would send (vitest.db.config.ts
// sets BETTER_AUTH_URL to the same value, which is also the library's
// default trustedOrigins entry).
const TRUSTED_ORIGIN = 'http://localhost:3000';
const EVIL_ORIGIN = 'https://evil.example';

// Every password below is 15+ characters, the minimum set in src/auth.ts.
// Never printed by this file.
const PASSWORD = 'checklist-pw-15chars';

// Better Auth auto-disables origin/CSRF checking whenever it detects a test
// runner: `skipOriginCheck` defaults to `isTest() ? true : false` unless
// auth.ts sets `advanced.disableOriginCheck` explicitly, which it does not
// (node_modules/@better-auth/core/dist/context/create-context.mjs:211).
// `isTest()` is `NODE_ENV === "test" || toBoolean(process.env.TEST)`
// (node_modules/@better-auth/core/dist/env/env-impl.mjs:36). Vitest sets
// NODE_ENV=test AND process.env.TEST=true by default, which would make
// checklist item 5 (a cross-origin request is rejected) silently pass
// through instead of being rejected -- not because production is insecure
// (isTest() is false there), but because this test-mode bypass is baked
// into the library. Checklist item 5 is about production behaviour, so
// this file loads its app instance with both overridden: NODE_ENV to
// "development" (also satisfies src/config.ts's schema, whose https-only
// rule only applies to "production") and TEST deleted. This changes
// nothing in src/, the migrations, the Vitest configs or package.json --
// only this file's own process.env, before the app is imported. Each
// Vitest-isolated test file runs in its own worker process, so this does
// not leak into other files.
process.env.NODE_ENV = 'development';
delete process.env.TEST;

const { app, pool, auth } = await loadAppOnTestDatabase();
const { createClient } = requireTestDatabase();

let client: pg.Client;

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
});

afterAll(async () => {
  await truncateTables(client);
  await client.end();
  await pool.end();
});

// --- Item 2: sessions live in our database; logout deletes server-side ---

it('creates a sessions row at sign-in with expires_at about 7 days ahead', async () => {
  const email = 'checklist-session-row@example.com';
  await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD, name: 'Session Row' });

  const signIn = await request(app)
    .post('/api/auth/sign-in/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD });
  expect(signIn.status).toBe(200);
  const cookie = findSessionCookie(signIn.get('Set-Cookie') ?? []);
  expect(cookie !== undefined).toBe(true);
  const token = tokenFromSessionCookie(cookie!);

  const row = await client.query<{ expires_at: Date }>(
    'SELECT expires_at FROM sessions WHERE token = $1',
    [token],
  );
  expect(row.rowCount).toBe(1);

  const expected = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const diffMinutes =
    Math.abs(row.rows[0]!.expires_at.getTime() - expected) / 60000;
  expect(diffMinutes <= 5).toBe(true);
});

it('logout deletes only the signed-out session, leaving the other session valid', async () => {
  const email = 'checklist-logout@example.com';
  await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD, name: 'Logout' });

  const signInA = await request(app)
    .post('/api/auth/sign-in/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD });
  const cookieA = findSessionCookie(signInA.get('Set-Cookie') ?? []);
  const signInB = await request(app)
    .post('/api/auth/sign-in/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD });
  const cookieB = findSessionCookie(signInB.get('Set-Cookie') ?? []);
  expect(cookieA !== undefined && cookieB !== undefined).toBe(true);
  const tokenA = tokenFromSessionCookie(cookieA!);
  const tokenB = tokenFromSessionCookie(cookieB!);

  const before = await client.query(
    'SELECT 1 FROM sessions WHERE token = ANY($1)',
    [[tokenA, tokenB]],
  );
  expect(before.rowCount).toBe(2);

  const signOutA = await request(app)
    .post('/api/auth/sign-out')
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookieA!);
  expect(signOutA.status).toBe(200);

  const rowA = await client.query('SELECT 1 FROM sessions WHERE token = $1', [
    tokenA,
  ]);
  expect(rowA.rowCount).toBe(0);
  const rowB = await client.query('SELECT 1 FROM sessions WHERE token = $1', [
    tokenB,
  ]);
  expect(rowB.rowCount).toBe(1);

  const getSessionA = await request(app)
    .get('/api/auth/get-session')
    .set('Cookie', cookieA!);
  expect(getSessionA.status).toBe(200);
  expect(getSessionA.body).toBeNull();

  const getSessionB = await request(app)
    .get('/api/auth/get-session')
    .set('Cookie', cookieB!);
  expect(getSessionB.status).toBe(200);
  expect(getSessionB.body?.user?.email).toBe(email);
});

// --- Item 3: token storage (D-029 accepted risk A) ---

// A failure in this test means the library changed how it stores session
// tokens. If it ever fails, D-029's "accepted risk: plain-text tokens" must
// be re-evaluated before relying on it again.
it('documents plain-text session token storage (D-029 accepted risk A)', async () => {
  const email = 'checklist-token-storage@example.com';
  await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD, name: 'Token Storage' });
  const signIn = await request(app)
    .post('/api/auth/sign-in/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD });
  const cookie = findSessionCookie(signIn.get('Set-Cookie') ?? []);
  expect(cookie !== undefined).toBe(true);
  const cookieToken = tokenFromSessionCookie(cookie!);
  expect(cookieToken.length).toBe(32);

  const row = await client.query<{ token: string }>(
    'SELECT token FROM sessions WHERE token = $1',
    [cookieToken],
  );
  expect(row.rowCount).toBe(1);
  expect(cookieToken === row.rows[0]!.token).toBe(true);
});

// --- Item 4 (http part): cookie attributes ---

it('sets exactly one HttpOnly, SameSite=Lax, Path=/ session cookie without Secure or a cookie-cache cookie', async () => {
  const email = 'checklist-cookie-attrs@example.com';
  await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD, name: 'Cookie Attrs' });
  const signIn = await request(app)
    .post('/api/auth/sign-in/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD });
  expect(signIn.status).toBe(200);

  const setCookie = signIn.get('Set-Cookie') ?? [];
  expect(setCookie.length).toBe(1);
  const entry = setCookie[0]!;
  expect(cookieName(entry)).toBe('better-auth.session_token');
  const attrs = cookieAttributeNames(entry);
  expect(attrs.includes('httponly')).toBe(true);
  expect(attrs.includes('secure')).toBe(false);
  expect(attrs.includes('path')).toBe(true);
  expect(entry.toLowerCase().includes('samesite=lax')).toBe(true);
  expect(
    setCookie.some((c) => cookieName(c) === 'better-auth.session_data'),
  ).toBe(false);
});

// --- Item 5: cross-origin requests ---

it('rejects cross-origin sign-out and update-user with a valid cookie, then the same requests succeed from the trusted origin (positive control)', async () => {
  const email = 'checklist-cross-origin@example.com';
  await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD, name: 'Original Name' });
  const signIn = await request(app)
    .post('/api/auth/sign-in/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD });
  const cookie = findSessionCookie(signIn.get('Set-Cookie') ?? []);
  expect(cookie !== undefined).toBe(true);
  const token = tokenFromSessionCookie(cookie!);

  // Evil origin: update-user rejected, name unchanged.
  const evilUpdate = await request(app)
    .post('/api/auth/update-user')
    .set('Origin', EVIL_ORIGIN)
    .set('Cookie', cookie!)
    .send({ name: 'Hacked Name' });
  // STOP condition (checklist requirement 13): if this is not a 4xx, the
  // cross-origin check has failed and D-029 must be re-evaluated before
  // adopting the library.
  expect(evilUpdate.status >= 400 && evilUpdate.status < 500).toBe(true);
  const nameAfterEvil = await client.query<{ name: string }>(
    'SELECT name FROM users WHERE email = $1',
    [email],
  );
  expect(nameAfterEvil.rows[0]!.name).toBe('Original Name');

  // Evil origin: sign-out rejected, session row still exists.
  const evilSignOut = await request(app)
    .post('/api/auth/sign-out')
    .set('Origin', EVIL_ORIGIN)
    .set('Cookie', cookie!);
  expect(evilSignOut.status >= 400 && evilSignOut.status < 500).toBe(true);
  const sessionStillThere = await client.query(
    'SELECT 1 FROM sessions WHERE token = $1',
    [token],
  );
  expect(sessionStillThere.rowCount).toBe(1);

  // Positive control, trusted origin: update-user succeeds.
  const trustedUpdate = await request(app)
    .post('/api/auth/update-user')
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie!)
    .send({ name: 'Renamed' });
  expect(trustedUpdate.status).toBe(200);
  const nameAfterTrusted = await client.query<{ name: string }>(
    'SELECT name FROM users WHERE email = $1',
    [email],
  );
  expect(nameAfterTrusted.rows[0]!.name).toBe('Renamed');

  // Positive control, trusted origin: sign-out succeeds and removes the row.
  const trustedSignOut = await request(app)
    .post('/api/auth/sign-out')
    .set('Origin', TRUSTED_ORIGIN)
    .set('Cookie', cookie!);
  expect(trustedSignOut.status).toBe(200);
  const sessionGone = await client.query(
    'SELECT 1 FROM sessions WHERE token = $1',
    [token],
  );
  expect(sessionGone.rowCount).toBe(0);
});

it('rejects a cookie-bearing POST with no Origin or Referer header (MISSING_OR_NULL_ORIGIN)', async () => {
  const email = 'checklist-no-origin@example.com';
  await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD, name: 'No Origin' });
  const signIn = await request(app)
    .post('/api/auth/sign-in/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD });
  const cookie = findSessionCookie(signIn.get('Set-Cookie') ?? []);
  expect(cookie !== undefined).toBe(true);
  const token = tokenFromSessionCookie(cookie!);

  const res = await request(app)
    .post('/api/auth/sign-out')
    .set('Cookie', cookie!);
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('MISSING_OR_NULL_ORIGIN');
  // Rejected in middleware, before the handler ran: session untouched.
  const stillThere = await client.query(
    'SELECT 1 FROM sessions WHERE token = $1',
    [token],
  );
  expect(stillThere.rowCount).toBe(1);
});

it('rejects a cross-site navigation login attempt flagged by Sec-Fetch-Site/Sec-Fetch-Mode (CROSS_SITE_NAVIGATION_LOGIN_BLOCKED)', async () => {
  const email = 'checklist-cross-site-nav@example.com';
  await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD, name: 'Cross Site Nav' });

  const res = await request(app)
    .post('/api/auth/sign-in/email')
    .set('Sec-Fetch-Site', 'cross-site')
    .set('Sec-Fetch-Mode', 'navigate')
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('CROSS_SITE_NAVIGATION_LOGIN_BLOCKED');
});

it('rejects a cookie-less sign-in POST from an untrusted Origin (login CSRF, INVALID_ORIGIN)', async () => {
  const email = 'checklist-login-csrf@example.com';
  await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD, name: 'Login CSRF' });

  const res = await request(app)
    .post('/api/auth/sign-in/email')
    .set('Origin', EVIL_ORIGIN)
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('INVALID_ORIGIN');
});

// --- Item 8: Express 5 mounting before body parsing ---

it('completes a two-segment /api/auth POST with a JSON body, and 404s an unknown /api/auth path without hanging', async () => {
  const email = 'checklist-mounting@example.com';
  await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD, name: 'Mounting' })
    .timeout(5000);

  const signIn = await request(app)
    .post('/api/auth/sign-in/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD })
    .timeout(5000);
  expect(signIn.status).toBe(200);
  expect((signIn.get('Set-Cookie') ?? []).length > 0).toBe(true);

  const missing = await request(app).get('/api/auth/not-a-route').timeout(5000);
  expect(missing.status).toBe(404);
}, 5000);

// --- Item 9: no unused plugins ---

it('pins better-auth to exactly 1.7.18 and installs no @better-auth/* plugin package directly', () => {
  const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  expect(pkg.dependencies?.['better-auth']).toBe('1.7.18');
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const pluginDeps = Object.keys(allDeps).filter((name) =>
    name.startsWith('@better-auth/'),
  );
  expect(pluginDeps).toEqual([]);
});

it('auth.options show no plugins, the password-length policy, no reset email hook, no secondary storage and the cookie cache off', () => {
  const options = auth.options as BetterAuthOptions;
  expect(options.plugins === undefined || options.plugins.length === 0).toBe(
    true,
  );
  expect(options.emailAndPassword?.enabled).toBe(true);
  expect(options.emailAndPassword?.minPasswordLength).toBe(15);
  expect(options.emailAndPassword?.maxPasswordLength).toBe(128);
  expect(options.emailAndPassword?.sendResetPassword).toBeUndefined();
  expect(options.secondaryStorage).toBeUndefined();
  expect(options.session?.cookieCache?.enabled).not.toBe(true);
});

// --- Password rules (sign-up) ---

it('rejects a 14-character password (PASSWORD_TOO_SHORT) and a 129-character password (PASSWORD_TOO_LONG) with no new rows; accepts exactly 128', async () => {
  const before = await countIdentityTables(client);

  const tooShort = await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({
      email: 'checklist-pw-short@example.com',
      password: 'a'.repeat(14),
      name: 'Too Short',
    });
  expect(tooShort.status).toBe(400);
  expect(tooShort.body.code).toBe('PASSWORD_TOO_SHORT');

  const tooLong = await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({
      email: 'checklist-pw-long@example.com',
      password: 'a'.repeat(129),
      name: 'Too Long',
    });
  expect(tooLong.status).toBe(400);
  expect(tooLong.body.code).toBe('PASSWORD_TOO_LONG');

  const afterRejections = await countIdentityTables(client);
  expect(afterRejections).toEqual(before);

  const accepted = await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({
      email: 'checklist-pw-128@example.com',
      password: 'a'.repeat(128),
      name: 'Exactly 128',
    });
  expect(accepted.status).toBe(200);
});

// --- Password reset (D-029: no reset in the MVP) ---

it('rejects request-password-reset for an existing user with 400 RESET_PASSWORD_DISABLED, leaving every identity table unchanged', async () => {
  const email = 'checklist-reset-request@example.com';
  await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD, name: 'Reset Request' });

  const before = await countIdentityTables(client);
  const res = await request(app)
    .post('/api/auth/request-password-reset')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('RESET_PASSWORD_DISABLED');

  const after = await countIdentityTables(client);
  expect(after).toEqual(before);
  expect(after.verifications).toBe(0);
});

it('rejects reset-password with a made-up token and a valid new password, leaving the password hash unchanged', async () => {
  const email = 'checklist-reset-password@example.com';
  await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, password: PASSWORD, name: 'Reset Password' });

  const findHash = () =>
    client.query<{ password: string }>(
      `SELECT a.password FROM accounts a JOIN users u ON u.id = a.user_id
       WHERE u.email = $1 AND a.provider_id = 'credential'`,
      [email],
    );
  const before = await findHash();
  expect(before.rowCount).toBe(1);

  const res = await request(app)
    .post('/api/auth/reset-password')
    .set('Origin', TRUSTED_ORIGIN)
    .send({
      token: 'made-up-token-does-not-exist',
      newPassword: 'another-valid-pw15',
    });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('INVALID_TOKEN');

  const after = await findHash();
  expect(after.rows[0]!.password === before.rows[0]!.password).toBe(true);
});

it('redirects the GET reset-password/:token callback for a made-up token, changing nothing (the only other reset-related route in core)', async () => {
  const before = await countIdentityTables(client);
  const res = await request(app)
    .get('/api/auth/reset-password/made-up-token-does-not-exist')
    .query({ callbackURL: TRUSTED_ORIGIN })
    .redirects(0);
  expect(res.status).toBe(302);
  expect(res.headers['location']?.includes('error=INVALID_TOKEN')).toBe(true);
  const after = await countIdentityTables(client);
  expect(after).toEqual(before);
});
