// Job `funding.reconcile` (PRD-04 section 1): moves plans planned/submitted -> confirmed | failed | expired with
// compare-and-set updates only. A step is confirmed when one of its reported hashes has a successful receipt at or
// below the finalized block and the transaction's to/from/input/value equal the stored step and plan account
// (sessions are EOA-only; speed-ups and replacements keep the calldata). Unconfirmed plans become `expired` (no step
// confirmed) or `failed` (partial execution) once expires_at + 1 h has passed, decided only while the read model is
// fresh and finalizedBlock() succeeded in this run (PRD-04 4b): otherwise a missing receipt may just be unseen yet.
// Every plan transition that wins its compare-and-set writes exactly one audit entry (SEC-OPS-07); a lost race none.

import { z } from "zod";
import { planFromWire, type TxPlan, type TxStep } from "@pine/shared/tx-plan";
import type { AppContext, JobDefinition } from "../../contracts/app.js";
import { readModelFreshness } from "./common.js";
import { fromMs, msOf, rows, sql, ts } from "./db.js";
import { EXPIRY_GRACE_SECONDS } from "./store.js";

export const RECONCILE_JOB_NAME = "funding.reconcile";
export const RECONCILE_INTERVAL_MS = 30_000;
export const RECONCILE_BATCH = 50;
/** Fixed vocabulary stored as a step's failure reason (never upstream text). */
export const REVERTED_REASON = "a reported transaction reverted; send the step again";

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const quantity = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const receiptSchema = z.object({ status: z.enum(["0x0", "0x1"]), blockNumber: quantity }).loose();
const transactionSchema = z.object({ to: z.string().regex(/^0x[0-9a-fA-F]{40}$/).nullable(), from: z.string().regex(/^0x[0-9a-fA-F]{40}$/), input: hex, value: quantity }).loose();

interface OpenPlanRow {
  id: string;
  kind: string;
  wire: unknown;
  expires_ms: unknown;
}

interface StepRow {
  step_id: string;
  state: "pending" | "confirmed";
  tx_hashes: string[] | null;
  revert_reason: string | null;
}

/** What this run established once for every plan: the finalized block (null when the call failed) and freshness. */
export interface RunContext {
  finalized: bigint | null;
  fresh: boolean;
}

type Verdict = "confirmed" | "reverted" | "unknown";

/** Checks one reported hash against a step: finalized successful receipt and an exactly matching transaction. */
export async function checkTransaction(ctx: AppContext, plan: TxPlan, step: TxStep, hash: string, finalized: bigint): Promise<Verdict> {
  const receiptRaw = await ctx.chain.publicClient.request({ method: "eth_getTransactionReceipt", params: [hash as `0x${string}`] });
  if (receiptRaw === null || receiptRaw === undefined) return "unknown";
  const receipt = receiptSchema.safeParse(receiptRaw);
  if (!receipt.success) return "unknown";
  if (BigInt(receipt.data.blockNumber) > finalized) return "unknown";
  const txRaw = await ctx.chain.publicClient.request({ method: "eth_getTransactionByHash", params: [hash as `0x${string}`] });
  const tx = transactionSchema.safeParse(txRaw);
  if (!tx.success || tx.data.to === null) return "unknown";
  const matches =
    tx.data.to.toLowerCase() === step.to.toLowerCase() &&
    tx.data.from.toLowerCase() === plan.account.toLowerCase() &&
    tx.data.input.toLowerCase() === step.data.toLowerCase() &&
    BigInt(tx.data.value) === step.value;
  if (!matches) return "unknown";
  return receipt.data.status === "0x1" ? "confirmed" : "reverted";
}

async function reconcilePlan(ctx: AppContext, row: OpenPlanRow, now: Date, run: RunContext): Promise<void> {
  // Bump reconciled_at first, on every attempt: a plan whose checks throw (RPC errors, bad data) moves to the back of
  // the queue like any other, so failing plans cannot starve the batch (PRD-04 4a). Nothing returned: no longer open.
  const attempted = await rows<{ state: string }>(
    ctx.db,
    sql`UPDATE funding_plans SET reconciled_at = ${ts(now)} WHERE id = ${row.id}::uuid AND state IN ('planned', 'submitted') RETURNING state`,
  );
  const from = attempted[0]?.state;
  if (from === undefined) return;
  const plan = planFromWire(row.wire);
  const steps = await rows<StepRow>(ctx.db, sql`SELECT step_id, state, tx_hashes, revert_reason FROM funding_plan_steps WHERE plan_id = ${row.id}::uuid ORDER BY position`);
  const confirmed = new Set(steps.filter((step) => step.state === "confirmed").map((step) => step.step_id));
  const reverted = new Map(steps.filter((step) => step.revert_reason !== null).map((step) => [step.step_id, step.revert_reason]));
  for (const stored of steps) {
    // Without a finalized block nothing can be confirmed (or recorded as reverted) in this run.
    if (stored.state === "confirmed" || run.finalized === null) continue;
    const step = plan.steps.find((item) => item.id === stored.step_id);
    if (!step) continue;
    for (const hash of stored.tx_hashes ?? []) {
      const verdict = await checkTransaction(ctx, plan, step, hash, run.finalized);
      if (verdict === "confirmed") {
        const done = await rows(
          ctx.db,
          sql`UPDATE funding_plan_steps SET state = 'confirmed', confirmed_tx_hash = ${hash}, revert_reason = NULL
              WHERE plan_id = ${row.id}::uuid AND step_id = ${stored.step_id} AND state = 'pending' RETURNING step_id`,
        );
        if (done.length > 0) {
          confirmed.add(stored.step_id);
          reverted.delete(stored.step_id);
        }
        break;
      }
      if (verdict === "reverted") {
        const marked = await rows(
          ctx.db,
          sql`UPDATE funding_plan_steps SET revert_reason = ${REVERTED_REASON} WHERE plan_id = ${row.id}::uuid AND step_id = ${stored.step_id} AND state = 'pending' RETURNING step_id`,
        );
        if (marked.length > 0) reverted.set(stored.step_id, REVERTED_REASON);
      }
    }
  }
  const audit = (action: string, details: Record<string, unknown>) =>
    ctx.audit.record({ actorUserId: null, action, subjectType: "funding_plan", subjectId: row.id, details, ip: null });
  if (steps.length > 0 && steps.every((step) => confirmed.has(step.step_id))) {
    const moved = await rows(
      ctx.db,
      sql`UPDATE funding_plans SET state = 'confirmed', updated_at = ${ts(now)}, reconciled_at = ${ts(now)} WHERE id = ${row.id}::uuid AND state IN ('planned', 'submitted') RETURNING id`,
    );
    if (moved.length > 0) await audit("funding.plan.confirmed", { from, kind: row.kind, steps: steps.length });
    return;
  }
  if (!run.fresh || run.finalized === null) return;
  const expiresAt = fromMs(row.expires_ms);
  if (now.getTime() >= expiresAt.getTime() + EXPIRY_GRACE_SECONDS * 1000) {
    const next = confirmed.size > 0 ? "failed" : "expired";
    const moved = await rows(
      ctx.db,
      sql`UPDATE funding_plans SET state = ${next}, updated_at = ${ts(now)}, reconciled_at = ${ts(now)} WHERE id = ${row.id}::uuid AND state IN ('planned', 'submitted') RETURNING id`,
    );
    if (moved.length > 0) {
      // Revert reasons are the fixed REVERTED_REASON vocabulary (never upstream text); the audit log redacts strings too.
      const revertReasons = [...reverted.entries()].map(([stepId, reason]) => ({ stepId, reason }));
      await audit(`funding.plan.${next}`, { from, kind: row.kind, confirmedSteps: confirmed.size, steps: steps.length, revertReasons });
    }
  }
}

/**
 * One run: at most RECONCILE_BATCH open plans, least recently reconciled first (every attempt bumps reconciled_at, errors
 * included); one plan's failure never stops the run. Freshness and the finalized block are read once per run.
 */
export async function reconcileOnce(ctx: AppContext, signal?: AbortSignal): Promise<void> {
  const now = ctx.clock.now();
  const open = await rows<OpenPlanRow>(
    ctx.db,
    sql`SELECT id::text AS id, kind, wire, ${msOf(sql`expires_at`)} AS expires_ms FROM funding_plans
        WHERE state IN ('planned', 'submitted') ORDER BY reconciled_at NULLS FIRST, id LIMIT ${RECONCILE_BATCH}`,
  );
  if (open.length === 0) return;
  const fresh = await readModelFreshness(ctx).catch(() => false);
  let finalized: bigint | null = null;
  try {
    finalized = await ctx.chain.finalizedBlock();
  } catch {
    ctx.metrics.increment("funding_reconcile_errors");
  }
  for (const row of open) {
    if (signal?.aborted) return;
    try {
      await reconcilePlan(ctx, row, now, { finalized, fresh });
    } catch {
      ctx.metrics.increment("funding_reconcile_errors");
    }
  }
}

export const reconcileJob: JobDefinition = {
  name: RECONCILE_JOB_NAME,
  intervalMs: RECONCILE_INTERVAL_MS,
  run: (ctx, signal) => reconcileOnce(ctx, signal),
};
