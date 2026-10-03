// Core housekeeping job (PRD-02 2.5a): purges expired nonces, pre-sessions and sessions, rate-limit windows older than
// one hour and quota windows older than two days, in bounded batches, then nulls audit IPs older than 30 days through
// the SECURITY DEFINER retention function. It never touches gateway tables (OAuth states are purged by a gateways job).

import { sql, type SQL } from "drizzle-orm";
import type { AppContext, JobDefinition } from "../../contracts/app.js";
import { iso, queryRows } from "./db.js";

export const CLEANUP_BATCH = 1_000;
const MAX_BATCHES = 50;

export interface CleanupResult {
  nonces: number;
  presessions: number;
  sessions: number;
  rateLimitWindows: number;
  quotaWindows: number;
  auditIps: number;
}

async function drain(ctx: AppContext, signal: AbortSignal, statement: () => SQL): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES && !signal.aborted; batch += 1) {
    const rows = await queryRows<{ n: number }>(ctx.db, statement());
    const count = Number(rows[0]?.n ?? 0);
    total += count;
    if (count < CLEANUP_BATCH) break;
  }
  return total;
}

export async function runCleanup(ctx: AppContext, signal: AbortSignal): Promise<CleanupResult> {
  const now = iso(ctx.clock.now());
  const hourAgo = iso(new Date(ctx.clock.now().getTime() - 3_600_000));
  const twoDaysAgo = iso(new Date(ctx.clock.now().getTime() - 2 * 86_400_000));
  const result: CleanupResult = { nonces: 0, presessions: 0, sessions: 0, rateLimitWindows: 0, quotaWindows: 0, auditIps: 0 };
  result.nonces = await drain(
    ctx,
    signal,
    () => sql`WITH gone AS (DELETE FROM siwe_nonces WHERE nonce IN (SELECT nonce FROM siwe_nonces WHERE expires_at <= ${now}::timestamptz LIMIT ${CLEANUP_BATCH}) RETURNING 1)
              SELECT count(*)::int AS n FROM gone`,
  );
  result.presessions = await drain(
    ctx,
    signal,
    () => sql`WITH gone AS (DELETE FROM siwe_presessions WHERE id IN (SELECT id FROM siwe_presessions WHERE expires_at <= ${now}::timestamptz LIMIT ${CLEANUP_BATCH}) RETURNING 1)
              SELECT count(*)::int AS n FROM gone`,
  );
  result.sessions = await drain(
    ctx,
    signal,
    () => sql`WITH gone AS (DELETE FROM sessions WHERE id IN (
                SELECT id FROM sessions WHERE idle_expires_at <= ${now}::timestamptz OR absolute_expires_at <= ${now}::timestamptz LIMIT ${CLEANUP_BATCH}
              ) RETURNING 1)
              SELECT count(*)::int AS n FROM gone`,
  );
  result.rateLimitWindows = await drain(
    ctx,
    signal,
    () => sql`WITH gone AS (DELETE FROM rate_limit_windows WHERE (key, window_start) IN (
                SELECT key, window_start FROM rate_limit_windows WHERE window_start < ${hourAgo}::timestamptz LIMIT ${CLEANUP_BATCH}
              ) RETURNING 1)
              SELECT count(*)::int AS n FROM gone`,
  );
  result.quotaWindows = await drain(
    ctx,
    signal,
    () => sql`WITH gone AS (DELETE FROM quota_usage WHERE (user_id, quota, window_start) IN (
                SELECT user_id, quota, window_start FROM quota_usage WHERE window_start < ${twoDaysAgo}::timestamptz LIMIT ${CLEANUP_BATCH}
              ) RETURNING 1)
              SELECT count(*)::int AS n FROM gone`,
  );
  result.auditIps = await drain(ctx, signal, () => sql`SELECT pine_audit_expire_ips(${CLEANUP_BATCH}::integer)::int AS n`);
  return result;
}

export const cleanupJob: JobDefinition = {
  name: "platform.cleanup",
  intervalMs: 5 * 60_000,
  async run(ctx, signal) {
    const result = await runCleanup(ctx, signal);
    for (const [table, count] of Object.entries(result)) {
      if (count > 0) ctx.metrics.increment("cleanup_runs_with_deletions", { table });
    }
  },
};
