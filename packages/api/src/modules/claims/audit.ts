// Audit outbox of the claims module (PRD-07 §3b with the flush design of §3, SEC-OPS-07). An audited write and its
// outbox row commit together: writes already inside ctx.db.transaction add the outbox INSERT as a second statement in
// that transaction (outboxInsert), bare single-statement writes carry it as a CTE (outboxSelect). flushAudit records the
// pending rows through the frozen AuditLog.record and deletes each one after it was recorded, so an audit outage never
// loses an entry; request handlers start it without awaiting it (PRD-07 §3f), jobs await it. The guarantee is
// at-least-once: a crash between record and delete, or a flusher in another process, can only duplicate an entry,
// identified by its natural key ((action, subjectId), plus txHash for tx_reported).

import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { AppContext, AuditEntry } from "../../contracts/app.js";
import { safeErrorMessage } from "../../contracts/redact.js";
import { rows, sql, ts, type Executor, type SQL } from "./db.js";

export const AUDIT_FLUSH_BATCH = 50;

/** `SELECT <outbox row> FROM <source>` for a CTE: one outbox row, with its own id, per row the audited statement returned. */
export const outboxSelect = (entry: AuditEntry, now: Date, source: SQL): SQL =>
  sql`INSERT INTO claims_audit_outbox (id, entry, created_at) SELECT gen_random_uuid(), ${JSON.stringify(entry)}::jsonb, ${ts(now)} FROM ${source}`;

/** The outbox INSERT as a second statement of an open transaction (pass the transaction handle). */
export async function outboxInsert(tx: Executor, entry: AuditEntry, now: Date): Promise<void> {
  await tx.execute(sql`INSERT INTO claims_audit_outbox (id, entry, created_at) VALUES (${randomUUID()}::uuid, ${JSON.stringify(entry)}::jsonb, ${ts(now)})`);
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
 * Records the oldest pending outbox rows (at most AUDIT_FLUSH_BATCH per drain): for each row, stop when `signal` is
 * aborted, record it, then delete it. When record throws, the row stays and the drain stops (the next flush retries it).
 * Single-flight per database handle inside this process: a call while a flush runs requests one more drain and gets the
 * running flight's promise, which settles after that drain. The entry is cleared in `finally`, so a rejected drain never
 * wedges later flushes. An audit outage never rejects: the audited write has committed and its row waits in the outbox.
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
        await flushOnce(ctx, flight.signal);
      } while (flight.rerun);
    } finally {
      if (flights.get(key) === flight) flights.delete(key);
    }
  })();
  flights.set(key, flight);
  return flight.promise;
}

/**
 * Request path (PRD-07 §3f, as markets and funding since §3c): the outbox row is already committed with the write, so the
 * flush is started without being awaited; an audit backlog or a slow audit store never delays or fails the response.
 * Failures are logged redacted.
 */
export function flushAuditInBackground(ctx: AppContext, log: FastifyBaseLogger): void {
  flushAudit(ctx).catch((error: unknown) => {
    log.error({ error: safeErrorMessage(error, ctx.redact) }, "claims audit flush failed");
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
