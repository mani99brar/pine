// Shared pieces of the funding module: deployment manifest checks, read-model readiness, claim lookup, plan context,
// request helpers and the fixed disclosure texts.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { buildDeploymentManifest, type DeploymentManifest } from "@pine/shared/deployment";
import type { ClaimRecord } from "@pine/shared/read-model";
import type { PlanContext, PlanLimits } from "@pine/shared/tx-plan";
import type { Address, Hex32 } from "@pine/shared/types";
import type { AppContext, SessionInfo } from "../../contracts/app.js";
import type { AppConfig } from "../../contracts/config.js";
import { ApiError } from "../../contracts/errors.js";

export const withZod = (app: FastifyInstance) => app.withTypeProvider<ZodTypeProvider>();
export type ZodApp = ReturnType<typeof withZod>;

export const XDAI = 10n ** 18n;
export const MINUTE = 60;
export const HOUR = 3_600;

/** verifyPlan limits of the funding lane (decisions): 10,000 xDAI total value; approvals sanity-bounded at 10^30. */
export const FUNDING_PLAN_LIMITS: PlanLimits = { maxTotalValueWei: 10_000n * XDAI, maxApprovalAmount: 10n ** 30n };

/** Ladder prices are within [0.01, 0.95] sDAI per YES (PRD-04 3.2; decisions). */
export const MIN_LADDER_PRICE_WAD = 10n ** 16n;
export const MAX_LADDER_PRICE_WAD = 95n * 10n ** 16n;
/** The ladder needs at least this long before the evidence deadline (PRD-04 3.2 step 1). */
export const LADDER_MIN_TIME_BEFORE_DEADLINE = HOUR;
/** Tick spacing of pools created by the factory (docs/research/liquidity-amm.md 2.1). */
export const NEW_POOL_TICK_SPACING = 60;

export const PUBLIC_ROUTE = { pine: { public: true } } as const;

export const PRICE_LABEL = "Last pool price (marginal price). Not a probability that the code is correct.";

/** Policy C7 (policies/catalog/src/common.md), verbatim. */
export const C7_DISCLOSURES: readonly string[] = [
  '"No" means that no qualifying counterexample was submitted in time. It is not a certification that the software is correct, safe or complete.',
  "A market price reflects the defined submission-and-resolution event, not the probability that the software has no defects.",
  "Liquidity is not a bounty: it is not reserved for researchers, can be traded against by anyone, and may be withdrawable by whoever provided it.",
  "Invalid is not a refund. In Seer categorical markets an invalid result pays only the Invalid outcome token.",
  "Evidence deadlines are not trading cutoffs; outcome tokens may remain transferable and tradable after them.",
];

export const nowSeconds = (ctx: Pick<AppContext, "clock">): number => Math.floor(ctx.clock.now().getTime() / 1000);

export const lower = (value: string): Address => value.toLowerCase() as Address;

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address")
  .transform((value) => value.toLowerCase() as Address);

const UINT_STRING = /^(?:0|[1-9][0-9]{0,77})$/;
/**
 * True when `value` is a base-10 unsigned integer string that BigInt() accepts. zod 4 still runs refinements after a
 * failed `.regex`, so every refinement that calls BigInt() must check this itself (otherwise "abc" throws: a 500).
 */
export const isUintString = (value: unknown): value is string => typeof value === "string" && UINT_STRING.test(value);

export const uintStringSchema = z.string().regex(UINT_STRING, "must be a base-10 unsigned integer string");

/** The deployment manifest every plan and read uses (one source). */
export function manifestOf(config: AppConfig): DeploymentManifest {
  return buildDeploymentManifest(config.contracts, config.chainId);
}

/** Throws when the configured Seer/AMM addresses disagree with the verified manifest (fail closed at startup). */
export function assertConfigMatchesManifest(config: AppConfig, manifest: DeploymentManifest): void {
  const pairs: [string, string, string][] = [
    ["seer.gnosisRouter", config.seer.gnosisRouter, manifest.seer.gnosisRouter],
    ["seer.collateralToken", config.seer.collateralToken, manifest.seer.collateralToken],
    ["seer.conditionalTokens", config.seer.conditionalTokens, manifest.seer.conditionalTokens],
    ["seer.marketFactory", config.seer.marketFactory, manifest.seer.marketFactory],
    ["seer.realitio", config.seer.realitio, manifest.seer.realitio],
    ["seer.arbitrator", config.seer.arbitrator, manifest.seer.arbitrator],
    ["amm.factory", config.amm.factory, manifest.amm.factory],
    ["amm.positionManager", config.amm.positionManager, manifest.amm.positionManager],
    ["amm.quoter", config.amm.quoter, manifest.amm.quoter],
  ];
  const differing = pairs.filter(([, configured, pinned]) => configured.toLowerCase() !== pinned.toLowerCase()).map(([name]) => name);
  if (differing.length > 0) throw new Error(`funding: configuration disagrees with the deployment manifest: ${differing.join(", ")}`);
  if (config.chainId !== manifest.chainId) throw new Error("funding: configured chain id disagrees with the deployment manifest");
}

/** NOT_READY unless the read model is fresh and not halted (plans are never built on stale chain data). */
export async function assertReadModelReady(ctx: AppContext): Promise<void> {
  const status = await ctx.readModel.status();
  if (status.halted) throw new ApiError("NOT_READY", "Chain data is unavailable (indexer halted); try again later", { retryAfterSeconds: 60 });
  const lag = nowSeconds(ctx) - status.indexedBlockTimestamp;
  if (lag > ctx.config.maxIndexerLagSeconds) throw new ApiError("NOT_READY", "Chain data is behind; try again shortly", { retryAfterSeconds: 30 });
}

/** True when the read model is neither halted nor lagging (the same rule as assertReadModelReady). */
export async function readModelFreshness(ctx: AppContext): Promise<boolean> {
  try {
    await assertReadModelReady(ctx);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === "NOT_READY") return false;
    throw error;
  }
}

/** The claim for `market` created by the configured ClaimRegistry (as the markets lane checks), or NOT_FOUND. */
export async function requireClaim(ctx: AppContext, manifest: DeploymentManifest, market: Address): Promise<ClaimRecord> {
  const claim = await ctx.readModel.getClaim(lower(market));
  if (!claim || lower(claim.registry) !== lower(manifest.pine.claimRegistry)) throw new ApiError("NOT_FOUND", "Market is not a registered claim");
  return claim;
}

/** verifyPlan context for one registered claim market: market -> [YES, NO, INVALID]. */
export function planContextFor(claim: ClaimRecord): PlanContext {
  return {
    markets: new Map<Address, readonly Address[]>([[lower(claim.market), [lower(claim.yesToken), lower(claim.noToken), lower(claim.invalidToken)]]]),
    questionIds: new Set<Hex32>([claim.questionId.toLowerCase() as Hex32]),
  };
}

export function sessionOf(request: FastifyRequest): SessionInfo {
  if (!request.session) throw new ApiError("UNAUTHENTICATED", "Sign in required");
  return request.session;
}

/** A bounded in-process cache whose entries expire by ctx.clock time (public routes that fan out to RPC). */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { expiresAt: number; value: V }>();
  constructor(
    readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}
  get(key: K, nowMs: number): V | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= nowMs) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }
  set(key: K, value: V, nowMs: number): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { expiresAt: nowMs + this.ttlMs, value });
  }
}

/**
 * A non-blocking per-route semaphore for public routes that fan out to RPC (PRD-04 4b): at most `limit` requests in
 * flight per process; a request beyond it is refused immediately with RATE_LIMITED (429), never queued.
 */
export class FanOutLimiter {
  private inFlight = 0;
  constructor(
    readonly limit: number,
    private readonly retryAfterSeconds: number,
  ) {}
  get active(): number {
    return this.inFlight;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.limit) throw new ApiError("RATE_LIMITED", "Too many concurrent chain reads; try again shortly", { retryAfterSeconds: this.retryAfterSeconds });
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
    }
  }
}

export const isoSeconds = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
