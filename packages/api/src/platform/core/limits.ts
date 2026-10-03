// Postgres fixed windows: per-user quotas (QuotaGateway) and request rate limits (PRD-02 2.2 stage 2, 2.4). Each
// consume is ONE atomic statement whose conflict branch only increments while the limit holds (PRD-02 2.5a); success is
// read from the returned rows only.

import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import type { Clock, Database, QuotaGateway, QuotaName } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import type { QuotaSetting } from "./config.js";
import { iso, queryRows, type Executor } from "./db.js";

export function windowStart(now: Date, windowSeconds: number): Date {
  const size = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / size) * size);
}

export function secondsUntilWindowEnd(now: Date, windowSeconds: number): number {
  const end = windowStart(now, windowSeconds).getTime() + windowSeconds * 1000;
  return Math.max(1, Math.ceil((end - now.getTime()) / 1000));
}

export class PostgresQuotas implements QuotaGateway {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly limits: Record<QuotaName, QuotaSetting>,
  ) {}

  async consume(userId: string, quota: QuotaName, amount = 1): Promise<void> {
    const setting = this.limits[quota];
    if (!setting) throw new ApiError("INTERNAL", "Unknown quota");
    if (!Number.isSafeInteger(amount) || amount < 1) throw new ApiError("BAD_REQUEST", "Invalid quota amount");
    const now = this.clock.now();
    const retryAfterSeconds = secondsUntilWindowEnd(now, setting.windowSeconds);
    // A single request larger than the whole limit can never succeed; refuse before writing anything.
    if (amount > setting.limit) throw new ApiError("QUOTA_EXCEEDED", `Quota ${quota} exceeded`, { retryAfterSeconds });
    const start = windowStart(now, setting.windowSeconds);
    const rows = await queryRows<{ used: string }>(
      this.db,
      sql`INSERT INTO quota_usage (user_id, quota, window_start, used)
          VALUES (${userId}::uuid, ${quota}, ${iso(start)}::timestamptz, ${amount}::bigint)
          ON CONFLICT (user_id, quota, window_start)
          DO UPDATE SET used = quota_usage.used + EXCLUDED.used
          WHERE quota_usage.used + EXCLUDED.used <= ${setting.limit}::bigint
          RETURNING used::text AS used`,
    );
    if (rows.length === 0) throw new ApiError("QUOTA_EXCEEDED", `Quota ${quota} exceeded`, { retryAfterSeconds });
  }
}

export interface RateLimitKey {
  key: string;
  limit: number;
}

export const RATE_WINDOW_SECONDS = 60;

/**
 * Consumes one request from every key in ONE all-or-nothing statement (PRD-02 3b): the CTE finds any key already at
 * its limit, and then nothing is inserted or incremented, so a refused request never consumes another window's budget.
 * Throws RATE_LIMITED (with Retry-After) when any key is exhausted. The per-row WHERE of the conflict branch still
 * re-checks each limit on the latest row version, so concurrent requests never push a key past its limit; only a
 * request racing another one at the very limit can see some of its keys incremented (bounded, fails closed).
 */
export async function consumeRateLimits(db: Executor, now: Date, keys: readonly RateLimitKey[]): Promise<void> {
  const unique = new Map<string, number>();
  for (const item of keys) {
    const key = item.key.slice(0, 512);
    unique.set(key, Math.min(unique.get(key) ?? Number.MAX_SAFE_INTEGER, item.limit));
  }
  if (unique.size === 0) return;
  const retryAfterSeconds = secondsUntilWindowEnd(now, RATE_WINDOW_SECONDS);
  const entries = [...unique.entries()];
  if (entries.some(([, limit]) => limit < 1)) throw new ApiError("RATE_LIMITED", "Too many requests", { retryAfterSeconds });
  const start = iso(windowStart(now, RATE_WINDOW_SECONDS));
  const input = sql.join(
    entries.map(([key, limit]) => sql`(${key}::text, ${limit}::integer)`),
    sql`, `,
  );
  const limitCase = sql.join(
    entries.map(([key, limit]) => sql`WHEN ${key} THEN ${limit}::integer`),
    sql` `,
  );
  const rows = await queryRows<{ key: string }>(
    db,
    sql`WITH input (key, lim) AS (VALUES ${input}),
        exhausted AS (
          SELECT 1 FROM input
          LEFT JOIN rate_limit_windows w ON w.key = input.key AND w.window_start = ${start}::timestamptz
          WHERE COALESCE(w.count, 0) >= input.lim
          LIMIT 1
        )
        INSERT INTO rate_limit_windows (key, window_start, count)
        SELECT input.key, ${start}::timestamptz, 1 FROM input WHERE NOT EXISTS (SELECT 1 FROM exhausted)
        ON CONFLICT (key, window_start)
        DO UPDATE SET count = rate_limit_windows.count + 1
        WHERE rate_limit_windows.count < (CASE EXCLUDED.key ${limitCase} ELSE 0 END)
        RETURNING key`,
  );
  const granted = new Set(rows.map((row) => row.key));
  if (entries.some(([key]) => !granted.has(key))) throw new ApiError("RATE_LIMITED", "Too many requests", { retryAfterSeconds });
}

/**
 * Client bucket for per-address windows: an IPv4 address as is (IPv4-mapped IPv6 included), an IPv6 address as its
 * /64 prefix (one subscriber usually holds a whole /64), anything else truncated as is.
 */
export function ipBucket(ip: string): string {
  const address = (ip.split("%")[0] ?? "").toLowerCase();
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return address.slice(0, 64);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)?.[1];
  if (mapped !== undefined && isIP(mapped) === 4) return mapped;
  // An embedded IPv4 tail fills the last two groups, which never reach the /64 prefix.
  const groups = (part: string) => (part === "" ? [] : part.split(":").flatMap((group) => (group.includes(".") ? ["0", "0"] : [group])));
  const [head = "", tail] = address.split("::");
  const front = groups(head);
  const back = tail === undefined ? [] : groups(tail);
  const full = tail === undefined ? front : [...front, ...new Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${full
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}
