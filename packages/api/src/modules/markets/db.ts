// SQL helpers of the markets module. Raw parameterised SQL through drizzle's `sql` tag; driver-portable (PGlite in
// tests, node-postgres in production): int8/numeric values are selected as text, timestamps as epoch milliseconds,
// and compare-and-set success is read only from RETURNING rows (never rowCount).

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

/** jsonb parameter; bigint values are stored as decimal strings (API strings are decimal). */
export const jsonb = (value: unknown): SQL => sql`${JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString(10) : item))}::jsonb`;

/** A jsonb column value as returned by either driver (object, or text for some drivers). */
export function fromJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
