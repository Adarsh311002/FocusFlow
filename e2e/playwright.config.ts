import { defineConfig } from '@playwright/test';

import { WEB_ORIGIN } from './support/stack';

// The Phase 6 smoke suite (M12): the core room journey in real browsers, several isolated
// contexts per test (one per person). It uses the machine's installed Chrome, so no browser
// download is needed; the stack (containers, migrations, API, Vite) is started and stopped
// by the global setup. Run with `pnpm test:e2e`.
export default defineConfig({
  testDir: './tests',
  globalSetup: './support/global-setup.ts',
  // One stack, shared state: tests use unique users and rooms, but run one at a time so a
  // failure is easy to read.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // 90 s of test time plus PAGE_LOAD_HEADROOM_MS (support/people.ts) for dev-server page loads.
  timeout: 150_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: WEB_ORIGIN,
    channel: 'chrome',
    // The rooms are under test, not the decorative 3D forest. Headless Chrome draws WebGL in
    // software, and several people per test each drawing the tree starve the CPU until steps
    // time out. With reduced motion the app skips the 3D scene (a real, supported mode).
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
