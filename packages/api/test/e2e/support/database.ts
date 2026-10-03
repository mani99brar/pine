// Database of one e2e test file (PRD-06 section 3). With PINE_E2E_DATABASE_URL (a superuser URL of a disposable
// PostgreSQL 16 cluster): the role bootstrap of deploy/postgres runs (idempotent, serialised by an advisory lock), a
// fresh database pine_e2e_<random hex> owned by pine_migrator is created, both real migrate commands run as
// pine_migrator, the API connects as pine_api through the production driver (main.ts productionDependencies.connect:
// pg Pool + drizzle), the indexer writes as pine_indexer and the read model reads as pine_readonly; the database is
// dropped afterwards (a failed drop fails the file's afterAll, redacted). The role bootstrap refuses any cluster that is
// not on loopback unless PINE_E2E_DISPOSABLE_CLUSTER=1 (support/cluster.ts). Without the URL: one PGlite (API and
// indexer migrations on the same instance), unless PINE_E2E_REQUIRE_PG=1, which fails the suite.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { freemem, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import pg from "pg";
import {
  loadMigrations as loadIndexMigrations,
  pgliteExecutor,
  pgPoolExecutor,
  runMigrations as runIndexMigrations,
  type SqlExecutor,
} from "@pine/indexer-native";
import { main as indexMigrateMain } from "@pine/indexer-native/migrate-cli";
import type { Database } from "../../../src/contracts/app.js";
import { loadMigrations as loadApiMigrations, runMigrations as runApiMigrations } from "../../../src/contracts/migrations.js";
import type { PlatformSecrets } from "../../../src/contracts/platform.js";
import { productionDependencies } from "../../../src/main.js";
import { main as apiMigrateMain, processIo as apiMigrateIo } from "../../../src/migrate.js";
import { acquireDirLock, releaseDirLock } from "../../../src/platform/core/testing/dir-lock.js";
import { testSettings } from "../../../src/platform/core/testing/harness.js";
import type { DatabaseConnection } from "../../../src/platform/core/server.js";
import { productionReadModelIo, type ReadModelIo } from "../../../src/readmodel.js";
import { createRedactor } from "../../../src/contracts/redact.js";
import { assertDisposableCluster, closeE2eDatabase, dropE2eDatabase } from "./cluster.js";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

export type DatabaseMode = "postgres" | "pglite";

/** Which database the suite runs on; throws when PINE_E2E_REQUIRE_PG=1 and no URL is configured. */
export function databaseMode(env: Readonly<Record<string, string | undefined>> = process.env): DatabaseMode {
  const url = env.PINE_E2E_DATABASE_URL;
  if (url !== undefined && url.trim() !== "") return "postgres";
  if (env.PINE_E2E_REQUIRE_PG === "1") throw new Error("PINE_E2E_REQUIRE_PG=1 but PINE_E2E_DATABASE_URL is not set: the e2e suite must run on real PostgreSQL 16");
  return "pglite";
}

export interface E2eDatabase {
  mode: DatabaseMode;
  /** The file's database name (pine_e2e_<hex> on Postgres). */
  name: string;
  /** The API's connection (pine_api on Postgres) and its URL (PINE_DATABASE_URL). */
  api: DatabaseConnection;
  apiUrl: string;
  /** Opens another API connection (a second API process; Postgres only). */
  connectApi(): Promise<DatabaseConnection>;
  /** Writes of the indexer (pine_indexer on Postgres): applyEvents, cursor, halts. */
  indexer: SqlExecutor;
  /** The read-model connection URL (pine_readonly on Postgres) and the I/O the read-model factory uses for it. */
  readModelUrl: string;
  readModelIo: ReadModelIo;
  /** Secret strings this database setup introduced (URLs with passwords): they must never reach a response or log. */
  secrets: string[];
  /** Test-only superuser access to the file's database (Postgres) or the PGlite instance. */
  admin: SqlExecutor;
  close(): Promise<void>;
}

// ------------------------------------------------------------------------------------------------ PGlite

// One PGlite peaks near 1.1 GB while it initialises. e2e files hold this lock for the database's lifetime (a dead owner
// is taken over) and wait, bounded, for available memory first: scheduling only, no test outcome depends on it.
const PGLITE_LOCK_DIR = path.join(tmpdir(), "pine-api-e2e-pglite.lock");
const MIN_AVAILABLE_BYTES = 1_400_000_000;
const MEMORY_WAIT_MS = 180_000;
// Small buffers: the e2e data is tiny (as in @pine/indexer-native's own PGlite harness).
const POSTGRESQL_CONF = ["shared_buffers = 16MB", "work_mem = 1MB", "maintenance_work_mem = 8MB", "wal_buffers = 1MB", "temp_buffers = 1MB"];

async function openPglite(): Promise<E2eDatabase> {
  await acquireDirLock(PGLITE_LOCK_DIR, { timeoutMs: 30 * 60_000, pollMs: 200, ownPid: "take", name: "e2e PGlite database" });
  const deadline = Date.now() + MEMORY_WAIT_MS;
  while (freemem() < MIN_AVAILABLE_BYTES && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1_000));
  let client: PGlite | null = null;
  const release = async () => {
    try {
      await client?.close();
    } finally {
      releaseDirLock(PGLITE_LOCK_DIR);
    }
  };
  try {
    client = new PGlite({ postgresqlconf: POSTGRESQL_CONF });
    await client.waitReady;
    const executor = pgliteExecutor(client);
    // Both migration runners, in the order the deployment runs them (API groups, then pine_index).
    await runApiMigrations(executor, await loadApiMigrations());
    await runIndexMigrations(executor, await loadIndexMigrations());
    const database = { db: drizzle(client) as unknown as Database, sql: executor, close: release };
    const readModelUrl = "postgres://pine_readonly:pglite-readonly-password-0000@pglite.invalid/pine";
    const apiUrl = "postgres://pine_api:pglite-api-password-000000@pglite.invalid/pine";
    return {
      mode: "pglite",
      name: "pglite",
      api: { db: database.db, sql: database.sql, close: async () => undefined },
      apiUrl,
      connectApi: () => Promise.reject(new Error("a second API connection needs real Postgres")),
      indexer: executor,
      readModelUrl,
      readModelIo: {
        connectNative: async (url) => {
          if (url !== readModelUrl) throw new Error("the read model connected with an unexpected URL");
          return { executor, close: async () => undefined };
        },
      },
      secrets: [readModelUrl, apiUrl],
      admin: executor,
      close: () => database.close(),
    };
  } catch (error) {
    await release();
    throw error;
  }
}

// ------------------------------------------------------------------------------------------------ PostgreSQL 16

const ROLE_LOCK_KEY = 0x70696e65; // "pine"
export const E2E_ROLES = ["pine_migrator", "pine_api", "pine_indexer", "pine_readonly"] as const;
type Role = (typeof E2E_ROLES)[number];

/** Fixed per-role test passwords (a disposable cluster); every parallel file sets the same value, so races are harmless. */
const passwordOf = (role: Role): string => `${role.replace("_", "-")}-e2e-password-2026`;

function onDatabase(adminUrl: string, database: string): URL {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url;
}

function roleUrl(adminUrl: string, role: Role, database: string): string {
  const url = onDatabase(adminUrl, database);
  url.username = role;
  url.password = passwordOf(role);
  return url.toString();
}

async function adminClient(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, application_name: "pine-e2e-admin" });
  client.on("error", () => undefined);
  await client.connect();
  return client;
}

/** Statements of deploy/postgres/01-database.sql with the psql variable substituted, one at a time. */
function databaseStatements(database: string): string[] {
  const text = readFileSync(path.join(REPO_ROOT, "deploy", "postgres", "01-database.sql"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replaceAll(':"pine_db"', `"${database}"`);
  return text
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Sets fixed test passwords on the production role names: openPostgres runs assertDisposableCluster before it. */
async function bootstrapRoles(admin: pg.Client): Promise<void> {
  await admin.query("SELECT pg_advisory_lock($1)", [ROLE_LOCK_KEY]);
  try {
    await admin.query(readFileSync(path.join(REPO_ROOT, "deploy", "postgres", "00-roles.sql"), "utf8"));
    for (const role of E2E_ROLES) await admin.query(`ALTER ROLE ${role} PASSWORD '${passwordOf(role)}'`);
  } finally {
    await admin.query("SELECT pg_advisory_unlock($1)", [ROLE_LOCK_KEY]);
  }
}

function silentIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err };
}

type Env = Readonly<Record<string, string | undefined>>;

async function openPostgres(adminUrl: string, env: Env): Promise<E2eDatabase> {
  // The guard of bootstrapRoles, before the cluster is even contacted.
  assertDisposableCluster(adminUrl, env);
  const name = `pine_e2e_${randomBytes(6).toString("hex")}`;
  const admin = await adminClient(adminUrl);
  const pools: pg.Pool[] = [];
  const connections: DatabaseConnection[] = [];
  let created = false;
  let fileAdmin: pg.Client | null = null;
  const redact = createRedactor([adminUrl, ...E2E_ROLES.map(passwordOf)]);
  // Idempotent: a second close() returns the first one's outcome.
  let closing: Promise<void> | null = null;
  const cleanup = () =>
    (closing ??= closeE2eDatabase({
      disconnect: [
        ...connections.splice(0).map((connection) => () => connection.close()),
        ...pools.splice(0).map((pool) => () => pool.end()),
        async () => fileAdmin?.end(),
      ],
      drop: created ? () => dropE2eDatabase((sql) => admin.query(sql), name, redact) : null,
      endAdmin: () => admin.end(),
      redact,
    }));
  try {
    await bootstrapRoles(admin);
    for (const statement of databaseStatements(name)) {
      await admin.query(statement);
      created = true;
    }
    const migratorUrl = roleUrl(adminUrl, "pine_migrator", name);

    // The real migrate commands, as pine_migrator (the database owner).
    const api = silentIo();
    const apiExit = { code: -1 };
    await apiMigrateMain({ PINE_MIGRATOR_DATABASE_URL: migratorUrl }, { ...apiMigrateIo, stdout: (text) => void api.out.push(text), stderr: (text) => void api.err.push(text), exit: (code) => void (apiExit.code = code) });
    if (apiExit.code !== 0) throw new Error(`API migrations failed: ${api.err.join("")}`);
    const index = silentIo();
    const indexExit = await indexMigrateMain({ MIGRATION_DATABASE_URL: migratorUrl }, { stdout: (line) => void index.out.push(line), stderr: (line) => void index.err.push(line) });
    if (indexExit !== 0) throw new Error(`indexer migrations failed: ${index.err.join("")}`);

    const settings = testSettings({ databasePoolMax: 10 });
    const apiUrl = roleUrl(adminUrl, "pine_api", name);
    const connectApi = async () => {
      const connection = await productionDependencies.connect({ secrets: { databaseUrl: apiUrl } as PlatformSecrets, settings });
      connections.push(connection);
      return connection;
    };
    const apiConnection = await connectApi();
    const indexerPool = new pg.Pool({ connectionString: roleUrl(adminUrl, "pine_indexer", name), max: 4, application_name: "pine-e2e-indexer" });
    indexerPool.on("error", () => undefined);
    pools.push(indexerPool);
    fileAdmin = await adminClient(onDatabase(adminUrl, name).toString());
    const adminExecutor: SqlExecutor = {
      exec: async (sql) => void (await fileAdmin?.query(sql)),
      query: async <T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => ((await fileAdmin?.query(sql, [...params]))?.rows ?? []) as T[],
      transaction: () => Promise.reject(new Error("not supported")),
    };
    const readModelUrl = roleUrl(adminUrl, "pine_readonly", name);
    return {
      mode: "postgres",
      name,
      api: apiConnection,
      apiUrl,
      connectApi,
      indexer: pgPoolExecutor(indexerPool),
      readModelUrl,
      readModelIo: productionReadModelIo,
      secrets: [adminUrl, migratorUrl, apiUrl, readModelUrl, roleUrl(adminUrl, "pine_indexer", name), ...E2E_ROLES.map(passwordOf)],
      admin: adminExecutor,
      close: cleanup,
    };
  } catch (error) {
    const cleanupError = await cleanup().then(
      () => null,
      (failure: unknown) => failure,
    );
    if (cleanupError !== null) throw new AggregateError([error, cleanupError], "e2e database setup failed, and so did its cleanup", { cause: error });
    throw error;
  }
}

export async function openE2eDatabase(env: Env = process.env): Promise<E2eDatabase> {
  const mode = databaseMode(env);
  if (mode === "postgres") return openPostgres(env.PINE_E2E_DATABASE_URL ?? "", env);
  return openPglite();
}
