// FROZEN cross-lane contract. The one migration runner used by the `migrate` command, the API startup check and tests.
//
// Layout: packages/api/migrations/<group>/<NNNN>_<snake_name>.sql, groups applied in MIGRATION_GROUPS order, files
// within a group in ascending NNNN order. Each lane owns exactly one group directory:
//   platform -> migrations/platform  (0001_core.sql is frozen; the platform-core lane adds 0002+)
//   gateways -> migrations/gateways  (platform-gateways lane)
//   claims   -> migrations/claims    (claims lane)
//   markets  -> migrations/markets   (markets lane)
//   funding  -> migrations/funding   (funding lane)
// Rules (SEC-OPS-10): migrations are append-only and run by a separate `migrate` command under a DDL-capable role.
// The API process only calls verifyMigrations() at startup and refuses to start when anything is pending, modified,
// out of order or unknown. Cross-group foreign keys may only reference the frozen `users` table. Each file runs in its own
// transaction with lock and statement timeouts. SQL files must use LF line endings (.gitattributes).

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATION_GROUPS = ["platform", "gateways", "claims", "markets", "funding"] as const;
export type MigrationGroup = (typeof MIGRATION_GROUPS)[number];

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  group: MigrationGroup;
  name: string;
  number: number;
  sql: string;
  checksum: string;
}

/** Minimal SQL executor: node-postgres and PGlite both satisfy it through small adapters. */
export interface SqlExecutor {
  /** Executes one or more statements without parameters. */
  exec(sql: string): Promise<void>;
  /** Executes a parameterised query and returns rows. */
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs `fn` inside a transaction on the same connection; rolls back when it throws. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

export const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/** Arbitrary constant: "pine" in ASCII. */
export const MIGRATION_LOCK_KEY = 0x70696e65;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export async function loadMigrations(root: string = DEFAULT_MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [];
  for (const group of MIGRATION_GROUPS) {
    let entries: string[];
    try {
      entries = await readdir(path.join(root, group));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const seen = new Set<number>();
    for (const name of entries.filter((entry) => entry.endsWith(".sql")).sort()) {
      const match = FILE_PATTERN.exec(name);
      if (!match) throw new MigrationError(`Invalid migration file name: ${group}/${name}`);
      const number = Number(match[1]);
      if (seen.has(number)) throw new MigrationError(`Duplicate migration number ${number} in group ${group}`);
      seen.add(number);
      const sql = await readFile(path.join(root, group, name), "utf8");
      if (sql.includes("\r")) throw new MigrationError(`Migration ${group}/${name} contains CR characters; use LF line endings`);
      files.push({ group, name, number, sql, checksum: createHash("sha256").update(sql, "utf8").digest("hex") });
    }
  }
  return files;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const idOf = (file: Pick<MigrationFile, "group" | "name">): string => `${file.group}/${file.name}`;

async function readLedger(db: SqlExecutor): Promise<Map<string, string>> {
  const exists = await db.query<{ present: boolean }>("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
  if (!exists[0]?.present) return new Map();
  const rows = await db.query<{ id: string; checksum: string }>("SELECT id, checksum FROM schema_migrations");
  return new Map(rows.map((row) => [row.id, row.checksum]));
}

/** Throws MigrationError when the ledger and the files disagree in any way other than "files not yet applied". */
function checkConsistency(ledger: Map<string, string>, files: MigrationFile[]): void {
  const known = new Set(files.map(idOf));
  for (const id of ledger.keys()) {
    if (!known.has(id)) throw new MigrationError(`Applied migration ${id} has no file; migrations are append-only`);
  }
  for (const file of files) {
    const applied = ledger.get(idOf(file));
    if (applied !== undefined && applied !== file.checksum) {
      throw new MigrationError(`Applied migration ${idOf(file)} was modified (checksum mismatch); migrations are append-only`);
    }
  }
  for (const group of MIGRATION_GROUPS) {
    const groupFiles = files.filter((file) => file.group === group);
    const maxApplied = Math.max(0, ...groupFiles.filter((file) => ledger.has(idOf(file))).map((file) => file.number));
    const lateInserted = groupFiles.find((file) => !ledger.has(idOf(file)) && file.number < maxApplied);
    if (lateInserted) throw new MigrationError(`Migration ${idOf(lateInserted)} is numbered below an applied migration of its group`);
  }
}

/**
 * Applies pending migrations in order (the `migrate` command and tests). Concurrency-safe across processes: one
 * transaction holds the advisory lock while it creates the ledger, checks consistency and applies each pending file.
 */
export async function runMigrations(db: SqlExecutor, files: MigrationFile[]): Promise<MigrationResult> {
  const result: MigrationResult = { applied: [], skipped: [] };
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await tx.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const ledger = await readLedger(tx);
    checkConsistency(ledger, files);
    for (const file of files) {
      const id = idOf(file);
      if (ledger.has(id)) {
        result.skipped.push(id);
        continue;
      }
      await tx.exec("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '120s'");
      await tx.exec(file.sql);
      await tx.query("INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)", [id, file.checksum]);
      result.applied.push(id);
    }
  });
  return result;
}

/** API startup check (no DDL rights needed): refuses unless every file is applied unchanged and nothing is unknown. */
export async function verifyMigrations(db: SqlExecutor, files: MigrationFile[]): Promise<void> {
  const ledger = await readLedger(db);
  checkConsistency(ledger, files);
  const pending = files.filter((file) => !ledger.has(idOf(file))).map(idOf);
  if (pending.length > 0) throw new MigrationError(`Pending migrations: ${pending.join(", ")}; run the migrate command first`);
}
