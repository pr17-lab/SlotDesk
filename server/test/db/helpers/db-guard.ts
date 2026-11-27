import pg from 'pg';

// Test-only guard (D-016). Every database test file calls it before any
// data-changing SQL. Three checks:
//   1. TEST_DATABASE_URL must be set.
//   2. The database name in that URL must end in "_test".
//   3. After connecting, SELECT current_database() must also end in "_test".
// Checks 1 and 2 run before any connection is opened.
export function requireTestDatabase(): {
  url: string;
  dbName: string;
  createClient: () => pg.Client;
} {
  const url = process.env['TEST_DATABASE_URL'];

  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. ' +
        'Set it in server/.env to a database whose name ends in _test.',
    );
  }

  // The pathname is "/<dbname>".
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

  // Check 3 is in connectAndVerify below.
  return {
    url,
    dbName,
    createClient: () => new pg.Client({ connectionString: url }),
  };
}

// Connects the client and runs check 3. Call it before any data-changing query.
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

// Runs a statement that must fail and returns its PostgreSQL error. If the
// statement succeeds, it throws instead. Any error that is not a PostgreSQL
// error is passed on unchanged.
export async function expectError(
  fn: () => Promise<unknown>,
): Promise<pg.DatabaseError> {
  try {
    await fn();
    throw new Error('Expected a database error but the statement succeeded.');
  } catch (err) {
    if (err instanceof pg.DatabaseError) return err;
    throw err;
  }
}

// Clears the tenant tables, then the Better Auth identity tables, so the next
// file starts clean. Identity sequences restart so IDs are predictable.
export async function truncateTables(client: pg.Client): Promise<void> {
  await client.query(
    'TRUNCATE invitations, working_hours, memberships, bookings, services, resources, organizations RESTART IDENTITY CASCADE',
  );
  await client.query(
    'TRUNCATE verifications, accounts, sessions, users RESTART IDENTITY CASCADE',
  );
}
