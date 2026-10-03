// The indexer process (PRD-05 section 2.3), with its I/O injectable so the wiring is testable: validated env (fail closed),
// migration verification (the runtime role has no DDL), a single-writer advisory lock on a dedicated connection, both
// RPC providers, the poller loop and the internal metrics/health server. Every startup step, including the connection
// string parsing of the pool and pool.connect(), runs inside the try whose failures are logged through the redactor.

import type http from "node:http";
import type { DestinationStream } from "pino";
import { configSecrets, loadConfig, type IndexerConfig } from "./config.js";
import { pgPoolExecutor, type PgClientLike, type PgPoolLike } from "./db.js";
import { createLogger } from "./logger.js";
import { createHealthServer, createMetrics } from "./metrics.js";
import { verifyMigrations, type MigrationFile } from "./migrations.js";
import { Poller } from "./poller.js";
import { createRedactor, safeErrorMessage, type Redactor } from "./redact.js";
import type { HttpProviderOptions, RpcProvider } from "./rpc.js";

/** Arbitrary constant: "pnis" in ASCII; held for the process lifetime so only one poller runs per database. */
export const PROCESS_LOCK_KEY = 0x706e6973;

export interface ProcessPool extends PgPoolLike {
  on?(event: "error", listener: (error: Error) => void): unknown;
  end(): Promise<void>;
}

export interface IndexerDeps {
  /** Builds the pool (node-postgres parses the connection string here, so it runs inside the guarded startup). */
  createPool(config: IndexerConfig): ProcessPool;
  createProvider(options: HttpProviderOptions): RpcProvider;
  loadMigrations(): Promise<MigrationFile[]>;
  /** Stops the poller loop. */
  signal: AbortSignal;
  logDestination?: DestinationStream;
}

/** Runs the indexer until the signal aborts; returns the process exit code. Never throws. */
export async function runIndexer(env: Record<string, string | undefined>, deps: IndexerDeps): Promise<number> {
  let redact: Redactor = createRedactor();
  const bootLogger = createLogger(redact, "info", deps.logDestination);
  let config: IndexerConfig;
  try {
    config = loadConfig(env);
  } catch (error) {
    bootLogger.fatal({ error: safeErrorMessage(error, redact) }, "refusing to start");
    return 1;
  }
  redact = createRedactor(configSecrets(config));
  const logger = createLogger(redact, config.logLevel, deps.logDestination);
  let pool: ProcessPool | null = null;
  let lockClient: PgClientLike | null = null;
  let server: http.Server | null = null;
  try {
    pool = deps.createPool(config);
    pool.on?.("error", (error) => logger.error({ error: safeErrorMessage(error, redact) }, "idle database client error"));
    const db = pgPoolExecutor(pool);
    await verifyMigrations(db, await deps.loadMigrations());
    lockClient = await pool.connect();
    const locked = await lockClient.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [PROCESS_LOCK_KEY]);
    if (locked.rows[0]?.locked !== true) throw new Error("another indexer process holds the single-writer lock");
    const metrics = createMetrics();
    const poller = new Poller({
      db,
      primary: deps.createProvider({ label: "primary", url: config.rpcPrimaryUrl, redact }),
      secondary: deps.createProvider({ label: "secondary", url: config.rpcSecondaryUrl, redact }),
      chainId: config.chainId,
      questionTimeout: config.questionTimeout,
      addresses: config.addresses,
      deploymentBlock: config.deploymentBlock,
      redact,
      logger,
      metrics,
      chunkSize: config.chunkSize,
      pollIntervalMs: config.pollIntervalMs,
    });
    const health = createHealthServer({
      metrics,
      host: config.metricsHost,
      port: config.metricsPort,
      ready: () => poller.isReady(Math.max(60_000, config.pollIntervalMs * 6)),
    });
    server = health;
    await new Promise<void>((resolve, reject) => {
      health.once("error", reject);
      health.listen(config.metricsPort, config.metricsHost, () => {
        health.off("error", reject);
        resolve();
      });
    });
    health.on("error", (error) => logger.error({ error: safeErrorMessage(error, redact) }, "health server error"));
    await poller.start();
    logger.info({ chainId: config.chainId, deploymentBlock: config.deploymentBlock.toString() }, "indexer started");
    await poller.run(deps.signal);
    logger.info({}, "indexer stopped");
    return 0;
  } catch (error) {
    logger.fatal({ error: safeErrorMessage(error, redact) }, "indexer stopped");
    return 1;
  } finally {
    const open = server;
    if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
    // Destroy the lock connection so the session-level advisory lock is released with it. Cleanup never throws: runIndexer
    // must resolve with an exit code, not reject with a raw (unredacted) error.
    try {
      lockClient?.release(true);
    } catch (error) {
      logger.error({ error: safeErrorMessage(error, redact) }, "releasing the lock connection failed");
    }
    await pool?.end().catch(() => undefined);
  }
}
