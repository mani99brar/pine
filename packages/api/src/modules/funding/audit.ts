// Audit outbox of the funding module (PRD-07 section 3, SEC-OPS-07). Every audited write (plan created, a NEW tx-hash
// hint, the reconcile transitions confirmed/failed/expired) inserts its AuditEntry into funding_audit_outbox in the
// SAME SQL statement as the write, so no write can commit without its pending entry.
// flushAudit hands the pending entries to the frozen AuditLog.record (record-only) and deletes each one after it was
// recorded; request handlers start it without awaiting it, jobs await it. The guarantee is at-least-once: a crash between record and DELETE, or a flusher in another process, can
// duplicate an entry (identified by its natural key: action and subjectId, plus stepId and txHash for tx_reported),
// never lose one.

import type { FastifyBaseLogger } from "fastify";
import type { AppContext, AuditEntry } from "../../contracts/app.js";
import { safeErrorMessage } from "../../contracts/redact.js";
import { rows, sql, ts, type SQL } from "./db.js";

/** Pending entries read per flush. */
export const AUDIT_FLUSH_BATCH = 50;

const jsonb = (value: AuditEntry): SQL => sql`${JSON.stringify(value)}::jsonb`;
/** A jsonb column value as returned by either driver (object, or text for some drivers). */
const fromJson = (value: unknown): AuditEntry => (typeof value === "string" ? JSON.parse(value) : value) as AuditEntry;

/** The outbox INSERT of an audited write's CTE: one pending entry per row of `source` (the write's RETURNING CTE). */
export function queueAuditFrom(source: SQL, entry: AuditEntry, now: Date): SQL {
  return sql`INSERT INTO funding_audit_outbox (id, entry, created_at) SELECT gen_random_uuid(), ${jsonb(entry)}, ${ts(now)} FROM ${source}`;
}

/** One flush: never throws (the outbox keeps whatever was not recorded for the next flush). */
async function drain(ctx: AppContext, signal: AbortSignal | undefined): Promise<void> {
  let pending: { id: string; entry: unknown }[];
  try {
    pending = await rows<{ id: string; entry: unknown }>(ctx.db, sql`SELECT id::text AS id, entry FROM funding_audit_outbox ORDER BY created_at, id LIMIT ${AUDIT_FLUSH_BATCH}`);
  } catch {
    ctx.metrics.increment("funding_audit_outbox", { outcome: "read_failed" });
    return;
  }
  for (const row of pending) {
    if (signal?.aborted) return;
    try {
      await ctx.audit.record(fromJson(row.entry));
    } catch {
      // The row stays and the flush stops: the next flush (later write, replay or reconcile run) records it.
      ctx.metrics.increment("funding_audit_outbox", { outcome: "record_failed" });
      return;
    }
    try {
      await ctx.db.execute(sql`DELETE FROM funding_audit_outbox WHERE id = ${row.id}::uuid`);
    } catch {
      // Recorded but not deleted: the next flush records it again (a duplicate, never a loss).
      ctx.metrics.increment("funding_audit_outbox", { outcome: "delete_failed" });
      return;
    }
  }
}

interface Flight {
  promise: Promise<void>;
  /** Set by a call that arrived while this flight was draining: the flight drains once more before it settles. */
  rerun: boolean;
  /** The signal of the latest caller; each drain pass reads it when it starts. */
  signal: AbortSignal | undefined;
}

/** One in-flight flush per database handle: in-process flushes never overlap, so they never double-record. */
const flights = new WeakMap<object, Flight>();

/**
 * Records and deletes pending outbox entries. Single-flight per database handle inside this process: a call while a
 * flush runs requests one more drain and gets the running flight's promise, which settles after that drain. The entry
 * is cleared in `finally`, so a rejected drain never wedges later flushes. An audit outage never rejects (the entries
 * stay in the outbox); a rejection is an unexpected failure the caller logs.
 */
export function flushAudit(ctx: AppContext, signal?: AbortSignal): Promise<void> {
  const key: object = ctx.db;
  const running = flights.get(key);
  if (running) {
    running.rerun = true;
    running.signal = signal;
    return running.promise;
  }
  const flight: Flight = { promise: Promise.resolve(), rerun: false, signal };
  flight.promise = (async () => {
    try {
      do {
        flight.rerun = false;
        await drain(ctx, flight.signal);
      } while (flight.rerun);
    } finally {
      if (flights.get(key) === flight) flights.delete(key);
    }
  })();
  flights.set(key, flight);
  return flight.promise;
}

/**
 * Request path (PRD-07 3c): the outbox row is already committed with the write, so the flush is started without being
 * awaited; an audit backlog or a slow audit store never delays or fails the response. Failures are logged redacted.
 */
export function flushAuditInBackground(ctx: AppContext, log: FastifyBaseLogger): void {
  flushAudit(ctx).catch((error: unknown) => {
    log.error({ error: safeErrorMessage(error, ctx.redact) }, "funding audit flush failed");
  });
}

/** Settles when the flush currently in flight (if any) has settled, without requesting another drain (tests, shutdown). */
export function settledAudit(ctx: AppContext): Promise<void> {
  const running = flights.get(ctx.db);
  if (!running) return Promise.resolve();
  return running.promise.then(
    () => undefined,
    () => undefined,
  );
}
