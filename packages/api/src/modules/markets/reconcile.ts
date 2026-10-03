// Job markets.reconcile (PRD-04 section 1, SEC-TX-08): moves open plans forward with compare-and-set transitions only.
// A step is confirmed when one of its reported hashes has a successful receipt at or below the finalized block and the
// transaction itself (to, from, input, value) equals the stored step; evidence commit/publish and submitAnswer steps may
// instead be confirmed from read-model facts. Unconfirmed plans become expired (nothing confirmed) or failed (partial)
// one hour after their expiry, decided only while the read model is fresh AND finalizedBlock() succeeded in this run
// (otherwise a missing receipt may just be unseen yet). Every transition queues its audit entry in the outbox by the
// same statement; the outbox is flushed after each transition and at the start of every run. The run checks its abort
// signal between plans: an aborted run starts no further plan.

import { TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem";
import type { Address, Hex32 } from "@pine/shared/types";
import type { AppContext, AuditEntry, JobDefinition } from "../../contracts/app.js";
import { flushAudit } from "./audit.js";
import { freshness, nowSeconds, type MarketsState } from "./common.js";
import { one, rows, sql, ts } from "./db.js";
import { EXPIRY_GRACE_SECONDS, planColumns, READ_MODEL_CONFIRMABLE, stepsOf, toPlanRow, transitionPlan, type PlanRow, type StepRow } from "./plans.js";

const BATCH = 100;
const EVIDENCE_PAGES = 10;

type Outcome = "confirmed" | "expired" | "failed" | "unchanged";

async function confirmedByFacts(ctx: AppContext, plan: PlanRow): Promise<string | null> {
  const facts = plan.facts;
  if (plan.kind === "evidence_commit" || plan.kind === "evidence_publish") {
    if (!plan.market) return null;
    let cursor: string | undefined;
    for (let page = 0; page < EVIDENCE_PAGES; page += 1) {
      const result = await ctx.readModel.listEvidence({
        market: plan.market,
        submitter: plan.account,
        ...(plan.kind === "evidence_publish" ? { status: "published" as const } : {}),
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const match = result.items.find((record) =>
        plan.kind === "evidence_commit" ? record.commitment !== null && record.commitment === String(facts.commitment).toLowerCase() : record.contentSha256 === String(facts.contentSha256).toLowerCase(),
      );
      if (match) return `read-model:evidence:${match.registry}:${match.submissionId.toString()}`;
      if (!result.nextCursor) return null;
      cursor = result.nextCursor;
    }
    return null;
  }
  if (plan.kind === "oracle_submit_answer") {
    const answers = await ctx.readModel.listOracleAnswers(String(facts.questionId) as Hex32);
    const match = answers.find(
      (answer) => !answer.isCommitment && answer.answerer === plan.account && answer.answer === String(facts.answer).toLowerCase() && answer.bond.toString() === String(facts.bond),
    );
    return match ? `read-model:answer:${match.txHash}` : null;
  }
  return null;
}

async function confirmedByTransaction(ctx: AppContext, plan: PlanRow, step: StepRow, finalized: bigint): Promise<string | null> {
  const hints = await rows<{ tx_hash: string }>(
    ctx.db,
    sql`SELECT tx_hash FROM markets_plan_txs WHERE plan_id = ${plan.id}::uuid AND step_id = ${step.stepId} AND status IN ('unknown', 'succeeded') ORDER BY reported_at, tx_hash`,
  );
  const mark = (hash: string, status: string, reason: string | null) =>
    ctx.db.execute(
      sql`UPDATE markets_plan_txs SET status = ${status}, reason = ${reason}, checked_at = ${ts(ctx.clock.now())}
          WHERE plan_id = ${plan.id}::uuid AND step_id = ${step.stepId} AND tx_hash = ${hash} AND status IN ('unknown', 'succeeded')`,
    );
  for (const { tx_hash: hash } of hints) {
    let receipt;
    try {
      receipt = await ctx.chain.publicClient.getTransactionReceipt({ hash: hash as Hex32 });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) continue;
      throw error;
    }
    // Neither outcome is recorded before finality: a reorg can drop or re-include an unfinalized transaction.
    if (receipt.blockNumber > finalized) continue;
    if (receipt.status !== "success") {
      await mark(hash, "reverted", "transaction reverted");
      continue;
    }
    let transaction;
    try {
      transaction = await ctx.chain.publicClient.getTransaction({ hash: hash as Hex32 });
    } catch (error) {
      if (error instanceof TransactionNotFoundError) continue;
      throw error;
    }
    const matches =
      String(transaction.to ?? "").toLowerCase() === step.to &&
      String(transaction.from).toLowerCase() === (plan.account as Address) &&
      String(transaction.input).toLowerCase() === step.data.toLowerCase() &&
      transaction.value === step.value;
    if (!matches) {
      await mark(hash, "mismatch", "transaction does not match the plan step");
      continue;
    }
    await mark(hash, "succeeded", null);
    return `tx:${hash}`;
  }
  return null;
}

async function reconcileOne(ctx: AppContext, plan: PlanRow, context: { finalized: bigint | null; fresh: boolean }, signal: AbortSignal | undefined): Promise<Outcome> {
  const now = ctx.clock.now();
  for (const step of await stepsOf(ctx.db, plan.id)) {
    if (step.state === "confirmed") continue;
    let by: string | null = null;
    if (READ_MODEL_CONFIRMABLE.includes(plan.kind) && context.fresh) by = await confirmedByFacts(ctx, plan);
    if (by === null && context.finalized !== null) by = await confirmedByTransaction(ctx, plan, step, context.finalized);
    if (by !== null) {
      await one(
        ctx.db,
        sql`UPDATE markets_plan_steps SET state = 'confirmed', confirmed_by = ${by}, confirmed_at = ${ts(now)}
            WHERE plan_id = ${plan.id}::uuid AND step_id = ${step.stepId} AND state = 'pending' RETURNING step_id`,
      );
    }
  }
  const steps = await stepsOf(ctx.db, plan.id);
  const confirmedCount = steps.filter((step) => step.state === "confirmed").length;
  const audit = (action: string, details: Record<string, unknown>): AuditEntry => ({ actorUserId: null, action, subjectType: "markets_plan", subjectId: plan.id, details, ip: null });
  if (steps.length > 0 && confirmedCount === steps.length) {
    const moved = await transitionPlan(ctx.db, plan.id, ["planned", "submitted"], "confirmed", now, audit("markets.plan.confirmed", { from: plan.state, kind: plan.kind }));
    if (moved) await flushAudit(ctx, signal);
    return moved ? "confirmed" : "unchanged";
  }
  // Without a finalized block in this run, a missing receipt proves nothing: no expiry decision (PRD-07 section 3).
  if (context.fresh && context.finalized !== null && nowSeconds(ctx) > plan.expiresAt + EXPIRY_GRACE_SECONDS) {
    const to = confirmedCount > 0 ? "failed" : "expired";
    const moved = await transitionPlan(ctx.db, plan.id, ["planned", "submitted"], to, now, audit(`markets.plan.${to}`, { from: plan.state, kind: plan.kind, confirmedSteps: confirmedCount, steps: steps.length }));
    if (moved) await flushAudit(ctx, signal);
    return moved ? to : "unchanged";
  }
  return "unchanged";
}

export async function reconcilePlans(ctx: AppContext, _state: MarketsState, signal?: AbortSignal): Promise<Record<Outcome | "errors", number>> {
  const counts: Record<Outcome | "errors", number> = { confirmed: 0, expired: 0, failed: 0, unchanged: 0, errors: 0 };
  // Entries left by an audit outage are recorded first, whether or not any plan is open.
  await flushAudit(ctx, signal);
  const fresh = !(await freshness(ctx)).stale;
  let finalized: bigint | null;
  try {
    finalized = await ctx.chain.finalizedBlock();
  } catch {
    finalized = null;
  }
  const open = await rows<Parameters<typeof toPlanRow>[0]>(
    ctx.db,
    sql`SELECT ${planColumns} FROM markets_plans WHERE state IN ('planned', 'submitted') ORDER BY reconciled_at NULLS FIRST, id LIMIT ${BATCH}`,
  );
  for (const raw of open) {
    if (signal?.aborted) break;
    const plan = toPlanRow(raw);
    try {
      counts[await reconcileOne(ctx, plan, { finalized, fresh }, signal)] += 1;
    } catch {
      // Transient (RPC, read model): the plan stays as it is and the next run retries it.
      counts.errors += 1;
    }
    await ctx.db.execute(sql`UPDATE markets_plans SET reconciled_at = ${ts(ctx.clock.now())} WHERE id = ${plan.id}::uuid`);
  }
  for (const [outcome, count] of Object.entries(counts)) if (count > 0) ctx.metrics.increment("markets_reconcile", { outcome });
  return counts;
}

export function reconcileJob(stateFor: (ctx: AppContext) => MarketsState): JobDefinition {
  return {
    name: "markets.reconcile",
    intervalMs: 30_000,
    async run(ctx, signal) {
      await reconcilePlans(ctx, stateFor(ctx), signal);
    },
  };
}
