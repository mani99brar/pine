// API process entry point (PRD-02 2.6). Run with `node --import tsx src/main.ts` (pnpm --filter @pine/api start).
// Startup and fatal lines are one-line JSON on stderr through the redactor; afterwards the Fastify logger is used.
// SIGTERM/SIGINT: stop accepting, abort jobs, close servers, gateways, read model and pool, exit 0 (1 when a shutdown
// step fails). `run(env, io)` and `installSignalHandlers` are exported so tests drive them with fakes.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Database } from "./contracts/app.js";
import { routeModules } from "./modules.js";
import { createGateways } from "./platform/gateways/index.js";
import { createPool, poolExecutor } from "./platform/core/pg.js";
import { startPlatform, type RunningPlatform, type StartDependencies } from "./platform/core/server.js";
import { createReadModel } from "./readmodel.js";

export type ShutdownSignal = "SIGTERM" | "SIGINT";

export interface MainIo {
  /** Where the signal handlers are installed (`process` in production). */
  signals: { once(signal: ShutdownSignal, listener: () => void): unknown };
  exit(code: number): void;
  /** Replaces composition dependencies (tests); production uses the real gateways, read model, modules and pool. */
  dependencies?: Partial<Omit<StartDependencies, "env">>;
}

export const processIo: MainIo = {
  signals: process,
  exit: (code) => process.exit(code),
};

/** The real composition: route modules of src/modules.ts, the gateways and read-model factories, a pg pool. */
export const productionDependencies: Omit<StartDependencies, "env"> = {
  createGateways,
  createReadModel,
  modules: routeModules,
  async connect({ secrets, settings }) {
    const pool = createPool({ connectionString: secrets.databaseUrl, max: settings.databasePoolMax, applicationName: "pine-api" });
    // Idle-client errors must not crash the process; the message is never logged raw (it may echo the URL).
    pool.on("error", () => undefined);
    return { db: drizzle(pool) as unknown as Database, sql: poolExecutor(pool), close: () => pool.end() };
  },
};

/** The first SIGTERM or SIGINT shuts the platform down once and exits 0, or 1 when shutdown fails. */
export function installSignalHandlers(running: Pick<RunningPlatform, "app" | "shutdown">, io: Pick<MainIo, "signals" | "exit">): void {
  let exiting = false;
  const stop = (signal: ShutdownSignal) => {
    if (exiting) return;
    exiting = true;
    running.app.log.info({ signal }, "signal received");
    running.shutdown().then(
      () => io.exit(0),
      () => io.exit(1),
    );
  };
  io.signals.once("SIGTERM", () => stop("SIGTERM"));
  io.signals.once("SIGINT", () => stop("SIGINT"));
}

/** Starts the platform and installs the signal handlers; on a refused startup exits 1 and resolves null. */
export async function run(env: Readonly<Record<string, string | undefined>>, io: MainIo = processIo): Promise<RunningPlatform | null> {
  let running: RunningPlatform;
  try {
    running = await startPlatform({ ...productionDependencies, ...io.dependencies, env });
  } catch {
    // startPlatform already wrote a redacted fatal line.
    io.exit(1);
    return null;
  }
  installSignalHandlers(running, io);
  return running;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) void run(process.env);
