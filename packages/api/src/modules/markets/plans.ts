// Plan store of the markets lane (PRD-04 section 1, SEC-TX-08): every plan-creating POST carries an Idempotency-Key
// scoped to (user, route) with a hash of the canonical request body; the plan row and its steps are written by ONE
// statement (INSERT ... ON CONFLICT DO NOTHING); states move by compare-and-set only.

import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { planToWire, type TxPlan, type WireTxPlan } from "@pine/shared/tx-plan";
import type { Address, Hex32 } from "@pine/shared/types";
import type { AppContext, ComplianceAction, SessionInfo } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { assertReadModelReady, auditIp, canonicalHash, DAY, isoSeconds, nowSeconds, sessionOf, type MarketsRouteDeps } from "./common.js";
import { fromJson, fromMs, jsonb, msOf, one, rows, sql, toNumber, ts, type Executor } from "./db.js";

export const PLAN_STATES = ["planned", "submitted", "confirmed", "failed", "expired"] as const;
export type PlanState = (typeof PLAN_STATES)[number];
export const OPEN_PLAN_STATES: readonly PlanState[] = ["planned", "submitted"];

export const PLAN_KINDS = [
  "evidence_commit",
  "evidence_publish",
  "oracle_submit_answer",
  "oracle_fund_bounty",
  "oracle_resolve",
  "oracle_reopen",
  "oracle_handle_notified",
  "oracle_handle_rejected",
  "oracle_report_answer",
  "oracle_claim_winnings",
  "oracle_withdraw",
] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

/** Kinds whose steps may be confirmed from read-model facts instead of the transaction rule (PRD-04 section 1). */
export const READ_MODEL_CONFIRMABLE: readonly PlanKind[] = ["evidence_commit", "evidence_publish", "oracle_submit_answer"];

/** A plan is offered for at most this long after creation (each kind may end earlier). */
export const PLAN_MAX_TTL_SECONDS = DAY;
/** Grace period after expires_at before an unconfirmed plan becomes expired/failed. */
export const EXPIRY_GRACE_SECONDS = 3_600;
export const MAX_TX_HINTS_PER_STEP = 20;

export const IDEMPOTENCY_HEADER = "idempotency-key";
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** The Idempotency-Key header (1..64 of [A-Za-z0-9_-]); anything else is 400 VALIDATION_FAILED (SEC-TX-08). */
export function idempotencyKeyOf(request: FastifyRequest): string {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("VALIDATION_FAILED", "The Idempotency-Key header is required (1-64 characters of A-Z, a-z, 0-9, _ and -)", {
      issues: [{ path: ["headers", IDEMPOTENCY_HEADER], message: "required: 1-64 characters of [A-Za-z0-9_-]" }],
    });
  }
  return parsed.data;
}

export interface BuiltPlan {
  kind: PlanKind;
  market: Address | null;
  /** Verified with verifyPlan by the builder. */
  plan: TxPlan;
  /** Kind deadline (unix seconds); the store caps it at created + 24 h. */
  expiresAt: number;
  /** Shown with the plan (public values only: never a salt). */
  details: Record<string, unknown>;
  /** Read-model facts for confirmation (public values only). */
  facts: Record<string, unknown>;
}

export interface PlanRow {
  id: string;
  userId: string;
  route: string;
  bodyHash: string;
  kind: PlanKind;
  market: Address | null;
  account: Address;
  wire: WireTxPlan;
  details: Record<string, unknown>;
  facts: Record<string, unknown>;
  state: PlanState;
  expiresAt: number;
  createdAt: Date;
  updatedAt: Date;
}

interface RawPlan {
  id: string;
  user_id: string;
  route: string;
  body_hash: string;
  kind: string;
  market: string | null;
  account: string;
  wire: unknown;
  details: unknown;
  facts: unknown;
  state: string;
  expires_at: unknown;
  created_ms: unknown;
  updated_ms: unknown;
}

export const planColumns = sql`id::text AS id, user_id::text AS user_id, route, body_hash, kind, market, account, wire, details, facts, state,
  expires_at::text AS expires_at, ${msOf(sql`created_at`)} AS created_ms, ${msOf(sql`updated_at`)} AS updated_ms`;

export function toPlanRow(row: RawPlan): PlanRow {
  if (!(PLAN_STATES as readonly string[]).includes(row.state)) throw new Error("unknown plan state");
  if (!(PLAN_KINDS as readonly string[]).includes(row.kind)) throw new Error("unknown plan kind");
  return {
    id: row.id,
    userId: row.user_id,
    route: row.route,
    bodyHash: row.body_hash,
    kind: row.kind as PlanKind,
    market: row.market as Address | null,
    account: row.account as Address,
    wire: fromJson<WireTxPlan>(row.wire),
    details: fromJson<Record<string, unknown>>(row.details),
    facts: fromJson<Record<string, unknown>>(row.facts),
    state: row.state as PlanState,
    expiresAt: toNumber(row.expires_at),
    createdAt: fromMs(row.created_ms),
    updatedAt: fromMs(row.updated_ms),
  };
}

async function findByKey(db: Executor, userId: string, route: string, key: string): Promise<PlanRow | null> {
  const row = await one<RawPlan>(db, sql`SELECT ${planColumns} FROM markets_plans WHERE user_id = ${userId}::uuid AND route = ${route} AND idempotency_key = ${key}`);
  return row ? toPlanRow(row) : null;
}

export async function findPlan(db: Executor, id: string, userId?: string): Promise<PlanRow | null> {
  const owner = userId === undefined ? sql`TRUE` : sql`user_id = ${userId}::uuid`;
  const row = await one<RawPlan>(db, sql`SELECT ${planColumns} FROM markets_plans WHERE id = ${id}::uuid AND ${owner}`);
  return row ? toPlanRow(row) : null;
}

export interface StepRow {
  stepId: string;
  ord: number;
  allowlistId: string;
  to: Address;
  data: `0x${string}`;
  value: bigint;
  state: "pending" | "confirmed";
  confirmedBy: string | null;
}

export async function stepsOf(db: Executor, planId: string): Promise<StepRow[]> {
  const list = await rows<{ step_id: string; ord: unknown; allowlist_id: string; to_address: string; data: string; value: string; state: string; confirmed_by: string | null }>(
    db,
    sql`SELECT step_id, ord::int AS ord, allowlist_id, to_address, data, value::text AS value, state, confirmed_by
        FROM markets_plan_steps WHERE plan_id = ${planId}::uuid ORDER BY ord`,
  );
  return list.map((row) => ({
    stepId: row.step_id,
    ord: toNumber(row.ord),
    allowlistId: row.allowlist_id,
    to: row.to_address as Address,
    data: row.data as `0x${string}`,
    value: BigInt(row.value),
    state: row.state === "confirmed" ? "confirmed" : "pending",
    confirmedBy: row.confirmed_by,
  }));
}

export interface TxHint {
  stepId: string;
  txHash: Hex32;
  status: string;
  reason: string | null;
}

export async function hintsOf(db: Executor, planId: string): Promise<TxHint[]> {
  const list = await rows<{ step_id: string; tx_hash: string; status: string; reason: string | null }>(
    db,
    sql`SELECT step_id, tx_hash, status, reason FROM markets_plan_txs WHERE plan_id = ${planId}::uuid ORDER BY reported_at, tx_hash`,
  );
  return list.map((row) => ({ stepId: row.step_id, txHash: row.tx_hash as Hex32, status: row.status, reason: row.reason }));
}

/** Compare-and-set transition; success only from RETURNING rows. Null when another writer moved the plan first. */
export async function transitionPlan(db: Executor, id: string, from: readonly PlanState[], to: PlanState, now: Date): Promise<PlanRow | null> {
  const row = await one<RawPlan>(
    db,
    sql`UPDATE markets_plans SET state = ${to}, updated_at = ${ts(now)}
        WHERE id = ${id}::uuid AND state IN (SELECT jsonb_array_elements_text(${JSON.stringify(from)}::jsonb))
        RETURNING ${planColumns}`,
  );
  return row ? toPlanRow(row) : null;
}

export async function planView(db: Executor, plan: PlanRow, now: number) {
  const [steps, hints] = await Promise.all([stepsOf(db, plan.id), hintsOf(db, plan.id)]);
  return {
    plan: plan.wire,
    planState: {
      id: plan.id,
      kind: plan.kind,
      route: plan.route,
      market: plan.market,
      account: plan.account,
      state: plan.state,
      expiresAt: plan.expiresAt,
      expiresAtIso: isoSeconds(plan.expiresAt),
      offerExpired: now >= plan.expiresAt,
      steps: steps.map((step) => ({
        id: step.stepId,
        allowlistId: step.allowlistId,
        state: step.state,
        transactions: hints.filter((hint) => hint.stepId === step.stepId).map(({ txHash, status, reason }) => ({ txHash, status, reason })),
      })),
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    },
    details: plan.details,
  };
}

export interface PlanRequest {
  /** Stable route name for idempotency scoping, e.g. "evidence.commit". */
  route: string;
  action: ComplianceAction;
  /** The validated request body (hashed canonically; bigint values as decimal strings). */
  body: unknown;
  build(planId: string, session: SessionInfo): Promise<BuiltPlan>;
}

/**
 * Fixed order (PRD-04 4b): Idempotency-Key -> compliance -> stored plan for (user, route, key) (same body: returned
 * unchanged even while the read model is stale; different body: 409) -> read model fresh (NOT_READY) -> consume
 * plans_per_day -> build and verify (eth_call reads happen only here) -> one INSERT ... ON CONFLICT DO NOTHING
 * (conflict: the winner's plan). A NOT_READY refusal burns no quota, an exhausted quota makes no RPC call, and
 * QUOTA_EXCEEDED never leaves a stored plan; a build refused after the quota was consumed keeps that unit spent.
 */
export async function createOrReplayPlan(ctx: AppContext, request: FastifyRequest, input: PlanRequest): Promise<{ statusCode: 200 | 201; body: Awaited<ReturnType<typeof planView>> }> {
  const session = sessionOf(request);
  const key = idempotencyKeyOf(request);
  await ctx.compliance.assertAllowed(request, session, input.action);
  const bodyHash = canonicalHash(input.body);
  const replay = async (row: PlanRow) => {
    if (row.bodyHash !== bodyHash) throw new ApiError("CONFLICT", "This Idempotency-Key was used with a different request body; use a new key");
    return { statusCode: 200 as const, body: await planView(ctx.db, row, nowSeconds(ctx)) };
  };
  const existing = await findByKey(ctx.db, session.userId, input.route, key);
  if (existing) return replay(existing);

  await assertReadModelReady(ctx);
  await ctx.quotas.consume(session.userId, "plans_per_day");
  const planId = randomUUID();
  const built = await input.build(planId, session);
  if (built.plan.planId !== planId || built.plan.account !== session.wallet.toLowerCase()) throw new Error("plan builder returned a plan for another id or account");

  const now = ctx.clock.now();
  const expiresAt = Math.min(built.expiresAt, nowSeconds(ctx) + PLAN_MAX_TTL_SECONDS);
  const wire = planToWire(built.plan);
  const steps = wire.steps.map((step, ord) => ({ step_id: step.id, ord, allowlist_id: step.allowlistId, to_address: step.to, data: step.data.toLowerCase(), value: step.value }));
  const inserted = await one<{ id: string | null; steps: unknown }>(
    ctx.db,
    sql`WITH p AS (
          INSERT INTO markets_plans (id, user_id, route, idempotency_key, body_hash, kind, market, account, wire, details, facts, state, expires_at, created_at, updated_at)
          VALUES (${planId}::uuid, ${session.userId}::uuid, ${input.route}, ${key}, ${bodyHash}, ${built.kind}, ${built.market}, ${built.plan.account},
                  ${jsonb(wire)}, ${jsonb(built.details)}, ${jsonb(built.facts)}, 'planned', ${String(expiresAt)}::bigint, ${ts(now)}, ${ts(now)})
          ON CONFLICT (user_id, route, idempotency_key) DO NOTHING
          RETURNING id
        ), s AS (
          INSERT INTO markets_plan_steps (plan_id, step_id, ord, allowlist_id, to_address, data, value, state)
          SELECT p.id, x.step_id, x.ord, x.allowlist_id, x.to_address, x.data, x.value::numeric, 'pending'
          FROM p CROSS JOIN jsonb_to_recordset(${jsonb(steps)}) AS x(step_id text, ord int, allowlist_id text, to_address text, data text, value text)
          RETURNING plan_id
        )
        SELECT (SELECT id::text FROM p) AS id, (SELECT count(*)::int FROM s) AS steps`,
  );
  if (inserted?.id) {
    await ctx.audit.record({
      actorUserId: session.userId,
      action: "markets.plan.created",
      subjectType: "markets_plan",
      subjectId: planId,
      details: { route: input.route, kind: built.kind, market: built.market, steps: steps.length },
      ip: auditIp(request),
    });
    const row = await findPlan(ctx.db, planId, session.userId);
    if (!row) throw new Error("stored plan disappeared");
    return { statusCode: 201, body: await planView(ctx.db, row, nowSeconds(ctx)) };
  }
  // A concurrent request with the same key won the insert: its plan is the answer (or 409 for another body).
  const winner = await findByKey(ctx.db, session.userId, input.route, key);
  if (!winner) throw new ApiError("CONFLICT", "The plan could not be stored; try again");
  return replay(winner);
}

const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed transaction hash").transform((value) => value.toLowerCase() as Hex32);

export function registerPlanRoutes({ app, ctx }: MarketsRouteDeps): void {
  const guard = { preHandler: app.requireSession };
  const params = z.object({ planId: z.uuid() }).strict();

  app.get("/api/v1/markets/plans/:planId", { ...guard, schema: { params } }, async (request) => {
    const session = sessionOf(request);
    const plan = await findPlan(ctx.db, request.params.planId, session.userId);
    if (!plan) throw new ApiError("NOT_FOUND", "Plan not found");
    return planView(ctx.db, plan, nowSeconds(ctx));
  });

  app.post(
    "/api/v1/markets/plans/:planId/submitted",
    { ...guard, schema: { params, body: z.object({ stepId: z.string().min(1).max(64), txHash: txHashSchema }).strict() } },
    async (request) => {
      const session = sessionOf(request);
      let plan = await findPlan(ctx.db, request.params.planId, session.userId);
      if (!plan) throw new ApiError("NOT_FOUND", "Plan not found");
      const { stepId, txHash } = request.body;
      if (!plan.wire.steps.some((step) => step.id === stepId)) throw new ApiError("NOT_FOUND", "Step not found in this plan");
      if ((OPEN_PLAN_STATES as readonly string[]).includes(plan.state)) {
        const now = ctx.clock.now();
        // One statement: the per-step cap and the duplicate check cannot race.
        const added = await one<{ tx_hash: string }>(
          ctx.db,
          sql`INSERT INTO markets_plan_txs (plan_id, step_id, tx_hash, status, reported_at)
              SELECT ${plan.id}::uuid, ${stepId}, ${txHash}, 'unknown', ${ts(now)}
              WHERE (SELECT count(*)::int FROM markets_plan_txs WHERE plan_id = ${plan.id}::uuid AND step_id = ${stepId}) < ${MAX_TX_HINTS_PER_STEP}
              ON CONFLICT (plan_id, step_id, tx_hash) DO NOTHING
              RETURNING tx_hash`,
        );
        if (!added) {
          const known = await one<{ tx_hash: string }>(ctx.db, sql`SELECT tx_hash FROM markets_plan_txs WHERE plan_id = ${plan.id}::uuid AND step_id = ${stepId} AND tx_hash = ${txHash}`);
          if (!known) throw new ApiError("UNPROCESSABLE", `At most ${MAX_TX_HINTS_PER_STEP} transaction hashes can be reported per step`);
        } else {
          await ctx.audit.record({ actorUserId: session.userId, action: "markets.plan.tx_reported", subjectType: "markets_plan", subjectId: plan.id, details: { stepId, txHash }, ip: auditIp(request) });
        }
        const moved = await transitionPlan(ctx.db, plan.id, ["planned"], "submitted", now);
        if (moved) plan = moved;
        else plan = (await findPlan(ctx.db, plan.id, session.userId)) ?? plan;
      }
      return planView(ctx.db, plan, nowSeconds(ctx));
    },
  );
}
