// Global setup for database integration tests.
// Runs once before all test files in a `npm run test:db` run.
//
// Steps:
//   1. Read TEST_DATABASE_URL. Fail fast if it is missing or wrong.
//   2. Revert ALL migrations on the test database (direction: "down",
//      count: Infinity — the node-pg-migrate option for "revert all").
//   3. Apply ALL migrations (direction: "up").
//
// This guarantees every run starts from a known schema, even if a previous
// run crashed mid-migration. The option name is `count` in the runner API;
// Infinity means "all migrations in this direction".
//
// Why not use dotenv: the project loads .env with Node's --env-file-if-exists
// flag in all scripts that need it (D-023). This file is run by Vitest's
// globalSetup which does not pass that flag, so the caller script must set
// TEST_DATABASE_URL before starting Vitest (the test:db script does this via
// the npm script that passes --env-file-if-exists to node before vitest).
// For simplicity the test:db script passes the env file via vitest's own
// --environment flag — actually we use the node flag via the script wrapper.
//
// Note: node-pg-migrate's runner is imported from its bundle entry point.
// The `runner` function is the same one the CLI uses internally.

import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { connectAndVerify } from './db-guard.js';

// Resolve the migrations directory relative to this file's location.
// This file lives at server/test/db/helpers/global-setup.ts.
// Migrations live at server/migrations/.
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const migrationsDir = resolve(__dirname, '../../../migrations');

export async function setup(): Promise<void> {
  const url = process.env['TEST_DATABASE_URL'];

  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. ' +
        'Cannot run the global migration setup for database tests.',
    );
  }

  // Validate database name ends in _test before connecting.
  let dbName: string;
  try {
    dbName = new URL(url).pathname.replace(/^\//, '');
  } catch {
    throw new Error(`TEST_DATABASE_URL is not a valid URL: ${url}`);
  }

  if (!dbName.endsWith('_test')) {
    throw new Error(
      `TEST_DATABASE_URL database "${dbName}" does not end in _test. ` +
        'Refusing to reset a non-test database.',
    );
  }

  // Check 3: open a short-lived connection and verify current_database() ends
  // in _test. If the database name in the URL does not match what PostgreSQL
  // reports, connectAndVerify throws and nothing is reverted or applied.
  const probe = new pg.Client({ connectionString: url });
  await connectAndVerify(probe);
  await probe.end();

  const base = {
    databaseUrl: url,
    dir: migrationsDir,
    // SQL migration files (not JS).
    migrationsTable: 'pgmigrations',
    // Print migration output so CI logs show what ran.
    verbose: true,
  } as const;

  // Revert ALL applied migrations.
  // `count: Infinity` is the node-pg-migrate runner option that means
  // "revert every applied migration". The CLI equivalent is passing a count
  // larger than the total number of migrations; the runner accepts Infinity
  // directly (see runner source: `const { count = 1 } = options` for down,
  // and `downMigrations.slice(-Math.abs(count))` which handles Infinity).
  console.log('[global-setup] Reverting all migrations on', dbName, '...');
  await runner({ ...base, direction: 'down', count: Infinity });

  // Apply ALL migrations from scratch.
  console.log('[global-setup] Applying all migrations on', dbName, '...');
  await runner({ ...base, direction: 'up' });

  console.log('[global-setup] Migration reset complete.');
}
