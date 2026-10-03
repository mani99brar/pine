// `pnpm --filter @pine/indexer-native migrate`: applies pending pine_index migrations under a DDL-capable role
// (MIGRATION_DATABASE_URL, falling back to DATABASE_URL). The indexer process itself only verifies. `main(env, io)` is the
// testable entry: it validates the URL (naming the variable, never printing its value), runs every step, including the
// pool's connection-string parsing, inside the try that prints one redacted fatal line, and returns the exit code
// (0 applied or up to date, 1 invalid configuration, migration or database failure).

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { z } from "zod";
import { urlSecrets } from "./config.js";
import { pgPoolExecutor, type SqlExecutor } from "./db.js";
import { loadMigrations as loadMigrationFiles, runMigrations, type MigrationFile } from "./migrations.js";
import { createRedactor, safeErrorMessage } from "./redact.js";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

/** An open database for the migration run. */
export interface MigrationDatabase {
  db: SqlExecutor;
  end(): Promise<void>;
}

export interface MigrateIo {
  stdout(line: string): void;
  stderr(line: string): void;
  /** Opens the database (default: a node-postgres pool of one connection; idle-client errors go to `onError`). */
  openDatabase?(url: string, onError: (error: unknown) => void): MigrationDatabase;
  loadMigrations?(): Promise<MigrationFile[]>;
}

const databaseUrl = z
  .string()
  .regex(/^postgres(?:ql)?:\/\/\S+$/)
  .refine((value) => URL.canParse(value));

function openPool(url: string, onError: (error: unknown) => void): MigrationDatabase {
  const pool = new Pool({ connectionString: url, max: 1 });
  pool.on("error", onError);
  return { db: pgPoolExecutor(pool), end: () => pool.end() };
}

/** Runs the migrations; returns the process exit code. Never throws, never prints a secret or a stack. */
export async function main(env: Record<string, string | undefined>, io: MigrateIo): Promise<number> {
  const variable = env.MIGRATION_DATABASE_URL !== undefined ? "MIGRATION_DATABASE_URL" : "DATABASE_URL";
  const url = databaseUrl.safeParse(env[variable]);
  if (!url.success) {
    io.stderr(`migration refused: ${variable} must be a postgres:// URL`);
    return EXIT_FAILED;
  }
  const redact = createRedactor(urlSecrets(url.data));
  let database: MigrationDatabase | null = null;
  try {
    database = (io.openDatabase ?? openPool)(url.data, (error) => io.stderr(`idle database client error: ${safeErrorMessage(error, redact)}`));
    const files = await (io.loadMigrations ?? (() => loadMigrationFiles()))();
    const result = await runMigrations(database.db, files);
    io.stdout(JSON.stringify({ applied: result.applied, skipped: result.skipped }));
    return EXIT_OK;
  } catch (error) {
    io.stderr(`migration failed: ${safeErrorMessage(error, redact)}`);
    return EXIT_FAILED;
  } finally {
    await database?.end().catch(() => undefined);
  }
}

/** True when this module is the process entry (`node --import tsx src/migrate-cli.ts`), not an import. */
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isProcessEntry()) {
  main(process.env, { stdout: (line) => process.stdout.write(`${line}\n`), stderr: (line) => process.stderr.write(`${line}\n`) }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // main never throws; this is the last line of defence and deliberately prints nothing from the error.
      process.stderr.write("migration failed\n");
      process.exitCode = EXIT_FAILED;
    },
  );
}
