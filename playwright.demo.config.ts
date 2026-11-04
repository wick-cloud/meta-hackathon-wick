import { defineConfig, devices } from '@playwright/test';

// Keep this suite independent of dotenv, accounts, database setup, and any running backend.
const baseURL = 'http://127.0.0.1:4317';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: ['interactive-demo.spec.ts', 'local-demo.spec.ts'],
  grepInvert: /@hosted/,
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  outputDir: 'test-results/demo',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/demo' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run demo -- --port 4317',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
