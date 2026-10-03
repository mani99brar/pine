import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    env: {
      // createTestIndexer's simulate source reports the last simulated block as the chain height, so with the
      // production lag (config.yaml: block_lag ${ENVIO_BLOCK_LAG:-40}) the head never reaches it and process() never
      // returns. Tests index with no lag; test/config.test.ts pins the production default of 40.
      ENVIO_BLOCK_LAG: "0",
    },
  },
});
