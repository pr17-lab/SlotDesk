import { defineConfig, devices } from '@playwright/test';

// The smoke test runs the built client, served by the built server, against
// a real database. Build both and run the migrations first.
export default defineConfig({
  testDir: '.',
  forbidOnly: !!process.env.CI,
  // No retries, so a flaky run shows up instead of passing quietly.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    // A fixed zone and locale keep days and times the same on every machine.
    timezoneId: 'Asia/Kolkata',
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run start --prefix ../server',
    url: 'http://localhost:3000/api/health',
    reuseExistingServer: !process.env.CI,
  },
});
