// Shared pieces of the markets module: deployment manifest, read-model readiness, plan context and limits, public
// responses, request helpers.

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { canonicalJson, type JsonValue } from "@pine/shared/canonical";
import { buildDeploymentManifest, type DeploymentManifest } from "@pine/shared/deployment";
import { InvalidCursorError, type ClaimRecord, type IndexerStatus } from "@pine/shared/read-model";
import type { PlanContext, PlanLimits } from "@pine/shared/tx-plan";
import type { Address, Hex32 } from "@pine/shared/types";
import type { AppContext, SessionInfo } from "../../contracts/app.js";
import type { AppConfig } from "../../contracts/config.js";
import { ApiError } from "../../contracts/errors.js";

export const MINUTE = 60;
export const HOUR = 3_600;
export const DAY = 86_400;
export const XDAI = 10n ** 18n;

/** Commit/publish/reveal are refused this long before the on-chain deadline (submission margin; the contract decides). */
export const SUBMISSION_MARGIN_SECONDS = 60;

/** verifyPlan limits of the markets lane (PRD-04 section 1): no approvals at all, at most 10,000 xDAI of value. */
export const MARKETS_PLAN_LIMITS: PlanLimits = { maxTotalValueWei: 10_000n * XDAI, maxApprovalAmount: 0n };

export const PUBLIC_ROUTE = { pine: { public: true } } as const;

/** Labels every user-originated field (SEC-EVID-15, ADR D13). */
export const CONTENT_TRUST = "untrusted" as const;

export const withZod = (app: FastifyInstance) => app.withTypeProvider<ZodTypeProvider>();
export type ZodApp = ReturnType<typeof withZod>;

export interface MarketsState {
  manifest: DeploymentManifest;
  /** Detail-route availability cache (`retrievable`), keyed by content digest. */
  retrievableCache: Map<string, { value: boolean; until: number }>;
  /** Public oracle-status responses (they fan out to eth_call), keyed by market and account. */
  oracleCache: BoundedCache<unknown>;
  /** At most this many oracle-status cache misses fan out to RPC at once (PRD-04 4b). */
  oracleFanOut: FanOutLimiter;
  /** At most this many evidence-detail `retrievable` cache misses reach the content store's gateways at once (PRD-07). */
  retrieveFanOut: FanOutLimiter;
  /** Read-model pages of public evidence listings, keyed by market, status and cursor (10 s); never rendered output. */
  evidenceCache: BoundedCache<unknown>;
}

/**
 * A non-blocking semaphore for public routes that fan out to RPC: a request that finds every slot taken is refused at
 * once with RATE_LIMITED (429, Retry-After), never queued, so slow RPC cannot pile up requests in memory.
 */
export class FanOutLimiter {
  private inFlight = 0;
  constructor(
    readonly maxInFlight: number,
    readonly retryAfterSeconds: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.maxInFlight) throw new ApiError("RATE_LIMITED", "Too many chain reads in progress; try again shortly", { retryAfterSeconds: this.retryAfterSeconds });
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
    }
  }

  get active(): number {
    return this.inFlight;
  }
}

/** A small TTL cache bounded in entries (expired entries first, then the oldest, are evicted). Times in unix seconds. */
export class BoundedCache<T> {
  private readonly entries = new Map<string, { value: T; until: number }>();
  constructor(
    readonly ttlSeconds: number,
    readonly maxEntries: number,
  ) {}

  get(key: string, now: number): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now >= entry.until) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, now: number): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      for (const [stale, entry] of this.entries) if (now >= entry.until) this.entries.delete(stale);
      while (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, { value, until: now + this.ttlSeconds });
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface MarketsRouteDeps {
  app: ZodApp;
  ctx: AppContext;
  state: MarketsState;
}

export const nowSeconds = (ctx: Pick<AppContext, "clock">): number => Math.floor(ctx.clock.now().getTime() / 1000);

export const isoSeconds = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

export function manifestOf(config: AppConfig): DeploymentManifest {
  return buildDeploymentManifest(config.contracts, config.chainId);
}

/** Throws when the configuration disagrees with the verified deployment manifest or the ClaimRegistry constants. */
export function assertConfig(config: AppConfig, manifest: DeploymentManifest): void {
  const pairs: [string, string | number, string | number][] = [
    ["seer.realityProxy", config.seer.realityProxy, manifest.seer.realityProxy],
    ["seer.realitio", config.seer.realitio, manifest.seer.realitio],
    ["seer.arbitrator", config.seer.arbitrator, manifest.seer.arbitrator],
    ["seer.marketFactory", config.seer.marketFactory, manifest.seer.marketFactory],
    ["seer.gnosisRouter", config.seer.gnosisRouter, manifest.seer.gnosisRouter],
    ["seer.conditionalTokens", config.seer.conditionalTokens, manifest.seer.conditionalTokens],
    ["seer.wrapped1155Factory", config.seer.wrapped1155Factory, manifest.seer.wrapped1155Factory],
    ["seer.collateralToken", config.seer.collateralToken, manifest.seer.collateralToken],
    ["seer.questionTimeoutSeconds", config.seer.questionTimeoutSeconds, manifest.seer.questionTimeoutSeconds],
    ["seer.klerosForeignProxy", config.seer.klerosForeignProxy, manifest.kleros.foreignProxy],
    ["seer.klerosForeignChainId", config.seer.klerosForeignChainId, manifest.kleros.foreignChainId],
    // reopenQuestion must re-create the question exactly; the ClaimRegistry asks with these constants.
    ["claims.questionCategory", config.claims.questionCategory, "misc"],
    ["claims.questionLanguage", config.claims.questionLanguage, "en_US"],
  ];
  const differing = pairs.filter(([, configured, pinned]) => String(configured).toLowerCase() !== String(pinned).toLowerCase()).map(([name]) => name);
  if (differing.length > 0) throw new Error(`markets: configuration disagrees with the deployment manifest: ${differing.join(", ")}`);
  const maxUpload = config.evidence.maxUploadBytes;
  if (!Number.isSafeInteger(maxUpload) || maxUpload < 1 || maxUpload > 262_144) throw new Error("markets: evidence.maxUploadBytes must be 1..262144");
}

export interface Freshness {
  indexedBlock: string;
  indexedBlockTimestamp: number;
  finalizedBlock: string | null;
  headBlock: string | null;
  lagSeconds: number;
  halted: boolean;
  stale: boolean;
  status: "ok" | "lagging" | "stalled";
}

/** Staleness of the read model (SEC-IDX-07): stale when halted or more than maxIndexerLagSeconds behind the clock. */
export function freshnessOf(status: IndexerStatus, now: number, config: AppConfig): Freshness {
  const lagSeconds = Math.max(0, now - status.indexedBlockTimestamp);
  const lagging = lagSeconds > config.maxIndexerLagSeconds;
  return {
    indexedBlock: status.indexedBlock.toString(),
    indexedBlockTimestamp: status.indexedBlockTimestamp,
    finalizedBlock: status.finalizedBlock === null ? null : status.finalizedBlock.toString(),
    headBlock: status.headBlock === null ? null : status.headBlock.toString(),
    lagSeconds,
    halted: status.halted,
    stale: status.halted || lagging,
    status: status.halted ? "stalled" : lagging ? "lagging" : "ok",
  };
}

export async function freshness(ctx: AppContext): Promise<Freshness> {
  return freshnessOf(await ctx.readModel.status(), nowSeconds(ctx), ctx.config);
}

/** NOT_READY unless the read model is fresh and not halted (plans are never built on stale chain data). */
export async function assertReadModelReady(ctx: AppContext): Promise<Freshness> {
  const current = await freshness(ctx);
  if (current.halted) throw new ApiError("NOT_READY", "Chain data is unavailable (indexer halted); try again later", { retryAfterSeconds: 60 });
  if (current.stale) throw new ApiError("NOT_READY", "Chain data is behind; try again shortly", { retryAfterSeconds: 30 });
  return current;
}

export function sessionOf(request: FastifyRequest): SessionInfo {
  if (!request.session) throw new ApiError("UNAUTHENTICATED", "Sign in required");
  return request.session;
}

export const lowerAddress = (value: string): Address => value.toLowerCase() as Address;

export const addressParam = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address")
  .transform((value) => value.toLowerCase() as Address);

export const hex32Param = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x-prefixed 32-byte hex")
  .transform((value) => value.toLowerCase() as Hex32);

/** Opaque cursors are bounded strings; the read model validates them (InvalidCursorError -> 400). */
export const cursorParam = z.string().min(1).max(512);

export const ZERO_HASH: Hex32 = `0x${"0".repeat(64)}`;

/** The registered claim for `market` (created by the configured ClaimRegistry), or NOT_FOUND. */
export async function requireClaim(ctx: AppContext, state: MarketsState, market: Address): Promise<ClaimRecord> {
  const claim = await ctx.readModel.getClaim(market);
  if (!claim || claim.registry !== state.manifest.pine.claimRegistry) throw new ApiError("NOT_FOUND", "No registered claim for this market");
  return claim;
}

/** Plan context of one claim: its outcome tokens and every question id that belongs to it. */
export function planContextOf(claim: ClaimRecord, questionIds: readonly Hex32[]): PlanContext {
  return {
    markets: new Map([[claim.market, [claim.yesToken, claim.noToken, claim.invalidToken]]]),
    questionIds: new Set([claim.questionId, ...questionIds].map((id) => id.toLowerCase() as Hex32)),
  };
}

/** Converts read-model cursor errors into a client error. */
export async function withCursor<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof InvalidCursorError) throw new ApiError("BAD_REQUEST", "Invalid cursor");
    throw error;
  }
}

/** SHA-256 (hex, no prefix) of the RFC 8785 form of a value; bigint values are hashed as decimal strings. */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(toJsonValue(value)), "utf8").digest("hex");
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (item !== undefined) out[key] = toJsonValue(item);
    return out;
  }
  throw new Error("value is not JSON-representable");
}

/** Cache-Control value of a public response that shared caches may keep for `seconds`. */
export const publicMaxAge = (seconds: number): string => `public, max-age=${seconds}`;

/**
 * Sends a public, cookie-free response with a strong ETag over the exact JSON body (304 on If-None-Match) and the given
 * Cache-Control (`no-store` for responses carrying moderated content, SEC-EVID-11). Handlers that call this never read
 * request.session, so the output is identical with or without credentials.
 */
export function sendPublic(request: FastifyRequest, reply: FastifyReply, body: unknown, cacheControl: string = publicMaxAge(15)): FastifyReply {
  const json = JSON.stringify(toJsonValue(body));
  const etag = `"${createHash("sha256").update(json).digest("base64url")}"`;
  void reply.header("etag", etag);
  void reply.header("cache-control", cacheControl);
  const match = request.headers["if-none-match"];
  if (typeof match === "string" && match.split(",").some((value) => value.trim() === etag)) return reply.status(304).send();
  return reply.type("application/json; charset=utf-8").send(json);
}

export function auditIp(request: FastifyRequest): string | null {
  return typeof request.ip === "string" && request.ip.length > 0 ? request.ip : null;
}

/** Wraps an eth_call so RPC failures (whose text may carry provider URLs) become a fixed client error. */
export async function chainRead<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new ApiError("UPSTREAM_UNAVAILABLE", "Could not read the chain; try again");
  }
}
