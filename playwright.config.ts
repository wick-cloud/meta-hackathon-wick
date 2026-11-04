import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';

/** Tests intentionally use a running application with real auth and PostgreSQL. */
export default defineConfig({
  testDir: './tests/browser',
  testIgnore: 'local-demo.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? process.env.APP_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
});
