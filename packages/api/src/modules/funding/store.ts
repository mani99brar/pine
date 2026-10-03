// The funding plan store (PRD-04 section 1, SEC-TX-08): plans keyed by (user, route, Idempotency-Key) with a body
// hash, inserted with their steps in ONE statement (INSERT ... ON CONFLICT DO NOTHING RETURNING inside a data-modifying
// CTE), and a compare-and-set state machine planned -> submitted -> confirmed | failed | expired.

import { createHash, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { canonicalJson, type JsonValue } from "@pine/shared/canonical";
import type { DeploymentManifest } from "@pine/shared/deployment";
import { newPlan, planToWire, PlanVerificationError, verifyPlan, type PlanContext, type TxStep, type WireTxPlan } from "@pine/shared/tx-plan";
import type { Address } from "@pine/shared/types";
import type { AppContext, ComplianceAction, SessionInfo } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { assertReadModelReady, FUNDING_PLAN_LIMITS, HOUR, MINUTE, sessionOf } from "./common.js";
import { fromMs, msOf, one, rows, sql, ts, type Executor } from "./db.js";

export type PlanKind = "ladder" | "withdraw" | "merge" | "redeem";
export type PlanState = "planned" | "submitted" | "confirmed" | "failed" | "expired";

/** Per-kind offer lifetime (PRD-04 section 1): ladder and withdraw 20 min (their deadlines), merge and redeem 1 h. */
export const PLAN_TTL_SECONDS: Record<PlanKind, number> = { ladder: 20 * MINUTE, withdraw: 20 * MINUTE, merge: HOUR, redeem: HOUR };
export const MAX_PLAN_TTL_SECONDS = 24 * HOUR;
/** A plan becomes expired/failed this long after expires_at without full confirmation. */
export const EXPIRY_GRACE_SECONDS = HOUR;
export const MAX_TX_HASHES_PER_STEP = 8;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,64}$/;

export function idempotencyKeyOf(request: FastifyRequest): string {
  const raw = request.headers["idempotency-key"];
  if (typeof raw !== "string" || !IDEMPOTENCY_KEY.test(raw)) {
    throw new ApiError("VALIDATION_FAILED", "Idempotency-Key header is required (1-64 characters of A-Z, a-z, 0-9, _ and -)", {
      issues: [{ path: ["headers", "idempotency-key"], message: "required: 1-64 characters of [A-Za-z0-9_-]" }],
    });
  }
  return raw;
}

/** SHA-256 (hex) of the RFC 8785 canonical JSON of the validated request body. */
export function bodyHashOf(body: JsonValue): string {
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

export interface StepView {
  id: string;
  state: "pending" | "confirmed";
  txHashes: string[];
  confirmedTxHash: string | null;
  revertReason: string | null;
}

export interface PlanView {
  planId: string;
  kind: PlanKind;
  market: Address;
  account: Address;
  state: PlanState;
  createdAt: string;
  expiresAt: string;
  plan: WireTxPlan;
  details: JsonValue;
  steps: StepView[];
  /** Set for failed (partially executed) plans: how to recover the funds left in the wallet. */
  recovery: string | null;
}

export const PARTIAL_EXECUTION_RECOVERY =
  "The plan was only partly executed. Full sets (YES + NO + INVALID) left in the wallet can be merged back to xDAI with POST /api/v1/funding/plans/merge.";

export interface StoredPlan extends Omit<PlanView, "recovery"> {
  userId: string;
  route: string;
  bodyHash: string;
  expiresAtDate: Date;
}

interface RawPlan {
  id: string;
  user_id: string;
  route: string;
  body_hash: string;
  kind: PlanKind;
  market: Address;
  account: Address;
  wire: WireTxPlan;
  details: JsonValue;
  state: PlanState;
  created_ms: unknown;
  expires_ms: unknown;
}

interface RawStep {
  plan_id: string;
  step_id: string;
  state: "pending" | "confirmed";
  tx_hashes: string[] | null;
  confirmed_tx_hash: string | null;
  revert_reason: string | null;
}

const planColumns = sql`id::text AS id, user_id::text AS user_id, route, body_hash, kind, market, account, wire, details, state,
  ${msOf(sql`created_at`)} AS created_ms, ${msOf(sql`expires_at`)} AS expires_ms`;

async function withSteps(db: Executor, plans: RawPlan[]): Promise<StoredPlan[]> {
  if (plans.length === 0) return [];
  const ids = plans.map((plan) => plan.id);
  const steps = await rows<RawStep>(
    db,
    sql`SELECT plan_id::text AS plan_id, step_id, state, tx_hashes, confirmed_tx_hash, revert_reason
        FROM funding_plan_steps WHERE plan_id = ANY(${`{${ids.join(",")}}`}::uuid[]) ORDER BY plan_id, position`,
  );
  return plans.map((plan) => {
    const created = fromMs(plan.created_ms);
    const expires = fromMs(plan.expires_ms);
    return {
      planId: plan.id,
      userId: plan.user_id,
      route: plan.route,
      bodyHash: plan.body_hash,
      kind: plan.kind,
      market: plan.market,
      account: plan.account,
      state: plan.state,
      createdAt: created.toISOString(),
      expiresAt: expires.toISOString(),
      expiresAtDate: expires,
      plan: plan.wire,
      details: plan.details,
      steps: steps
        .filter((step) => step.plan_id === plan.id)
        .map((step) => ({ id: step.step_id, state: step.state, txHashes: [...(step.tx_hashes ?? [])], confirmedTxHash: step.confirmed_tx_hash, revertReason: step.revert_reason })),
    };
  });
}

export function toView(plan: StoredPlan): PlanView {
  const { userId: _userId, route: _route, bodyHash: _bodyHash, expiresAtDate: _expires, ...view } = plan;
  return { ...view, recovery: plan.state === "failed" ? PARTIAL_EXECUTION_RECOVERY : null };
}

export async function findPlanByKey(db: Executor, userId: string, route: string, key: string): Promise<StoredPlan | null> {
  const plan = await one<RawPlan>(db, sql`SELECT ${planColumns} FROM funding_plans WHERE user_id = ${userId}::uuid AND route = ${route} AND idempotency_key = ${key}`);
  return plan ? ((await withSteps(db, [plan]))[0] ?? null) : null;
}

/** Owner-scoped lookup: another user's plan id is indistinguishable from an unknown one. */
export async function findOwnedPlan(db: Executor, userId: string, planId: string): Promise<StoredPlan | null> {
  const plan = await one<RawPlan>(db, sql`SELECT ${planColumns} FROM funding_plans WHERE id = ${planId}::uuid AND user_id = ${userId}::uuid`);
  return plan ? ((await withSteps(db, [plan]))[0] ?? null) : null;
}

export async function listOwnedPlans(db: Executor, userId: string, before: { createdMs: number; id: string } | null, limit: number): Promise<StoredPlan[]> {
  const keyset = before ? sql`AND (created_at, id) < (${ts(new Date(before.createdMs))}, ${before.id}::uuid)` : sql``;
  const plans = await rows<RawPlan>(db, sql`SELECT ${planColumns} FROM funding_plans WHERE user_id = ${userId}::uuid ${keyset} ORDER BY created_at DESC, id DESC LIMIT ${limit}`);
  return withSteps(db, plans);
}

/**
 * Inserts the plan and its steps in one atomic statement. Returns the stored plan: the new one, or on a key conflict
 * the winner's (the caller compares body hashes); `created` is true only when this statement inserted it.
 */
export async function insertPlan(
  db: Executor,
  input: { id: string; userId: string; route: string; key: string; bodyHash: string; kind: PlanKind; market: Address; account: Address; wire: WireTxPlan; details: JsonValue; now: Date; expiresAt: Date },
): Promise<{ stored: StoredPlan; created: boolean }> {
  const steps = input.wire.steps.map((step, position) => ({ step_id: step.id, position }));
  const inserted = await rows<{ id: string }>(
    db,
    sql`WITH inserted AS (
          INSERT INTO funding_plans (id, user_id, route, idempotency_key, body_hash, kind, market, account, wire, details, state, expires_at, created_at, updated_at)
          VALUES (${input.id}::uuid, ${input.userId}::uuid, ${input.route}, ${input.key}, ${input.bodyHash}, ${input.kind}, ${input.market}, ${input.account},
                  ${JSON.stringify(input.wire)}::jsonb, ${JSON.stringify(input.details)}::jsonb, 'planned', ${ts(input.expiresAt)}, ${ts(input.now)}, ${ts(input.now)})
          ON CONFLICT (user_id, route, idempotency_key) DO NOTHING
          RETURNING id
        ), steps AS (
          INSERT INTO funding_plan_steps (plan_id, step_id, position)
          SELECT inserted.id, s.step_id, s.position FROM inserted CROSS JOIN jsonb_to_recordset(${JSON.stringify(steps)}::jsonb) AS s(step_id text, position int)
          RETURNING plan_id
        )
        SELECT id::text AS id FROM inserted`,
  );
  const stored = await findPlanByKey(db, input.userId, input.route, input.key);
  if (!stored) throw new Error("funding plan insert returned nothing");
  return { stored, created: inserted.some((row) => row.id === input.id) };
}

/** Request IP as seen by the platform (trusted-proxy aware) for audit entries. */
export function auditIp(request: FastifyRequest): string | null {
  return typeof request.ip === "string" && request.ip.length > 0 ? request.ip : null;
}

export interface BuiltPlan {
  market: Address;
  steps: TxStep[];
  context: PlanContext;
  details: JsonValue;
}

/**
 * The common plan-creating flow (PRD-04 sections 1 and 4b): session, Idempotency-Key, compliance, same-key lookup
 * (same body: the stored plan; different body: 409), readiness (NOT_READY), quota, build, verifyPlan, atomic insert.
 * A replay therefore needs no fresh read model and no quota; a NOT_READY refusal burns no quota; an exhausted quota
 * makes no chain read. Only the request that actually inserted the plan writes the audit entry (SEC-OPS-07).
 */
export async function createPlan(input: {
  ctx: AppContext;
  manifest: DeploymentManifest;
  request: FastifyRequest;
  route: string;
  kind: PlanKind;
  body: JsonValue;
  action: ComplianceAction;
  build: (session: SessionInfo, planId: string, now: Date) => Promise<BuiltPlan>;
}): Promise<PlanView> {
  const { ctx, manifest, request, route, kind } = input;
  const session = sessionOf(request);
  const key = idempotencyKeyOf(request);
  await ctx.compliance.assertAllowed(request, session, input.action);
  const bodyHash = bodyHashOf(input.body);
  const existing = await findPlanByKey(ctx.db, session.userId, route, key);
  if (existing) {
    if (existing.bodyHash !== bodyHash) throw new ApiError("CONFLICT", "This Idempotency-Key was already used with a different request body");
    return toView(existing);
  }
  await assertReadModelReady(ctx);
  await ctx.quotas.consume(session.userId, "plans_per_day");
  const now = ctx.clock.now();
  const planId = randomUUID();
  const built = await input.build(session, planId, now);
  const plan = newPlan(manifest, planId, session.wallet, built.steps);
  try {
    verifyPlan(plan, manifest, built.context, FUNDING_PLAN_LIMITS);
  } catch (error) {
    if (error instanceof PlanVerificationError) throw new ApiError("UNPROCESSABLE", `The plan failed verification: ${error.message}`);
    throw error;
  }
  const ttl = Math.min(PLAN_TTL_SECONDS[kind], MAX_PLAN_TTL_SECONDS);
  const { stored, created } = await insertPlan(ctx.db, {
    id: planId,
    userId: session.userId,
    route,
    key,
    bodyHash,
    kind,
    market: built.market,
    account: plan.account,
    wire: planToWire(plan),
    details: built.details,
    now,
    expiresAt: new Date(now.getTime() + ttl * 1000),
  });
  if (created) {
    await ctx.audit.record({
      actorUserId: session.userId,
      action: "funding.plan.created",
      subjectType: "funding_plan",
      subjectId: planId,
      details: { route, kind, market: built.market, steps: plan.steps.length },
      ip: auditIp(request),
    });
  }
  if (stored.bodyHash !== bodyHash) throw new ApiError("CONFLICT", "This Idempotency-Key was already used with a different request body");
  return toView(stored);
}

/**
 * Records a reported transaction hash for a step (idempotent; at most 8 per step) and moves the plan
 * planned -> submitted. Terminal plans are returned unchanged. Owner only: anything else is NOT_FOUND. Only a NEW
 * {stepId, txHash} is audited; a repeated identical hint is an idempotent replay and writes no audit entry (PRD-04 4b).
 */
export async function recordSubmitted(ctx: AppContext, request: FastifyRequest, userId: string, planId: string, stepId: string, txHash: string): Promise<PlanView> {
  const plan = await findOwnedPlan(ctx.db, userId, planId);
  if (!plan) throw new ApiError("NOT_FOUND", "Plan not found");
  const step = plan.steps.find((item) => item.id === stepId);
  if (!step) throw new ApiError("NOT_FOUND", "Plan step not found");
  const hash = txHash.toLowerCase();
  if (plan.state !== "planned" && plan.state !== "submitted") return toView(plan);
  const now = ctx.clock.now();
  if (!step.txHashes.includes(hash)) {
    const appended = await rows(
      ctx.db,
      sql`UPDATE funding_plan_steps SET tx_hashes = array_append(tx_hashes, ${hash}::text)
          WHERE plan_id = ${planId}::uuid AND step_id = ${stepId} AND NOT (${hash}::text = ANY(tx_hashes)) AND cardinality(tx_hashes) < ${MAX_TX_HASHES_PER_STEP}
          RETURNING step_id`,
    );
    if (appended.length > 0) {
      await ctx.audit.record({ actorUserId: userId, action: "funding.plan.tx_reported", subjectType: "funding_plan", subjectId: planId, details: { stepId, txHash: hash }, ip: auditIp(request) });
    } else {
      const again = await findOwnedPlan(ctx.db, userId, planId);
      if (!again?.steps.find((item) => item.id === stepId)?.txHashes.includes(hash)) {
        throw new ApiError("CONFLICT", `A step accepts at most ${MAX_TX_HASHES_PER_STEP} reported transaction hashes`);
      }
    }
  }
  await rows(ctx.db, sql`UPDATE funding_plans SET state = 'submitted', updated_at = ${ts(now)} WHERE id = ${planId}::uuid AND state = 'planned' RETURNING id`);
  const updated = await findOwnedPlan(ctx.db, userId, planId);
  if (!updated) throw new ApiError("NOT_FOUND", "Plan not found");
  return toView(updated);
}
