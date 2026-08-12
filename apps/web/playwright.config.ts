import { defineConfig, devices } from '@playwright/test';

/**
 * Why a single browser project (Chromium), not the usual
 * Chromium/Firefox/WebKit matrix?
 *
 * "Do not introduce unnecessary testing infrastructure" is explicit.
 * This suite exists to protect one critical user journey against
 * genuine regressions, not to catch cross-browser CSS quirks - a
 * second or third browser here would be real added CI time and
 * maintenance cost for a benefit this project has never asked for.
 *
 * Why webServer starts the frontend but not the backend?
 *
 * The backend has real, stateful dependencies (MongoDB, a Groq API
 * key for anything AI-related) that this config can't safely assume
 * exist - CI wires the backend up explicitly as its own step (see
 * .github/workflows/ci.yml), and a local run expects `npm run dev:api`
 * already running, the same convention every other script in this
 * project (smoke-test.ps1, the eval harness) already uses.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
