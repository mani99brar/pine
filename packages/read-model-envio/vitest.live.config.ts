import { defineConfig } from "vitest/config";

// `pnpm test:live`: smoke checks against a real Envio deployment (ENVIO_GRAPHQL_URL). Never part of `pnpm test`.
export default defineConfig({
  test: {
    include: ["live/**/*.live.ts"],
    testTimeout: 300_000,
    pool: "forks",
  },
});
