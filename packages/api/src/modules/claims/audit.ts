// Audit outbox of the claims module (PRD-07 §3b with the flush design of §3, SEC-OPS-07). An audited write and its
// outbox row commit together: writes already inside ctx.db.transaction add the outbox INSERT as a second statement in
// that transaction (outboxInsert), bare single-statement writes carry it as a CTE (outboxSelect). flushAudit records the
// pending rows through the frozen AuditLog.record and deletes each one after it was recorded, so an audit outage never
// loses an entry. The guarantee is at-least-once: a crash between record and delete, or a flusher in another process,
// can only duplicate an entry, identified by its natural key ((action, subjectId), plus txHash for tx_reported).

import { randomUUID } from "node:crypto";
import type { AppContext, AuditEntry } from "../../contracts/app.js";
import { rows, sql, ts, type Executor, type SQL } from "./db.js";

export const AUDIT_FLUSH_BATCH = 50;

/** `SELECT <outbox row> FROM <source>` for a CTE: one outbox row per row the audited statement returned. */
export const outboxSelect = (entry: AuditEntry, now: Date, source: SQL): SQL =>
  sql`INSERT INTO claims_audit_outbox (id, entry, created_at) SELECT ${randomUUID()}::uuid, ${JSON.stringify(entry)}::jsonb, ${ts(now)} FROM ${source}`;

/** The outbox INSERT as a second statement of an open transaction (pass the transaction handle). */
export async function outboxInsert(tx: Executor, entry: AuditEntry, now: Date): Promise<void> {
  await tx.execute(sql`INSERT INTO claims_audit_outbox (id, entry, created_at) VALUES (${randomUUID()}::uuid, ${JSON.stringify(entry)}::jsonb, ${ts(now)})`);
}

interface FlushState {
  running: Promise<void> | null;
  queued: Promise<void> | null;
}

/** Single flight per database handle in this process (the module's flushes share one promise chain). */
const flushes = new WeakMap<object, FlushState>();

/**
 * Records the oldest pending outbox rows (at most AUDIT_FLUSH_BATCH): for each row, stop when `signal` is aborted, record
 * it, then delete it. When record throws, the row stays and the flush stops (the next flush retries it). A call while a
 * flush runs waits for it and then flushes again (callers arriving meanwhile share that second flush), so in-process
 * triggers never record a row twice. Never throws: the audited write has committed and its row waits in the outbox.
 */
export function flushAudit(ctx: AppContext, signal?: AbortSignal): Promise<void> {
  let state = flushes.get(ctx.db);
  if (!state) {
    state = { running: null, queued: null };
    flushes.set(ctx.db, state);
  }
  const current = state;
  const start = (): Promise<void> => {
    const run = flushOnce(ctx, signal).finally(() => {
      if (current.running === run) current.running = null;
    });
    current.running = run;
    return run;
  };
  if (current.queued) return current.queued;
  if (current.running) {
    const queued = current.running.then(() => {
      current.queued = null;
      return start();
    });
    current.queued = queued;
    return queued;
  }
  return start();
}

async function flushOnce(ctx: AppContext, signal?: AbortSignal): Promise<void> {
  try {
    const pending = await rows<{ id: string; entry: unknown }>(
      ctx.db,
      sql`SELECT id::text AS id, entry FROM claims_audit_outbox ORDER BY created_at, id LIMIT ${AUDIT_FLUSH_BATCH}`,
    );
    for (const row of pending) {
      if (signal?.aborted) return;
      const entry = (typeof row.entry === "string" ? JSON.parse(row.entry) : row.entry) as AuditEntry;
      try {
        await ctx.audit.record(entry);
      } catch {
        ctx.metrics.increment("claims_audit_flush", { outcome: "record_failed" });
        return;
      }
      await ctx.db.execute(sql`DELETE FROM claims_audit_outbox WHERE id = ${row.id}::uuid`);
    }
  } catch {
    // The outbox could not be read or a recorded row not deleted: the rows stay and the next flush retries them.
    ctx.metrics.increment("claims_audit_flush", { outcome: "error" });
  }
}
