// Process composition (PRD-02 2.6): config -> redactor -> startup logger -> database -> verifyMigrations (refuse to
// start on any problem) -> gateways -> read model -> chain id assertion -> AppContext -> buildApp -> listen, then the
// user-content server, the internal metrics listener and the jobs runner. Before buildApp exists, startup lines are
// one-line JSON on stderr through the redactor; afterwards the Fastify logger is used.

import type { FastifyInstance } from "fastify";
import type { Database, RouteModule } from "../../contracts/app.js";
import { loadMigrations, verifyMigrations, type MigrationFile, type SqlExecutor } from "../../contracts/migrations.js";
import type { ContentServer, GatewayFactory, Gateways, PlatformSecrets, ReadModelFactory } from "../../contracts/platform.js";
import { createRedactor, safeErrorMessage, type Redactor } from "../../contracts/redact.js";
import { buildApp, type LogStream } from "./app.js";
import { cleanupJob } from "./cleanup.js";
import { createPlatformRedactor, loadConfig, SECRET_VARIABLES, type ServerSettings } from "./config.js";
import { createAppContext, createCoreServices, systemClock } from "./context.js";
import { JobRunner } from "./jobs.js";
import { PromMetrics, startMetricsListener, type MetricsListener } from "./metrics.js";

export type StartupLevel = "info" | "warn" | "error" | "fatal";

/** One-line JSON to stderr, every message passed through the redactor (no logger library before buildApp). */
export function stderrLogger(getRedactor: () => Redactor, write: (line: string) => void = (line) => void process.stderr.write(line)) {
  return (level: StartupLevel, message: string, fields: Record<string, string | number | boolean | null> = {}) => {
    const redact = getRedactor();
    const safeFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === "string" ? redact(value) : value]));
    write(`${JSON.stringify({ level, time: new Date().toISOString(), msg: redact(message), ...safeFields })}\n`);
  };
}

export interface DatabaseConnection {
  db: Database;
  sql: SqlExecutor;
  close(): Promise<void>;
}

export interface StartDependencies {
  env: Readonly<Record<string, string | undefined>>;
  createGateways: GatewayFactory;
  createReadModel: ReadModelFactory;
  modules: readonly RouteModule[];
  connect(input: { secrets: PlatformSecrets; settings: ServerSettings }): Promise<DatabaseConnection>;
  /** Startup log sink (default stderr). */
  write?: (line: string) => void;
  /** Overrides for tests. */
  migrationFiles?: MigrationFile[];
  readFile?: (path: string) => string;
  /** Fastify log destination (default stdout). */
  logStream?: LogStream;
}

export interface RunningPlatform {
  app: FastifyInstance;
  contentServer: ContentServer;
  metricsListener: MetricsListener;
  runner: JobRunner;
  /**
   * Stops accepting, aborts jobs, closes servers, gateways, read model and database. Idempotent. Every step runs even
   * when an earlier one fails; the promise then rejects (the process exits 1).
   */
  shutdown(): Promise<void>;
}

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

function envRedactor(env: Readonly<Record<string, string | undefined>>): Redactor {
  const values = SECRET_VARIABLES.flatMap((name) => {
    const value = env[name];
    return value === undefined ? [] : [value, ...value.split(",").map((part) => part.split(":").slice(1).join(":"))];
  });
  return createRedactor(values.filter((value) => value.length > 0));
}

export async function startPlatform(deps: StartDependencies): Promise<RunningPlatform> {
  let redact = envRedactor(deps.env);
  const log = stderrLogger(() => redact, deps.write);
  const cleanups: (() => Promise<void>)[] = [];
  /** Runs every cleanup (newest first) and returns the number of failed steps. */
  const closeAll = async (): Promise<number> => {
    let failed = 0;
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failed += 1;
        log("error", "shutdown step failed", { error: safeErrorMessage(error, redact) });
      }
    }
    return failed;
  };

  try {
    const { config, secrets, server } = loadConfig(deps.env, deps.readFile ? { readFile: deps.readFile } : {});
    redact = createPlatformRedactor(secrets, deps.env);
    log("info", "configuration loaded", { environment: config.environment });

    const connection = await deps.connect({ secrets, settings: server });
    cleanups.push(() => connection.close());
    const files = deps.migrationFiles ?? (await loadMigrations());
    await verifyMigrations(connection.sql, files);
    log("info", "migrations verified", { count: files.length });

    const metrics = new PromMetrics((message) => log("warn", message));
    const services = createCoreServices({ config, db: connection.db, clock: systemClock, redact, settings: server });
    const gateways: Gateways = await deps.createGateways({ config, secrets, db: connection.db, clock: systemClock, redact, metrics, moderation: services.moderation });
    cleanups.push(() => gateways.close());
    const readModel = await deps.createReadModel({ config, secrets, redact, clock: systemClock });
    cleanups.push(() => readModel.close());

    if (gateways.chain.chainId !== config.chainId) throw new StartupError("chain gateway is configured for another chain id");
    const remoteChainId = await gateways.chain.publicClient.getChainId();
    if (remoteChainId !== config.chainId) throw new StartupError("RPC reports another chain id");
    const indexer = await readModel.status();
    if (indexer.chainId !== config.chainId) throw new StartupError("read model reports another chain id");

    const ctx = createAppContext({
      config,
      db: connection.db,
      clock: systemClock,
      redact,
      metrics,
      readModel,
      gateways,
      services,
      onAuditError: (error) => log("error", "audit write failed", { error: safeErrorMessage(error, redact) }),
    });
    const app = await buildApp({
      ctx,
      gateways,
      modules: deps.modules,
      settings: server,
      readiness: { verifyMigrations: () => verifyMigrations(connection.sql, files), verifiedAtStartup: true },
      ...(deps.logStream ? { logStream: deps.logStream } : {}),
    });
    let appClosed: Promise<void> | null = null;
    const closeApp = () => (appClosed ??= app.close());
    cleanups.push(closeApp);
    await app.listen({ host: server.host, port: server.port });
    app.log.info({ host: server.host, port: server.port }, "api listening");

    const contentServer = gateways.createContentServer();
    await contentServer.listen({ host: server.userContentHost, port: server.userContentPort });
    cleanups.push(() => contentServer.close());
    app.log.info({ host: server.userContentHost, port: server.userContentPort }, "user-content server listening");

    metrics.collectProcessMetrics();
    const metricsListener = await startMetricsListener(metrics, { host: server.metricsHost, port: server.metricsPort });
    cleanups.push(() => metricsListener.close());

    const runner = new JobRunner({
      db: connection.db,
      ctx,
      jobs: [...gateways.jobs, cleanupJob, ...deps.modules.flatMap((module) => module.jobs ?? [])],
      logger: {
        info: (message, fields) => app.log.info(fields ?? {}, message),
        error: (message, fields) => app.log.error(fields ?? {}, message),
      },
      metrics,
      redact,
    });
    runner.start();
    // Jobs stop first so no run uses a closed server or pool.
    cleanups.push(() => runner.stop());

    let stopping: Promise<void> | null = null;
    return {
      app,
      contentServer,
      metricsListener,
      runner,
      shutdown: () => {
        stopping ??= (async () => {
          app.log.info("shutting down");
          // Stop accepting first, then abort jobs, then close everything else (closeApp is also the last cleanup and
          // is memoised, so a failure there is counted once by closeAll).
          await closeApp().catch(() => undefined);
          const failed = await closeAll();
          if (failed > 0) throw new Error(`shutdown incomplete: ${failed} step(s) failed`);
        })();
        return stopping;
      },
    };
  } catch (error) {
    log("fatal", "startup refused", { error: safeErrorMessage(error, redact) });
    await closeAll();
    throw error;
  }
}
