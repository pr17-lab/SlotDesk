// The global setup must throw before any migration runs when
// TEST_DATABASE_URL does not end in _test (D-016). The test points it at the
// dev database, then checks setup() throws and the dev table count is
// unchanged. DATABASE_URL must be set, or the test fails, so the table-count
// check cannot be skipped.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAndVerify, requireTestDatabase } from './helpers/db-guard.js';

// This file itself runs on the test database. The refusal is tested by
// overriding the env var inside the test, never by writing to another database.
const { createClient } = requireTestDatabase();

let client: pg.Client;

beforeAll(async () => {
  client = createClient();
  await connectAndVerify(client);
});

afterAll(async () => {
  await client.end();
});

// Counts the tables in a database's public schema.
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
    const devUrl = process.env['DATABASE_URL'];

    if (!devUrl) {
      throw new Error('DATABASE_URL must be set to prove no table was dropped');
    }

    const tablesBefore = await countTables(devUrl);

    // The dev URL does not end in _test, so setup() must throw before touching
    // any schema.
    const originalUrl = process.env['TEST_DATABASE_URL'];
    const badUrl = devUrl;
    process.env['TEST_DATABASE_URL'] = badUrl;

    let threw = false;
    try {
      const { setup } = await import('./helpers/global-setup.js');
      await setup();
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/_test/);
      expect((err as Error).message).toMatch(
        /^TEST_DATABASE_URL database name "/,
      );
    } finally {
      // Put the real URL back for later tests.
      if (originalUrl !== undefined) {
        process.env['TEST_DATABASE_URL'] = originalUrl;
      } else {
        delete process.env['TEST_DATABASE_URL'];
      }
    }

    expect(threw).toBe(true);

    const tablesAfter = await countTables(devUrl);
    expect(tablesAfter).toBe(tablesBefore);
  });
});
