import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Tests are deterministic and isolated per file; no network.
    pool: "forks",
  },
});
