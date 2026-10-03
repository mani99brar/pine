import "./lock.js";
import net from "node:net";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimCreated, EventBuilder, SCENARIO_ADDRESSES } from "@pine/shared/testing/read-model-scenarios";
import { PROCESS_LOCK_KEY, runIndexer, type IndexerDeps, type ProcessPool } from "../src/app.js";
import { pgPoolExecutor, type PgClientLike, type SqlExecutor } from "../src/db.js";
import { INDEX_MIGRATION_LOCK_KEY, loadMigrations, MigrationError, runMigrations, type MigrationFile } from "../src/migrations.js";
import { createNativeReadModel } from "../src/read-model.js";
import type { HttpProviderOptions, RpcProvider } from "../src/rpc.js";
import { openDatabase, type TestDatabase } from "./harness.js";
import { ScriptedChain, ScriptedProvider } from "./scripted-rpc.js";

// main.ts wiring (PRD-05 section 3a): every startup step runs inside the guarded try and logs through the redactor; the
// process advisory lock and the migration runner's advisory lock are proven with stub executors that record the lock
// statements and report "not acquired" (PGlite has one session and cannot show contention; real Postgres contention is
// covered by the assembly e2e); the node-postgres executor rolls back and releases its client when the callback throws.

const DB_PASSWORD = "s3cretDbPassw0rd";
const RPC_KEY = "rpcKEY0123456789abcdef";
const ENV = {
  DATABASE_URL: `postgres://pine_indexer:${DB_PASSWORD}@db.internal:5432/pine`,
  RPC_PRIMARY_URL: `https://gnosis.rpc-one.example/v1/${RPC_KEY}`,
  RPC_SECONDARY_URL: "https://rpc.gnosischain.com",
  CHAIN_ID: "100",
  CLAIM_REGISTRY_ADDRESS: SCENARIO_ADDRESSES.claimRegistry,
  EVIDENCE_REGISTRY_ADDRESS: SCENARIO_ADDRESSES.evidenceRegistry,
  REALITY_ADDRESS: SCENARIO_ADDRESSES.reality,
  CONDITIONAL_TOKENS_ADDRESS: SCENARIO_ADDRESSES.conditionalTokens,
  KLEROS_HOME_PROXY_ADDRESS: SCENARIO_ADDRESSES.klerosHomeProxy,
  DEPLOYMENT_BLOCK: "1000",
  POLL_INTERVAL_MS: "500",
};

function output(): { stream: Writable; text: () => string } {
  const lines: string[] = [];
  return {
    stream: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString("utf8"));
        callback();
      },
    }),
    text: () => lines.join(""),
  };
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(DB_PASSWORD);
  expect(text).not.toContain(RPC_KEY);
}

interface StubPool extends ProcessPool {
  statements: string[];
  released: unknown[];
  ended: boolean;
  errorListeners: ((error: Error) => void)[];
}

/** A stub node-postgres pool: the migration ledger is up to date; `lockAcquired` decides pg_try_advisory_lock. */
async function stubPool(
  options: { lockAcquired?: boolean; connectError?: Error; queryError?: Error; ledger?: (files: MigrationFile[]) => MigrationFile[]; releaseError?: Error } = {},
): Promise<StubPool> {
  const all = await loadMigrations();
  const files = options.ledger ? options.ledger(all) : all;
  const statements: string[] = [];
  const released: unknown[] = [];
  const answer = async <T,>(sql: string): Promise<{ rows: T[] }> => {
    statements.push(sql);
    if (options.queryError) throw options.queryError;
    if (sql.includes("to_regclass")) return { rows: [{ present: true }] as T[] };
    if (sql.includes("FROM pine_index.schema_migrations")) return { rows: files.map((file) => ({ id: file.name, checksum: file.checksum })) as T[] };
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: options.lockAcquired ?? false }] as T[] };
    return { rows: [] };
  };
  const pool: StubPool = {
    statements,
    released,
    ended: false,
    query: answer,
    async connect(): Promise<PgClientLike> {
      if (options.connectError) throw options.connectError;
      return {
        query: answer,
        release: (destroy) => {
          released.push(destroy);
          if (options.releaseError) throw options.releaseError;
        },
      };
    },
    async end() {
      pool.ended = true;
    },
    on(_event, listener) {
      pool.errorListeners.push(listener);
    },
    errorListeners: [],
  };
  return pool;
}

function deps(pool: () => ProcessPool, extra: Partial<IndexerDeps> = {}, chainIds: Record<string, number> = {}): IndexerDeps & { providers: string[]; options: HttpProviderOptions[] } {
  const providers: string[] = [];
  const options: HttpProviderOptions[] = [];
  const out: IndexerDeps & { providers: string[]; options: HttpProviderOptions[] } = {
    providers,
    options,
    createPool: pool,
    createProvider: (provider) => {
      providers.push(provider.label);
      options.push(provider);
      const scripted = new ScriptedProvider(provider.label, new ScriptedChain(1_000n));
      scripted.chainIdValue = chainIds[provider.label] ?? 100;
      return scripted;
    },
    loadMigrations: () => loadMigrations(),
    signal: AbortSignal.abort(),
    ...extra,
  };
  return out;
}

describe("runIndexer wiring: guarded, redacted startup", () => {
  it("refuses an invalid configuration, naming variables only", async () => {
    const log = output();
    const pool = await stubPool();
    expect(await runIndexer({ ...ENV, CHAIN_ID: "1" }, deps(() => pool, { logDestination: log.stream }))).toBe(1);
    expect(log.text()).toContain("refusing to start");
    expect(log.text()).toContain("CHAIN_ID");
    expectNoSecrets(log.text());
    expect(pool.statements).toEqual([]);
  });

  it("a pool construction (connection-string parsing) error is caught and redacted", async () => {
    const log = output();
    const code = await runIndexer(
      ENV,
      deps(
        () => {
          throw new TypeError(`Invalid URL: ${ENV.DATABASE_URL} (password ${DB_PASSWORD})`);
        },
        { logDestination: log.stream },
      ),
    );
    expect(code).toBe(1);
    expect(log.text()).toContain("indexer stopped");
    expectNoSecrets(log.text());
  });

  it("database errors (query and pool.connect) are logged redacted and stop the process", async () => {
    for (const failure of [{ queryError: new Error(`password authentication failed for ${ENV.DATABASE_URL}`) }, { connectError: new Error(`connect failed: ${ENV.DATABASE_URL}`) }]) {
      const log = output();
      const pool = await stubPool(failure);
      expect(await runIndexer(ENV, deps(() => pool, { logDestination: log.stream }))).toBe(1);
      expect(log.text()).toContain("[REDACTED]");
      expectNoSecrets(log.text());
      expect(pool.ended).toBe(true);
    }
  });

  it("the process advisory lock not acquired: refuses to run, never starts providers, releases everything", async () => {
    const log = output();
    const pool = await stubPool({ lockAcquired: false });
    const wiring = deps(() => pool, { logDestination: log.stream });
    expect(await runIndexer(ENV, wiring)).toBe(1);
    const lockStatements = pool.statements.filter((sql) => sql.includes("advisory"));
    expect(lockStatements).toEqual(["SELECT pg_try_advisory_lock($1) AS locked"]);
    expect(log.text()).toContain("another indexer process holds the single-writer lock");
    expect(wiring.providers).toEqual([]);
    expect(pool.released).toEqual([true]);
    expect(pool.ended).toBe(true);
    expect(PROCESS_LOCK_KEY).not.toBe(INDEX_MIGRATION_LOCK_KEY);
  });
});

describe("runIndexer wiring: providers, migrations, chain id, cleanup (operator gaps 2, 11, 23)", () => {
  async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  it("SEC-IDX-06 builds the primary from RPC_PRIMARY_URL and the secondary from RPC_SECONDARY_URL, each with the configured redactor", async () => {
    const log = output();
    const pool = await stubPool({ lockAcquired: true });
    const wiring = deps(() => pool, { logDestination: log.stream });
    expect(await runIndexer({ ...ENV, METRICS_PORT: String(await freePort()) }, wiring)).toBe(0);
    expect(wiring.options.map(({ label, url }) => ({ label, url }))).toEqual([
      { label: "primary", url: ENV.RPC_PRIMARY_URL },
      { label: "secondary", url: ENV.RPC_SECONDARY_URL },
    ]);
    for (const options of wiring.options) {
      // A bare key (no URL around it) is removed only because the config secrets are registered.
      expect(options.redact(`invalid key ${RPC_KEY}`)).not.toContain(RPC_KEY);
      expect(options.redact(`auth failed for ${DB_PASSWORD}`)).not.toContain(DB_PASSWORD);
    }
  });

  it.each([
    ["a pending migration (the last file is missing from the ledger)", (files: MigrationFile[]) => files.slice(0, -1), /Pending migrations/],
    ["a modified applied migration", (files: MigrationFile[]) => files.map((file, index) => (index === 0 ? { ...file, checksum: "0".repeat(64) } : file)), /modified/],
  ])("refuses to run with %s: exit 1, before the lock and before any provider", async (_label, ledger, message) => {
    const log = output();
    const pool = await stubPool({ lockAcquired: true, ledger });
    const wiring = deps(() => pool, { logDestination: log.stream });
    expect(await runIndexer(ENV, wiring)).toBe(1);
    expect(log.text()).toMatch(message);
    expect(pool.statements.some((sql) => sql.includes("pg_try_advisory_lock"))).toBe(false);
    expect(wiring.providers).toEqual([]);
    expect(pool.ended).toBe(true);
  });

  it("SEC-IDX-06 exits 1 when the secondary serves another chain id, and writes no cursor row", async () => {
    const log = output();
    const pool = await stubPool({ lockAcquired: true });
    const wiring = deps(() => pool, { logDestination: log.stream }, { secondary: 10_200 });
    expect(await runIndexer({ ...ENV, METRICS_PORT: String(await freePort()) }, wiring)).toBe(1);
    expect(log.text()).toContain("secondary RPC serves chain 10200");
    expect(pool.statements.some((sql) => /INSERT INTO pine_index\.(cursor|halts)/.test(sql))).toBe(false);
  });

  it("a lock connection whose release throws still resolves (never rejects) with exit code 1, logged redacted", async () => {
    const log = output();
    const pool = await stubPool({ lockAcquired: false, releaseError: new Error(`release failed for ${ENV.DATABASE_URL}`) });
    await expect(runIndexer(ENV, deps(() => pool, { logDestination: log.stream }))).resolves.toBe(1);
    expect(log.text()).toContain("releasing the lock connection failed");
    expectNoSecrets(log.text());
    expect(pool.ended).toBe(true);
  });

  it("an idle pool client 'error' is logged through the redactor and does not crash the process", async () => {
    const log = output();
    const pool = await stubPool({ lockAcquired: true });
    const wiring = deps(() => pool, {
      logDestination: log.stream,
      createProvider: (options) => {
        for (const listener of pool.errorListeners) listener(new Error(`terminating connection ${ENV.DATABASE_URL}`));
        return new ScriptedProvider(options.label, new ScriptedChain(1_000n));
      },
    });
    expect(await runIndexer({ ...ENV, METRICS_PORT: String(await freePort()) }, wiring)).toBe(0);
    expect(pool.errorListeners).toHaveLength(1);
    expect(log.text()).toContain("idle database client error");
    expect(log.text()).toContain("[REDACTED]");
    expectNoSecrets(log.text());
  });
});

describe("runIndexer end to end on PGlite with scripted providers", () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await openDatabase();
  });
  afterAll(async () => {
    await database.close();
  });

  async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  it("verifies migrations, takes the lock, serves health, indexes and stops on the signal", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "process");
    const chain = new ScriptedChain(created.blockNumber + 5n, [created]);
    const controller = new AbortController();
    const statements: string[] = [];
    const pg = database.pg;
    const pool: ProcessPool = {
      query: async <T,>(sql: string, params?: unknown[]) => {
        statements.push(sql);
        return pg.query<T>(sql, params);
      },
      connect: async () => ({
        query: async <T,>(sql: string, params?: unknown[]) => {
          statements.push(sql);
          return pg.query<T>(sql, params);
        },
        release: () => undefined,
      }),
      end: async () => undefined,
    };
    let health: number | null = null;
    const readiness: number[] = [];
    const port = await freePort();
    const providers: RpcProvider[] = [];
    const log = output();
    const code = await runIndexer(
      { ...ENV, METRICS_PORT: String(port) },
      {
        createPool: () => pool,
        createProvider: (options) => {
          const provider = new ScriptedProvider(options.label, options.label === "primary" ? chain : chain.clone());
          const finalized = provider.finalizedBlock.bind(provider);
          provider.finalizedBlock = async () => {
            if (options.label === "primary") {
              // Cycle 1 (nothing succeeded yet): /readyz 503. Cycle 2 (after a successful cycle): 200, then stop.
              readiness.push((await fetch(`http://127.0.0.1:${port}/readyz`)).status);
              if (readiness.length === 2) {
                health = (await fetch(`http://127.0.0.1:${port}/healthz`)).status;
                controller.abort();
              }
            }
            return finalized();
          };
          providers.push(provider);
          return provider;
        },
        loadMigrations: () => loadMigrations(),
        signal: controller.signal,
        logDestination: log.stream,
      },
    );
    expect(code).toBe(0);
    expect(health).toBe(200);
    expect(readiness).toEqual([503, 200]);
    // Migrations were verified (the ledger read) before the single-writer lock was taken.
    const ledger = statements.findIndex((sql) => sql.includes("FROM pine_index.schema_migrations"));
    const lock = statements.indexOf("SELECT pg_try_advisory_lock($1) AS locked");
    expect(ledger).toBeGreaterThanOrEqual(0);
    expect(ledger).toBeLessThan(lock);
    expect(statements).toContain("SELECT pg_try_advisory_lock($1) AS locked");
    expect(await createNativeReadModel(pgPoolExecutor(pool), { chainId: 100 }).getClaim(created.market)).not.toBeNull();
    expect(log.text()).toContain("indexer started");
    expectNoSecrets(log.text());
  });
});

describe("the migration runner's advisory lock", () => {
  it("not acquired: refuses with MigrationError and runs no DDL", async () => {
    const statements: string[] = [];
    const tx: SqlExecutor = {
      exec: async (sql) => void statements.push(`exec:${sql}`),
      query: async <T,>(sql: string) => {
        statements.push(sql);
        return (sql.includes("pg_try_advisory_xact_lock") ? [{ locked: false }] : []) as T[];
      },
      transaction: () => Promise.reject(new Error("nested")),
    };
    const executor: SqlExecutor = { ...tx, transaction: (fn) => fn(tx) };
    await expect(runMigrations(executor, await loadMigrations())).rejects.toThrow(MigrationError);
    expect(statements).toEqual(["SELECT pg_try_advisory_xact_lock($1) AS locked"]);
  });
});

describe("node-postgres executor (stub Pool/PoolClient)", () => {
  function stub(failing: string[] = []) {
    const statements: string[] = [];
    const released: unknown[] = [];
    const client: PgClientLike = {
      query: async <T,>(sql: string) => {
        statements.push(sql);
        if (failing.includes(sql)) throw new Error(`${sql} failed`);
        return { rows: [] as T[] };
      },
      release: (destroy) => void released.push(destroy),
    };
    const pool = { query: client.query, connect: async () => client };
    return { executor: pgPoolExecutor(pool), statements, released };
  }

  it("commits and releases the client once", async () => {
    const { executor, statements, released } = stub();
    expect(await executor.transaction(async (tx) => (await tx.query("SELECT 1")).length)).toBe(0);
    expect(statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
    expect(released).toEqual([undefined]);
  });

  it("rolls back and releases the client when the callback throws", async () => {
    const { executor, statements, released } = stub();
    await expect(
      executor.transaction(async (tx) => {
        await tx.query("INSERT 1");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(statements).toEqual(["BEGIN", "INSERT 1", "ROLLBACK"]);
    expect(released).toEqual([false]);
  });

  it("a failing ROLLBACK destroys the connection instead of returning it to the pool; a failing COMMIT rolls back", async () => {
    const rollbackFails = stub(["ROLLBACK"]);
    await expect(rollbackFails.executor.transaction(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(rollbackFails.released).toEqual([true]);
    const commitFails = stub(["COMMIT"]);
    await expect(commitFails.executor.transaction(async () => 1)).rejects.toThrow("COMMIT failed");
    expect(commitFails.statements).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
    expect(commitFails.released).toEqual([false]);
  });

  it("nested transactions are refused", async () => {
    const { executor } = stub();
    await expect(executor.transaction((tx) => tx.transaction(async () => 1))).rejects.toThrow(/Nested/);
  });
});
