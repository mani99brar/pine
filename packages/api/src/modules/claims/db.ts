// SQL helpers shared by the claims module. Raw parameterised SQL through drizzle's `sql` tag; driver-portable by
// construction (PGlite in tests, node-postgres in production): int8/numeric values are selected as text and parsed,
// timestamps are selected as epoch milliseconds, and compare-and-set success is read only from RETURNING rows.

import { sql, type SQL } from "drizzle-orm";

export { sql, type SQL };

/** Anything that can run a query: the database handle or a transaction (inside a transaction use only the tx). */
export interface Executor {
  execute(query: SQL): PromiseLike<unknown>;
}

export async function rows<T>(db: Executor, query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  const list = (result as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(list)) throw new Error("Unexpected database driver result");
  return list as T[];
}

export async function one<T>(db: Executor, query: SQL): Promise<T | null> {
  return (await rows<T>(db, query))[0] ?? null;
}

/** Binds a Date as timestamptz (business time always comes from ctx.clock, never SQL now()). */
export const ts = (date: Date): SQL => sql`${date.toISOString()}::timestamptz`;

/** Selects a timestamptz column as epoch milliseconds text (parse with fromMs). */
export const msOf = (column: SQL): SQL => sql`(floor(extract(epoch from ${column}) * 1000))::bigint::text`;

export const fromMs = (value: unknown): Date => new Date(Number(String(value)));

export const toNumber = (value: unknown): number => {
  const parsed = Number(String(value));
  if (!Number.isSafeInteger(parsed)) throw new Error("Database value is not a safe integer");
  return parsed;
};

export const toBigInt = (value: unknown): bigint => BigInt(String(value));

export const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw new Error("Database value is not bytea");
};

/** Postgres SQLSTATE of an error (drizzle may wrap the driver error in `cause`). */
export function sqlState(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export const FOREIGN_KEY_VIOLATION = "23503";
/** ON DELETE RESTRICT on the parent side (Postgres raises this instead of 23503 for RESTRICT). */
export const RESTRICT_VIOLATION = "23001";
export const UNIQUE_VIOLATION = "23505";
export const SERIALIZATION_FAILURE = "40001";
export const DEADLOCK_DETECTED = "40P01";
