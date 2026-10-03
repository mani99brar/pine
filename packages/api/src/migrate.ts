// Migration command (PRD-02 2.6, SEC-OPS-10): applies every pending migration group as the DDL-capable migrator role
// (PINE_MIGRATOR_DATABASE_URL), prints the applied ids and exits non-zero on any error. Migrations always run as the
// migrator in one runMigrations call (default privileges for pine_api depend on the creating role).
// Run with `pnpm --filter @pine/api migrate`. `main(env, io)` is exported so tests can inject the executor and writers.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { loadMigrations, runMigrations, type MigrationFile, type SqlExecutor } from "./contracts/migrations.js";
import { createRedactor, safeErrorMessage } from "./contracts/redact.js";
import { clientExecutor } from "./platform/core/pg.js";

export interface MigrateConnection {
  executor: SqlExecutor;
  close(): Promise<void>;
}

export interface MigrateIo {
  /** Opens the migrator connection (node-postgres in production, PGlite in tests). */
  connect(url: string): Promise<MigrateConnection>;
  stdout(text: string): void;
  stderr(text: string): void;
  exit(code: number): void;
  /** Migration files (default: the repository's migrations directory). */
  loadMigrations?: () => Promise<MigrationFile[]>;
}

export const MIGRATOR_URL_VARIABLE = "PINE_MIGRATOR_DATABASE_URL";

async function connectPostgres(url: string): Promise<MigrateConnection> {
  const client = new pg.Client({ connectionString: url, application_name: "pine-migrate", connectionTimeoutMillis: 10_000 });
  // An idle-client error must not crash the process with an unredacted message; the next query fails instead.
  client.on("error", () => undefined);
  await client.connect();
  return { executor: clientExecutor(client), close: () => client.end() };
}

export const processIo: MigrateIo = {
  connect: connectPostgres,
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  exit: (code) => process.exit(code),
};

/** Applies pending migrations; calls `io.exit(0)` on success and `io.exit(1)` after one redacted fatal line otherwise. */
export async function main(env: Record<string, string | undefined>, io: MigrateIo = processIo): Promise<void> {
  const url = env[MIGRATOR_URL_VARIABLE];
  const redact = createRedactor(url ? [url] : []);
  const line = (level: "info" | "fatal", msg: string, fields: Record<string, unknown> = {}) =>
    io.stderr(`${JSON.stringify({ level, time: new Date().toISOString(), msg: redact(msg), ...fields })}\n`);
  try {
    // At least 16 characters, like every secret: the redactor ignores secrets shorter than 8 characters.
    if (!url || url.length < 16 || !/^postgres(?:ql)?:\/\//.test(url)) throw new Error(`${MIGRATOR_URL_VARIABLE} must be a postgres:// URL of at least 16 characters`);
    const files = await (io.loadMigrations ?? loadMigrations)();
    const connection = await io.connect(url);
    try {
      const result = await runMigrations(connection.executor, files);
      for (const id of result.applied) io.stdout(`applied ${id}\n`);
      line("info", "migrations complete", { applied: result.applied.length, skipped: result.skipped.length });
    } finally {
      await connection.close().catch(() => undefined);
    }
  } catch (error) {
    line("fatal", "migration failed", { error: safeErrorMessage(error, redact) });
    io.exit(1);
    return;
  }
  io.exit(0);
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

if (invokedDirectly()) void main(process.env);
