// Raw-SQL helpers shared by the gateways. Portable between node-postgres (production) and PGlite (tests): rows are read
// only from `.rows` (statements that compare-and-set use RETURNING), int8/count/timestamp columns are cast explicitly in
// SQL (`::text`, `::int`, epoch milliseconds as text) and parsed here, and timestamps are always bound parameters.

import type { SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../contracts/app.js";

/** Anything with drizzle's `execute` (the database or a transaction handle). */
export interface Executor {
  execute(query: SQLWrapper): PromiseLike<unknown>;
}

const resultShape = z.object({ rows: z.array(z.record(z.string(), z.unknown())) });

/** Runs a statement and validates every returned row with `schema`. */
export async function queryRows<T>(db: Executor, query: SQLWrapper, schema: z.ZodType<T>): Promise<T[]> {
  const result = resultShape.parse(await db.execute(query));
  return result.rows.map((row) => schema.parse(row));
}

export async function execute(db: Executor, query: SQLWrapper): Promise<void> {
  await db.execute(query);
}

/** Runs `fn` in a transaction; inside it only `tx` may be used (a nested `db` query deadlocks PGlite). */
export async function inTransaction<T>(db: Database, fn: (tx: Executor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx));
}

/** int8 selected as `::text`. */
export const int8Text = z
  .string()
  .regex(/^-?\d{1,19}$/)
  .transform((value) => Number(value))
  .refine((value) => Number.isSafeInteger(value), "integer out of range");

/** Epoch milliseconds selected as text: `(extract(epoch from col) * 1000)::bigint::text`, or null. */
export const epochMsText = z
  .string()
  .regex(/^-?\d{1,16}$/)
  .transform((value) => new Date(Number(value)));

export const bytesColumn = z.instanceof(Uint8Array).transform((value) => new Uint8Array(value));

/** SQLSTATE of a database error; drizzle wraps driver errors (DrizzleQueryError) with the original as `cause`. */
export function sqlState(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
