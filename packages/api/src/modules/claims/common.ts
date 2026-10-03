// Shared pieces of the claims module: deployment manifest checks, read-model readiness, time helpers, public responses.

import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { buildDeploymentManifest, type DeploymentManifest } from "@pine/shared/deployment";
import type { IndexerStatus } from "@pine/shared/read-model";
import type { AppContext, SessionInfo } from "../../contracts/app.js";
import type { AppConfig } from "../../contracts/config.js";
import { ApiError } from "../../contracts/errors.js";

export const DAY = 86_400;
export const MINUTE = 60;
/** API bounds of the evidence window (ADR D6), intersected with the configured bounds. */
export const API_MIN_EVIDENCE_WINDOW = 3 * DAY;
export const API_MAX_EVIDENCE_WINDOW = 30 * DAY;
/** On-chain ClaimRegistry minimum evidence window: createClaim reverts once evidenceDeadline - 1 day has passed. */
export const ONCHAIN_MIN_EVIDENCE_WINDOW = DAY;
/** A plan is withdrawn this long before the on-chain minimum window would be violated. */
export const PLAN_SAFETY_MARGIN = 15 * MINUTE;
/** A preview's plan is offered for at most this long. */
export const PREVIEW_PLAN_TTL = DAY;
export const XDAI = 10n ** 18n;
export const MIN_BOND_LOWER = 1n * XDAI;
export const MIN_BOND_UPPER = 100n * XDAI;
export const CLAIM_DOCUMENT_FETCH_MAX = 262_144;
export const CREATE_CLAIM_GAS_ESTIMATE = 1_800_000n;
export const MAX_UINT32 = 2 ** 32 - 1;

export const SANDBOX_WARNING = "Reproduce only in an isolated sandbox without secrets, keys or network access to production systems.";
/** SEC-AGENT-02: every feed item carries this warning code with the fixed warning text. */
export const SANDBOX_WARNING_CODE = "sandbox_only";

export const PUBLIC_ROUTE = { pine: { public: true } } as const;

export const nowSeconds = (ctx: Pick<AppContext, "clock">): number => Math.floor(ctx.clock.now().getTime() / 1000);

export const isoSeconds = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

export const roundUpToMinute = (seconds: number): number => Math.ceil(seconds / MINUTE) * MINUTE;

/** Plan offer expiry (ADR D6, decisions): min(evidenceDeadline - 1 day - 15 min, previewCreatedAt + 24 h). */
export const planExpiry = (evidenceDeadline: number, previewCreatedAt: number): number =>
  Math.min(evidenceDeadline - ONCHAIN_MIN_EVIDENCE_WINDOW - PLAN_SAFETY_MARGIN, previewCreatedAt + PREVIEW_PLAN_TTL);

export function evidenceWindowBounds(config: AppConfig): { min: number; max: number } {
  return {
    min: Math.max(API_MIN_EVIDENCE_WINDOW, config.claims.minEvidenceWindowSeconds),
    max: Math.min(API_MAX_EVIDENCE_WINDOW, config.claims.maxEvidenceWindowSeconds),
  };
}

/** The deployment manifest every plan, preview and integrity check uses (one source). */
export function manifestOf(config: AppConfig): DeploymentManifest {
  return buildDeploymentManifest(config.contracts, config.chainId);
}

/** Throws when config.seer (or the AMM / Kleros addresses) disagree with the verified manifest. */
export function assertConfigMatchesManifest(config: AppConfig, manifest: DeploymentManifest): void {
  const pairs: [string, string | number, string | number][] = [
    ["seer.marketFactory", config.seer.marketFactory, manifest.seer.marketFactory],
    ["seer.realityProxy", config.seer.realityProxy, manifest.seer.realityProxy],
    ["seer.gnosisRouter", config.seer.gnosisRouter, manifest.seer.gnosisRouter],
    ["seer.conditionalTokens", config.seer.conditionalTokens, manifest.seer.conditionalTokens],
    ["seer.wrapped1155Factory", config.seer.wrapped1155Factory, manifest.seer.wrapped1155Factory],
    ["seer.collateralToken", config.seer.collateralToken, manifest.seer.collateralToken],
    ["seer.realitio", config.seer.realitio, manifest.seer.realitio],
    ["seer.arbitrator", config.seer.arbitrator, manifest.seer.arbitrator],
    ["seer.questionTimeoutSeconds", config.seer.questionTimeoutSeconds, manifest.seer.questionTimeoutSeconds],
    ["seer.klerosForeignProxy", config.seer.klerosForeignProxy, manifest.kleros.foreignProxy],
    ["seer.klerosForeignChainId", config.seer.klerosForeignChainId, manifest.kleros.foreignChainId],
  ];
  const differing = pairs.filter(([, configured, pinned]) => String(configured).toLowerCase() !== String(pinned).toLowerCase()).map(([name]) => name);
  if (differing.length > 0) throw new Error(`claims: configuration disagrees with the deployment manifest: ${differing.join(", ")}`);
  if (config.claims.revealWindowSeconds <= 0) throw new Error("claims: revealWindowSeconds must be positive");
}

export interface Freshness {
  indexedBlock: string;
  indexedBlockTimestamp: number;
  lagSeconds: number;
  halted: boolean;
  stale: boolean;
}

export function freshnessOf(status: IndexerStatus, now: number, config: AppConfig): Freshness {
  const lagSeconds = Math.max(0, now - status.indexedBlockTimestamp);
  return {
    indexedBlock: status.indexedBlock.toString(),
    indexedBlockTimestamp: status.indexedBlockTimestamp,
    lagSeconds,
    halted: status.halted,
    stale: status.halted || lagSeconds > config.maxIndexerLagSeconds,
  };
}

/** NOT_READY unless the read model is fresh and not halted (plans are never built on stale chain data). */
export async function assertReadModelReady(ctx: AppContext): Promise<IndexerStatus> {
  const status = await ctx.readModel.status();
  const freshness = freshnessOf(status, nowSeconds(ctx), ctx.config);
  if (freshness.halted) throw new ApiError("NOT_READY", "Chain data is unavailable (indexer halted); try again later", { retryAfterSeconds: 60 });
  if (freshness.stale) throw new ApiError("NOT_READY", "Chain data is behind; try again shortly", { retryAfterSeconds: 30 });
  return status;
}

export function sessionOf(request: FastifyRequest): SessionInfo {
  if (!request.session) throw new ApiError("UNAUTHENTICATED", "Sign in required");
  return request.session;
}

/**
 * Fields whose value depends only on the clock (not on what the response shows): left out of the ETag's hashed form so
 * a cache can revalidate while only time passes within a phase (PRD-03 §8b). Every public body was inspected: the only
 * such field is `indexer.lagSeconds` (bodies carry absolute timestamps, no generated-at or seconds-remaining values);
 * `indexer.indexedBlock` and the `stale`/`halted` flags stay in.
 */
export const CLOCK_ONLY_FIELDS: readonly (readonly [string, string])[] = [["indexer", "lagSeconds"]];

/** The form of a body that the ETag hashes: the body without its clock-only fields. */
export function etagForm(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const copy: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const [parent, field] of CLOCK_ONLY_FIELDS) {
    const nested = copy[parent];
    if (typeof nested === "object" && nested !== null && !Array.isArray(nested) && field in nested) {
      const { [field]: _omitted, ...rest } = nested as Record<string, unknown>;
      copy[parent] = rest;
    }
  }
  return copy;
}

/** Strong ETag: SHA-256 of the final serialized body without its clock-only fields (operator decision, PRD-03 §8b). */
export const etagOf = (body: unknown): string => `"${createHash("sha256").update(JSON.stringify(etagForm(body))).digest("base64url")}"`;

/**
 * Sends a public, cookie-free response with a strong ETag (etagOf; 304 on a matching If-None-Match): the ETag covers
 * everything the response shows (moderation, phase, integrity, listability, oracle facts, indexed block, staleness) by
 * construction, and only the clock-only lag is left out. Moderated resources (claim lists, details, agent feeds) use the
 * default `no-cache`, so a shared cache revalidates every time and a hide or block takes effect immediately; only
 * unmoderated resources pass a max-age. Handlers that call this never read request.session, so the output is identical
 * with or without credentials.
 */
export function sendPublic(request: FastifyRequest, reply: FastifyReply, body: unknown, cache: { maxAgeSeconds: number } | "no-cache" = "no-cache"): FastifyReply {
  const json = JSON.stringify(body);
  const etag = etagOf(body);
  void reply.header("etag", etag);
  void reply.header("cache-control", cache === "no-cache" ? "public, no-cache" : `public, max-age=${cache.maxAgeSeconds}`);
  void reply.header("vary", "Accept-Encoding");
  const match = request.headers["if-none-match"];
  if (typeof match === "string" && match.split(",").some((value) => value.trim() === etag)) return reply.status(304).send();
  return reply.type("application/json; charset=utf-8").send(json);
}

export function auditIp(request: FastifyRequest): string | null {
  return typeof request.ip === "string" && request.ip.length > 0 ? request.ip : null;
}

const lowerHex = /^0x[0-9a-f]*$/;
export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase() && lowerHex.test(a.toLowerCase());
