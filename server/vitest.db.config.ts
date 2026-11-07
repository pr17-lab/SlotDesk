import { defineConfig } from 'vitest/config';

// Separate Vitest configuration for database integration tests.
// These tests need Docker (real PostgreSQL) and TEST_DATABASE_URL set.
// Run with: npm run test:db
// They are excluded from the default `npm test` run (vitest.config.ts).
export default defineConfig({
  test: {
    // Run test/db/ files only — never the unit tests in test/*.test.ts.
    include: ['test/db/**/*.test.ts'],
    // Global setup resets and re-applies all migrations once before the run.
    globalSetup: ['test/db/helpers/global-setup.ts'],
    // --no-file-parallelism is passed via the npm script to ensure one file
    // at a time in one process so each file sees a clean state after truncation.
    // No fake DATABASE_URL here: tests read TEST_DATABASE_URL directly.
    env: {
      // Test-only values so the app's config.ts loads in tests that import
      // the app. Not a real secret: exactly 32 characters, the minimum allowed.
      BETTER_AUTH_SECRET: 'test-only-secret-not-for-real-00',
      BETTER_AUTH_URL: 'http://localhost:3000',
    },
  },
});
