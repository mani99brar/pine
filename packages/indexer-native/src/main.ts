// Process entry (`pnpm --filter @pine/indexer-native start`): wires node-postgres, the HTTP JSON-RPC providers and the
// process signals into runIndexer (src/app.ts). The top-level call has a handler, so no unhandled rejection can print a
// raw (unredacted) error.

import { Pool } from "pg";
import { runIndexer } from "./app.js";
import { loadMigrations } from "./migrations.js";
import { createHttpProvider } from "./rpc.js";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());

runIndexer(process.env, {
  createPool: (config) => new Pool({ connectionString: config.databaseUrl, max: 4, statement_timeout: 60_000 }),
  createProvider: createHttpProvider,
  loadMigrations: () => loadMigrations(),
  signal: controller.signal,
}).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // runIndexer never throws; this is the last line of defence and deliberately prints nothing from the error.
    process.stderr.write("indexer failed\n");
    process.exitCode = 1;
  },
);
