import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PLAYWRIGHT_PORT || 3000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${PORT}`;
const E2E_PASSWORD = process.env.E2E_PASSWORD || 'moontv-e2e-password';
const EXTERNAL_SERVER = process.env.PLAYWRIGHT_NO_WEBSERVER === '1';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: EXTERNAL_SERVER
    ? undefined
    : {
        command: 'pnpm dev',
        url: `${BASE_URL}/warning`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        env: {
          PASSWORD: E2E_PASSWORD,
          NEXT_PUBLIC_STORAGE_TYPE: 'localstorage',
          NEXT_TELEMETRY_DISABLED: '1',
        },
      },
});
