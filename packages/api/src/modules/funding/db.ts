// SQL helpers of the funding module. Raw parameterised SQL through drizzle's `sql` tag; driver-portable by construction
// (PGlite in tests, node-postgres in production): int8/numeric values are selected as text and parsed, timestamps as
// epoch milliseconds text, and compare-and-set success is read only from RETURNING rows (never rowCount).

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
