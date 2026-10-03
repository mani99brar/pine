// Small driver-neutral helpers over the drizzle handle. Production runs node-postgres, tests PGlite: results are read
// only from returned rows (never rowCount), counts and int8 values are cast in SQL, and timestamps are bound as ISO
// strings with explicit ::timestamptz casts.

import type { SQL } from "drizzle-orm";
import type { Database } from "../../contracts/app.js";

/** The drizzle handle or a transaction handle (inside a transaction always pass `tx`, never `ctx.db`). */
export type Executor = Pick<Database, "execute">;

export async function queryRows<T extends Record<string, unknown>>(db: Executor, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows?: unknown };
  return Array.isArray(result.rows) ? (result.rows as T[]) : [];
}

export async function queryOne<T extends Record<string, unknown>>(db: Executor, query: SQL): Promise<T | null> {
  const rows = await queryRows<T>(db, query);
  return rows[0] ?? null;
}

export function iso(date: Date): string {
  return date.toISOString();
}

/** Drivers return timestamptz as Date (pg, PGlite) or string; normalise. */
export function toDate(value: unknown): Date {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  throw new Error("Unexpected timestamp value from the database");
}
