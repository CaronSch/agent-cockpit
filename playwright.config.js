import { defineConfig, devices } from '@playwright/test';
import { E2E_OMP_SESSIONS, E2E_PORT, E2E_STATE_DIR } from './e2e/daemon.js';

const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The real daemon, driving the scripted fake omp instead of a real agent.
    command: `node daemon/main.js --port ${E2E_PORT} --omp tests/fixtures/fake-omp.js`,
    env: { AGENT_COCKPIT_STATE_DIR: E2E_STATE_DIR, AGENT_COCKPIT_OMP_SESSIONS: E2E_OMP_SESSIONS },
    url: BASE_URL,
    reuseExistingServer: !CI,
  },
});
