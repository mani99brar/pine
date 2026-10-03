// Minimal SQL executor shared by the migration runner, applyEvents, the read model and the poller. node-postgres (production)
// and PGlite (tests) both satisfy it through the adapters below. Portability rules: never read rowCount/affectedRows (use
// RETURNING), cast int8/numeric/count to text in SELECTs and pass bigints as decimal strings.

export type SqlRow = Record<string, unknown>;

export interface SqlExecutor {
  /** Executes one or more statements without parameters. */
  exec(sql: string): Promise<void>;
  /** Executes one parameterised statement and returns its rows. */
  query<T extends SqlRow = SqlRow>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs `fn` in a transaction on one connection; rolls back when it throws. Not reentrant. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** The subset of the PGlite API the adapter needs (kept structural so production code never imports PGlite). */
export interface PGliteLike {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: PGliteTransactionLike) => Promise<T>): Promise<T>;
}

export interface PGliteTransactionLike {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

class NestedTransactionError extends Error {
  constructor() {
    super("Nested transactions are not supported");
    this.name = "NestedTransactionError";
  }
}

export function pgliteExecutor(db: PGliteLike): SqlExecutor {
  return {
    async exec(sql) {
      await db.exec(sql);
    },
    async query<T extends SqlRow>(sql: string, params: readonly unknown[] = []) {
      return (await db.query<T>(sql, [...params])).rows;
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>) {
      return db.transaction(async (inner) => fn(pgliteTransactionExecutor(inner)));
    },
  };
}

function pgliteTransactionExecutor(tx: PGliteTransactionLike): SqlExecutor {
  return {
    async exec(sql) {
      await tx.exec(sql);
    },
    async query<T extends SqlRow>(sql: string, params: readonly unknown[] = []) {
      return (await tx.query<T>(sql, [...params])).rows;
    },
    async transaction() {
      throw new NestedTransactionError();
    },
  };
}

/** The subset of node-postgres' Pool the adapter needs (structural, so tests can pass a stub Pool/PoolClient). */
export interface PgPoolLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  connect(): Promise<PgClientLike>;
}

export interface PgClientLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  release(destroy?: boolean | Error): void;
}

export function pgPoolExecutor(pool: PgPoolLike): SqlExecutor {
  return {
    async exec(sql) {
      await pool.query(sql);
    },
    async query<T extends SqlRow>(sql: string, params: readonly unknown[] = []) {
      return (await pool.query<T>(sql, [...params])).rows;
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>) {
      const client = await pool.connect();
      let result: T;
      try {
        await client.query("BEGIN");
        result = await fn(pgClientExecutor(client));
        await client.query("COMMIT");
      } catch (error) {
        // A failed ROLLBACK leaves the connection in an unknown state: destroy it instead of returning it to the pool.
        const rolledBack = await client.query("ROLLBACK").then(
          () => true,
          () => false,
        );
        client.release(!rolledBack);
        throw error;
      }
      client.release();
      return result;
    },
  };
}

function pgClientExecutor(client: PgClientLike): SqlExecutor {
  return {
    async exec(sql) {
      await client.query(sql);
    },
    async query<T extends SqlRow>(sql: string, params: readonly unknown[] = []) {
      return (await client.query<T>(sql, [...params])).rows;
    },
    async transaction() {
      throw new NestedTransactionError();
    },
  };
}
