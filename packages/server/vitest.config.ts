import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    env: { NEXT_PUBLIC_PINE_MOCK_LATENCY: '0' },
  },
})
