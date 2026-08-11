import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  workers: 3,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? [['list'], ['json', { outputFile: 'test-results/playwright-results.json' }], ['html', { outputFolder: 'playwright-report', open: 'never' }]] : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'stability', testMatch: /(?:realtime-hydration|chat-images)\.spec\.ts/, use: { browserName: 'chromium' } },
    { name: 'production-pwa', testMatch: /(?:pwa|offline-pwa)\.spec\.ts/, fullyParallel: false, workers: 1, timeout: 60_000, use: { browserName: 'chromium', serviceWorkers: 'allow' } },
    { name: 'production-performance', testMatch: /performance\.spec\.ts/, fullyParallel: false, workers: 1, use: { browserName: 'chromium', serviceWorkers: 'allow' } },
  ],
});
