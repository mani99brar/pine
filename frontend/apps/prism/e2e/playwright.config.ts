import { defineConfig } from '@playwright/test'

// End-to-end journey against the LOCAL stack (scripts/dev-stack/up.sh: Postgres, anvil fork of Gnosis with Pine
// deployed, pine-api with a fake GitHub, the native indexer) and Prism in api mode on :3004. Never a real network.
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 10 * 60_000,
  expect: { timeout: 45_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: '../.qa/e2e-results',
  use: {
    baseURL: process.env.PINE_E2E_BASE_URL ?? 'http://localhost:3004',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    video: { mode: 'on', size: { width: 1440, height: 900 } },
    trace: 'retain-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
      slowMo: Number(process.env.PINE_E2E_SLOWMO ?? 0),
    },
  },
})
