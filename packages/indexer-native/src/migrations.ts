// The native indexer's own migration runner (PRD-05 section 2.2), with the same rules as the API runner: ordered
// NNNN_name.sql files, SHA-256 checksums in a ledger, append-only (refuses modified, out-of-order and orphan entries),
// one transaction under a transaction-scoped advisory lock taken with pg_try_advisory_xact_lock (a concurrent run is
// refused instead of queued), run only by the `migrate` script under a DDL-capable role. The indexer process only
// verifies (its runtime role has no DDL).

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlExecutor } from "./db.js";

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Arbitrary constant: "pidx" in ASCII (distinct from the API runner's key). */
export const INDEX_MIGRATION_LOCK_KEY = 0x70696478;

export interface MigrationFile {
  name: string;
  number: number;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export async function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [];
  const seen = new Set<number>();
  for (const name of (await readdir(dir)).filter((entry) => entry.endsWith(".sql")).sort()) {
    const match = FILE_PATTERN.exec(name);
    if (!match) throw new MigrationError(`Invalid migration file name: ${name}`);
    const number = Number(match[1]);
    if (seen.has(number)) throw new MigrationError(`Duplicate migration number ${number}`);
    seen.add(number);
    const sql = await readFile(path.join(dir, name), "utf8");
    if (sql.includes("\r")) throw new MigrationError(`Migration ${name} contains CR characters; use LF line endings`);
    files.push({ name, number, sql, checksum: createHash("sha256").update(sql, "utf8").digest("hex") });
  }
  return files;
}

async function readLedger(db: SqlExecutor): Promise<Map<string, string>> {
  const exists = await db.query<{ present: boolean }>("SELECT to_regclass('pine_index.schema_migrations') IS NOT NULL AS present");
  if (exists[0]?.present !== true) return new Map();
  const rows = await db.query<{ id: string; checksum: string }>("SELECT id, checksum FROM pine_index.schema_migrations");
  return new Map(rows.map((row) => [row.id, row.checksum]));
}

function checkConsistency(ledger: Map<string, string>, files: MigrationFile[]): void {
  const known = new Set(files.map((file) => file.name));
  for (const id of ledger.keys()) {
    if (!known.has(id)) throw new MigrationError(`Applied migration ${id} has no file; migrations are append-only`);
  }
  for (const file of files) {
    const applied = ledger.get(file.name);
    if (applied !== undefined && applied !== file.checksum) {
      throw new MigrationError(`Applied migration ${file.name} was modified (checksum mismatch); migrations are append-only`);
    }
  }
  const maxApplied = Math.max(0, ...files.filter((file) => ledger.has(file.name)).map((file) => file.number));
  const lateInserted = files.find((file) => !ledger.has(file.name) && file.number < maxApplied);
  if (lateInserted) throw new MigrationError(`Migration ${lateInserted.name} is numbered below an applied migration`);
}

/** Applies pending migrations in order (the `migrate` script and tests). */
export async function runMigrations(db: SqlExecutor, files: MigrationFile[]): Promise<MigrationResult> {
  const result: MigrationResult = { applied: [], skipped: [] };
  await db.transaction(async (tx) => {
    const locked = await tx.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS locked", [INDEX_MIGRATION_LOCK_KEY]);
    if (locked[0]?.locked !== true) throw new MigrationError("Another migration run holds the pine_index migration lock");
    await tx.exec(
      `CREATE SCHEMA IF NOT EXISTS pine_index;
       CREATE TABLE IF NOT EXISTS pine_index.schema_migrations (
         id text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const ledger = await readLedger(tx);
    checkConsistency(ledger, files);
    for (const file of files) {
      if (ledger.has(file.name)) {
        result.skipped.push(file.name);
        continue;
      }
      await tx.exec("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '120s'");
      await tx.exec(file.sql);
      await tx.query("INSERT INTO pine_index.schema_migrations (id, checksum) VALUES ($1, $2)", [file.name, file.checksum]);
      result.applied.push(file.name);
    }
  });
  return result;
}

/** Indexer startup check (no DDL needed): refuses unless every file is applied unchanged and nothing is unknown. */
export async function verifyMigrations(db: SqlExecutor, files: MigrationFile[]): Promise<void> {
  const ledger = await readLedger(db);
  checkConsistency(ledger, files);
  const pending = files.filter((file) => !ledger.has(file.name)).map((file) => file.name);
  if (pending.length > 0) throw new MigrationError(`Pending migrations: ${pending.join(", ")}; run the migrate script first`);
}
