import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Generous: PGlite start-up and migrations take seconds, and minutes when the shared host is loaded by other gates.
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // Tests are deterministic and isolated per file; no network.
    pool: "forks",
    // One fork at a time: PGlite files are serialized by test/lock.ts anyway, and an idle fork waiting on the lock still
    // holds its module graph, which matters on a shared host where other gates run PGlite too.
    maxWorkers: 1,
  },
});
