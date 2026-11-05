import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Provide a DATABASE_URL so the config module can be imported in tests
    // without a real database. The host (db.invalid) is deliberately
    // unreachable so no test can accidentally connect to a real database.
    // Tests that actually query the database are added later (Step 3+).
    env: {
      DATABASE_URL: 'postgresql://test:test@db.invalid:5432/slotdesk_test',
      NODE_ENV: 'test',
    },
    // Exclude database integration tests from the default unit-test run.
    // Those tests need Docker running and are run separately with `npm run test:db`.
    // test/db.test.ts (in the test/ root) stays included; it tests the pool import
    // without a real connection (db.invalid is unreachable).
    // Spread configDefaults.exclude so Vitest's built-in patterns are not lost
    // (node_modules, .git). Without the spread, a custom array replaces the defaults.
    exclude: [...configDefaults.exclude, 'test/db/**'],
  },
});
