// Refusal test: proves the global setup throws before any migration runs
// when TEST_DATABASE_URL does not end in _test (D-016, Task 3a-fix).
//
// Strategy: call setup() with a URL pointing at the real dev database
// (slotdesk, not slotdesk_test). Check it throws. Then verify the dev
// database table count is unchanged — no migrations were reverted or applied.
//
// The dev database URL comes from DATABASE_URL (the normal app variable).
// DATABASE_URL must be set; the test fails without it to guarantee the
// table-count check (the proof that no table was dropped) is never skipped.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAndVerify, requireTestDatabase } from './helpers/db-guard.js';

// ── Guard ─────────────────────────────────────────────────────────────────────
// This test file itself runs against the test database (TEST_DATABASE_URL).
// The refusal scenario is exercised by temporarily overriding the env var
// inside the test, not by connecting to any non-test database for writes.
const { createClient } = requireTestDatabase();

let client: pg.Client;

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
});

afterAll(async () => {
  await client.end();
});

// Helper: count all user tables visible to the current user in a database.
async function countTables(connectionString: string): Promise<number> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    const r = await c.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
    );
    return parseInt(r.rows[0]!.count, 10);
  } finally {
    await c.end();
  }
}

describe('global-setup guard', () => {
  it('setup() throws before any migration when URL does not end in _test', async () => {
    // Dynamically import setup so each test gets a fresh module context.
    // We patch process.env before the import is resolved.
    const devUrl = process.env['DATABASE_URL'];

    if (!devUrl) {
      throw new Error('DATABASE_URL must be set to prove no table was dropped');
    }

    // Count tables on the dev database before.
    const tablesBefore = await countTables(devUrl);

    // Override TEST_DATABASE_URL with a non-_test URL (the dev database or a
    // fake URL). The global setup must throw before touching any schema.
    const originalUrl = process.env['TEST_DATABASE_URL'];
    // Use the dev database URL (always defined: the guard above throws if missing)
    // so the "no tables dropped" assertion is meaningful.
    const badUrl = devUrl;
    process.env['TEST_DATABASE_URL'] = badUrl;

    let threw = false;
    try {
      // Import fresh each time — the module-level requireTestDatabase call in
      // the real test files would have already thrown, but global-setup.ts
      // exports a setup() function we can call directly here.
      const { setup } = await import('./helpers/global-setup.js');
      await setup();
    } catch (err) {
      threw = true;
      // Must mention _test in the message.
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/_test/);
    } finally {
      // Restore the real TEST_DATABASE_URL so subsequent tests are unaffected.
      if (originalUrl !== undefined) {
        process.env['TEST_DATABASE_URL'] = originalUrl;
      } else {
        delete process.env['TEST_DATABASE_URL'];
      }
    }

    expect(threw).toBe(true);

    // Verify no tables were dropped on the dev database.
    const tablesAfter = await countTables(devUrl);
    expect(tablesAfter).toBe(tablesBefore);
  });
});
