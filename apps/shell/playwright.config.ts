import { defineConfig } from '@playwright/test';

// Electron tests launch via playwright's _electron API directly; no
// browser project needed. Serial workers — launching multiple Electron
// instances in parallel is flaky and offers no real speedup here.

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
