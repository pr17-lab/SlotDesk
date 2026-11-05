import pg from 'pg';

// Test-only guard. Called at the start of every database test file to prove
// we are connected to a test database before any data-changing SQL runs.
//
// Three checks, all mandatory (D-016):
//   1. TEST_DATABASE_URL must be set in the environment.
//   2. The database name parsed from that URL must end in "_test".
//   3. After connecting, SELECT current_database() must also end in "_test".
//
// Checks 1 and 2 happen before any network connection is opened, so the guard
// refuses a bad URL without touching any database.
export function requireTestDatabase(): {
  url: string;
  createClient: () => pg.Client;
} {
  const url = process.env['TEST_DATABASE_URL'];

  // Check 1: variable must be present.
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. ' +
        'Set it in server/.env to a database whose name ends in _test.',
    );
  }

  // Check 2: parse the database name from the URL before connecting.
  // URL pathname is "/<dbname>"; strip the leading slash.
  let dbName: string;
  try {
    dbName = new URL(url).pathname.replace(/^\//, '');
  } catch {
    throw new Error(`TEST_DATABASE_URL is not a valid URL: ${url}`);
  }

  if (!dbName.endsWith('_test')) {
    throw new Error(
      `TEST_DATABASE_URL database name "${dbName}" does not end in _test. ` +
        'Refusing to run against a non-test database.',
    );
  }

  // Return the URL and a factory so each test can open its own Client.
  // Check 3 (SELECT current_database()) is done by connectTestClient below,
  // which every test file calls on its client before inserting data.
  return {
    url,
    createClient: () => new pg.Client({ connectionString: url }),
  };
}

// Connect a pg Client and verify that the live database name ends in _test.
// Call this at the start of each test after creating a client, before any
// data-changing query. Throws if the database does not pass the check.
export async function connectAndVerify(client: pg.Client): Promise<void> {
  await client.connect();

  const result = await client.query<{ current_database: string }>(
    'SELECT current_database()',
  );
  const liveDbName = result.rows[0]?.current_database ?? '';

  if (!liveDbName.endsWith('_test')) {
    await client.end();
    throw new Error(
      `Connected database "${liveDbName}" does not end in _test. ` +
        'Refusing to run against a non-test database.',
    );
  }
}

// Truncate tenant tables after each test file so the next file starts clean.
// Restart identity sequences so IDs are predictable within a file.
// Order: bookings first (references resources), then resources (references
// organizations), then organizations.
export async function truncateTables(client: pg.Client): Promise<void> {
  await client.query(
    'TRUNCATE bookings, resources, organizations RESTART IDENTITY CASCADE',
  );
}
