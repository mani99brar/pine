// node-postgres adapters (production). The API pool runs as the DML-only runtime role with statement and lock
// timeouts; migrations use a separate single client as the migrator role (src/migrate.ts).

import pg from "pg";
import type { SqlExecutor } from "../../contracts/migrations.js";

/**
 * Waiting for a free connection gives up well below the default lease renewal period (60 s / 3), so a starved pool
 * surfaces as a failed renewal and the jobs runner's local deadline aborts the run before its lease can expire.
 */
export const POOL_CONNECTION_TIMEOUT_MS = 5_000;

export interface PoolSettings {
  connectionString: string;
  max: number;
  applicationName: string;
}

export function createPool(settings: PoolSettings): pg.Pool {
  return new pg.Pool({
    connectionString: settings.connectionString,
    max: settings.max,
    application_name: settings.applicationName,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 30_000,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
  });
}

/** SqlExecutor over one checked-out client (transactions stay on that connection). */
export function clientExecutor(client: pg.ClientBase): SqlExecutor {
  const executor: SqlExecutor = {
    async exec(sql) {
      await client.query(sql);
    },
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const result = await client.query<T>(sql, params);
      return result.rows;
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      await client.query("BEGIN");
      try {
        const value = await fn(executor);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    },
  };
  return executor;
}

/** SqlExecutor over a pool: plain queries use any connection, a transaction checks one client out. */
export function poolExecutor(pool: pg.Pool): SqlExecutor {
  return {
    async exec(sql) {
      await pool.query(sql);
    },
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const result = await pool.query<T>(sql, params);
      return result.rows;
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        return await clientExecutor(client).transaction(fn);
      } finally {
        client.release();
      }
    },
  };
}
