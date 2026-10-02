import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    testTimeout: 20_000,
    env: { NEXT_PUBLIC_PINE_MOCK_LATENCY: '0' },
  },
})
