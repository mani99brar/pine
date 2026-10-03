import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    env: { NEXT_PUBLIC_PINE_MOCK_LATENCY: '0' },
    // next-auth imports `next/server` without an extension (resolved by Next's bundler);
    // inline it so Vite resolves it in tests.
    server: { deps: { inline: ['next-auth', '@auth/core'] } },
  },
})
