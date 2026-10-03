// Publication (PRD-03 §6, SEC-TX-01..11): one createClaim plan per (user, document digest), bound to the previewed bytes,
// built only on fresh chain data, after the document is stored, and verified with verifyPlan before it is returned.

import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { zeroAddress } from "viem";
import { z } from "zod";
import { claimRegistryAbi } from "@pine/shared/abi/generated";
import { ClaimDocumentError, parseClaimDocumentBytes, type ClaimDocument } from "@pine/shared/claim-document";
import type { DeploymentManifest } from "@pine/shared/deployment";
import { buildStep, newPlan, planToWire, verifyPlan, type TxPlan, type WireTxPlan } from "@pine/shared/tx-plan";
import type { Address, Hex32 } from "@pine/shared/types";
import { GitHubGatewayError, type AppContext, type SessionInfo } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { assertReadModelReady, auditIp, CLAIM_DOCUMENT_FETCH_MAX, isoSeconds, nowSeconds, sessionOf } from "./common.js";
import { fromMs, msOf, one, rows, sql, toBytes, toNumber, ts, type Executor } from "./db.js";
import { publicationInsertRaceError } from "./races.js";
import type { ClaimsRouteDeps } from "./state.js";

export const PUBLICATION_STATES = ["planned", "submitted", "mined", "confirmed", "failed", "expired"] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];
export const OPEN_STATES: readonly PublicationState[] = ["planned", "submitted", "mined"];
const FINAL_STATES: readonly PublicationState[] = ["confirmed", "failed", "expired"];
export const MAX_TX_HINTS = 20;

export interface PublicationRow {
  id: string;
  userId: string;
  previewId: string;
  draftId: string;
  documentSha256: Hex32;
  creator: Address;
  planId: string;
  state: PublicationState;
  market: Address | null;
  evidenceDeadline: number;
  planExpiresAt: number;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RawPublication {
  id: string;
  user_id: string;
  preview_id: string;
  draft_id: string;
  document_sha256: string;
  creator: string;
  plan_id: string;
  state: string;
  market: string | null;
  evidence_deadline: unknown;
  plan_expires_at: unknown;
  failure_reason: string | null;
  created_ms: unknown;
  updated_ms: unknown;
}

export const publicationColumns = sql`id::text AS id, user_id::text AS user_id, preview_id::text AS preview_id, draft_id::text AS draft_id,
  document_sha256, creator, plan_id::text AS plan_id, state, market, evidence_deadline::text AS evidence_deadline,
  plan_expires_at::text AS plan_expires_at, failure_reason, ${msOf(sql`created_at`)} AS created_ms, ${msOf(sql`updated_at`)} AS updated_ms`;

export function toPublication(row: RawPublication): PublicationRow {
  if (!(PUBLICATION_STATES as readonly string[]).includes(row.state)) throw new Error("unknown publication state");
  return {
    id: row.id,
    userId: row.user_id,
    previewId: row.preview_id,
    draftId: row.draft_id,
    documentSha256: row.document_sha256 as Hex32,
    creator: row.creator as Address,
    planId: row.plan_id,
    state: row.state as PublicationState,
    market: row.market as Address | null,
    evidenceDeadline: toNumber(row.evidence_deadline),
    planExpiresAt: toNumber(row.plan_expires_at),
    failureReason: row.failure_reason,
    createdAt: fromMs(row.created_ms),
    updatedAt: fromMs(row.updated_ms),
  };
}

export async function findPublication(db: Executor, query: { userId: string; id?: string; documentSha256?: Hex32 }): Promise<PublicationRow | null> {
  const where = query.id !== undefined ? sql`id = ${query.id}::uuid` : sql`document_sha256 = ${query.documentSha256 ?? ""}`;
  const row = await one<RawPublication>(db, sql`SELECT ${publicationColumns} FROM claim_publications WHERE user_id = ${query.userId}::uuid AND ${where}`);
  return row ? toPublication(row) : null;
}

export async function txHintsOf(db: Executor, publicationId: string): Promise<{ txHash: Hex32; status: string; reason: string | null }[]> {
  const list = await rows<{ tx_hash: string; status: string; reason: string | null }>(
    db,
    sql`SELECT tx_hash, status, reason FROM claim_publication_txs WHERE publication_id = ${publicationId}::uuid ORDER BY reported_at, tx_hash`,
  );
  return list.map((row) => ({ txHash: row.tx_hash as Hex32, status: row.status, reason: row.reason }));
}

/**
 * Compare-and-set state transition. Success is read only from RETURNING rows. Returns the updated row or null when
 * another writer moved the publication first.
 */
export async function transitionPublication(
  db: Executor,
  id: string,
  from: readonly PublicationState[],
  to: PublicationState,
  now: Date,
  fields: { market?: Address; failureReason?: string; clearMarket?: boolean } = {},
): Promise<PublicationRow | null> {
  const fromList = JSON.stringify(from);
  const row = await one<RawPublication>(
    db,
    sql`UPDATE claim_publications
        SET state = ${to}, updated_at = ${ts(now)},
            market = CASE WHEN ${fields.clearMarket === true}::boolean THEN NULL ELSE COALESCE(${fields.market ?? null}::text, market) END,
            failure_reason = COALESCE(${fields.failureReason ?? null}::text, failure_reason)
        WHERE id = ${id}::uuid AND state IN (SELECT jsonb_array_elements_text(${fromList}::jsonb))
        RETURNING ${publicationColumns}`,
  );
  return row ? toPublication(row) : null;
}

export async function publicationView(db: Executor, publication: PublicationRow, now: number) {
  return {
    id: publication.id,
    state: publication.state,
    previewId: publication.previewId,
    draftId: publication.draftId,
    documentSha256: publication.documentSha256,
    creator: publication.creator,
    planId: publication.planId,
    market: publication.market,
    planExpiresAt: publication.planExpiresAt,
    planExpiresAtIso: isoSeconds(publication.planExpiresAt),
    planExpired: now >= publication.planExpiresAt,
    failureReason: publication.failureReason,
    transactions: await txHintsOf(db, publication.id),
    createdAt: publication.createdAt.toISOString(),
    updatedAt: publication.updatedAt.toISOString(),
  };
}

interface PreviewRow {
  id: string;
  draftId: string;
  draftRevision: number;
  document: Uint8Array;
  documentSha256: Hex32;
  cid: string;
  creator: Address;
  evidenceDeadline: number;
  planExpiresAt: number;
}

async function findPreview(db: Executor, userId: string, id: string): Promise<PreviewRow | null> {
  const row = await one<{
    id: string;
    draft_id: string;
    draft_revision: unknown;
    document: unknown;
    document_sha256: string;
    document_cid: string;
    creator: string;
    evidence_deadline: unknown;
    plan_expires_at: unknown;
  }>(
    db,
    sql`SELECT id::text AS id, draft_id::text AS draft_id, draft_revision::int AS draft_revision, document, document_sha256, document_cid, creator,
          evidence_deadline::text AS evidence_deadline, plan_expires_at::text AS plan_expires_at
        FROM claim_previews WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`,
  );
  if (!row) return null;
  return {
    id: row.id,
    draftId: row.draft_id,
    draftRevision: toNumber(row.draft_revision),
    document: toBytes(row.document),
    documentSha256: row.document_sha256 as Hex32,
    cid: row.document_cid,
    creator: row.creator as Address,
    evidenceDeadline: toNumber(row.evidence_deadline),
    planExpiresAt: toNumber(row.plan_expires_at),
  };
}

/**
 * SEC-GH-13 (PRD-03 §8d): the repository must still be public and visible to the user whenever a plan could be returned.
 * One `github_calls_per_hour` unit per upstream call (PRD-03 §3). Every failure refuses without a plan; there is no
 * "unchecked" fallback. REPO_NOT_PUBLIC and NOT_FOUND are 422 (the frozen error codes have no REPO_NOT_PUBLIC, so the
 * message names it), GITHUB_NOT_LINKED is 409, RATE_LIMITED and UPSTREAM are a 503 NOT_READY refusal.
 */
export async function assertRepositoryStillPublic(ctx: AppContext, userId: string, repositoryId: number): Promise<void> {
  await ctx.quotas.consume(userId, "github_calls_per_hour");
  let repo;
  try {
    repo = await ctx.github.getRepoById(userId, repositoryId);
  } catch (error) {
    if (!(error instanceof GitHubGatewayError)) throw error;
    switch (error.code) {
      case "REPO_NOT_PUBLIC":
      case "NOT_FOUND":
      case "NOT_A_MEMBER":
        throw repoNotPublic();
      case "GITHUB_NOT_LINKED":
        throw new ApiError("CONFLICT", "Connect your GitHub account again before publishing");
      case "RATE_LIMITED":
      case "UPSTREAM":
        throw new ApiError("NOT_READY", "Could not recheck the repository on GitHub; try again later", { retryAfterSeconds: 60 });
    }
  }
  // Defence in depth: the gateway contract says private is always false and ids are stable.
  if (repo.id !== repositoryId || (repo.private as boolean) !== false) throw repoNotPublic();
}

const repoNotPublic = () => new ApiError("UNPROCESSABLE", "REPO_NOT_PUBLIC: the repository is no longer public or visible to you; the claim cannot be published");

/** createClaim parameters derived only from the frozen document bytes (nothing is recomputed). */
export function createClaimParams(document: ClaimDocument, documentSha256: Hex32) {
  return {
    claimDocumentSha256: documentSha256,
    policyDocumentSha256: document.policy.sha256,
    repositoryId: BigInt(document.target.repository.id),
    commit: `0x${document.target.commit}` as `0x${string}`,
    evidenceDeadline: BigInt(document.evidence.evidenceDeadline),
    revealDeadline: BigInt(document.evidence.revealDeadline),
    minBond: BigInt(document.market.minBondWei),
    title: document.claim.title,
  };
}

export const PUBLICATION_PLAN_LIMITS = { maxTotalValueWei: 0n, maxApprovalAmount: 0n } as const;

export function buildPublicationPlan(manifest: DeploymentManifest, planId: string, account: Address, document: ClaimDocument, documentSha256: Hex32): TxPlan {
  const step = buildStep(manifest, { id: "create", allowlistId: "claimRegistry.createClaim", args: [createClaimParams(document, documentSha256)] });
  const plan = newPlan(manifest, planId, account, [step]);
  verifyPlan(plan, manifest, { markets: new Map(), questionIds: new Set() }, PUBLICATION_PLAN_LIMITS);
  return plan;
}

/** ClaimRegistry.marketOf(creator, digest) at the latest block; zero address when none. */
export async function marketOnChain(ctx: AppContext, manifest: DeploymentManifest, creator: Address, digest: Hex32): Promise<Address | null> {
  const market = await ctx.chain.publicClient.readContract({
    address: manifest.pine.claimRegistry,
    abi: claimRegistryAbi,
    functionName: "marketOf",
    args: [creator, digest],
    blockTag: "latest",
  });
  const lower = String(market).toLowerCase() as Address;
  return lower === zeroAddress ? null : lower;
}

const publicationBody = z
  .object({
    previewId: z.uuid(),
    documentSha256: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x-prefixed 32-byte hex").transform((value) => value.toLowerCase() as Hex32),
  })
  .strict();

const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed transaction hash").transform((value) => value.toLowerCase() as Hex32);

type InsertOutcome = { kind: "inserted"; row: RawPublication } | { kind: "taken" } | { kind: "missing" } | { kind: "edited" };

/**
 * The publication row for (user, digest): reused when it exists; otherwise `gate` (the publishability gate, before any
 * quota or insert), the repository recheck (SEC-GH-13), one `publications_per_day` unit, then the insert. No transaction is open across the quota call.
 * The insert runs in a transaction that first takes FOR SHARE on the draft row at the previewed revision (lock order of
 * PRD-03 §8b: a draft delete locks the same row FOR UPDATE first), so a draft deleted or edited after the earlier
 * checks yields NOT_FOUND or 409 and never a publication for a stale or deleted preview.
 */
async function createOrReusePublication(
  ctx: AppContext,
  request: FastifyRequest,
  session: SessionInfo,
  preview: PreviewRow,
  digest: Hex32,
  gate: () => void,
  recheckRepository: () => Promise<void>,
): Promise<{ publication: PublicationRow; created: boolean }> {
  const existing = await findPublication(ctx.db, { userId: session.userId, documentSha256: digest });
  if (existing) return { publication: existing, created: false };
  gate();
  // SEC-GH-13 on the new-row path: before the quota and the insert, so a refusal consumes nothing and creates nothing.
  await recheckRepository();
  await ctx.quotas.consume(session.userId, "publications_per_day");
  const now = ctx.clock.now();
  const id = randomUUID();
  let outcome: InsertOutcome;
  try {
    outcome = await ctx.db.transaction(async (tx): Promise<InsertOutcome> => {
      const draft = await one<{ id: string }>(
        tx,
        sql`SELECT id::text AS id FROM claim_drafts
            WHERE id = ${preview.draftId}::uuid AND user_id = ${session.userId}::uuid AND revision = ${preview.draftRevision}
            FOR SHARE`,
      );
      if (!draft) {
        const current = await one<{ id: string }>(tx, sql`SELECT id::text AS id FROM claim_drafts WHERE id = ${preview.draftId}::uuid AND user_id = ${session.userId}::uuid`);
        return { kind: current ? "edited" : "missing" };
      }
      const row = await one<RawPublication>(
        tx,
        sql`INSERT INTO claim_publications (id, user_id, preview_id, draft_id, document_sha256, creator, plan_id, state, market,
              evidence_deadline, plan_expires_at, created_at, updated_at)
            VALUES (${id}::uuid, ${session.userId}::uuid, ${preview.id}::uuid, ${preview.draftId}::uuid, ${digest}, ${preview.creator}, ${randomUUID()}::uuid,
              'planned', NULL, ${String(preview.evidenceDeadline)}::bigint, ${String(preview.planExpiresAt)}::bigint, ${ts(now)}, ${ts(now)})
            ON CONFLICT (user_id, document_sha256) DO NOTHING
            RETURNING ${publicationColumns}`,
      );
      return row ? { kind: "inserted", row } : { kind: "taken" };
    });
  } catch (error) {
    // The draft and its previews were deleted concurrently (FK), or a deadlock/serialization race: never a 500.
    const mapped = publicationInsertRaceError(error);
    if (mapped) throw mapped;
    throw error;
  }
  if (outcome.kind === "missing") throw new ApiError("NOT_FOUND", "Preview not found");
  if (outcome.kind === "edited") throw new ApiError("CONFLICT", "The draft was modified after this preview; preview again");
  if (outcome.kind === "inserted") {
    await ctx.audit.record({
      actorUserId: session.userId,
      action: "claim.publication.created",
      subjectType: "claim_publication",
      subjectId: id,
      details: { previewId: preview.id, documentSha256: digest, state: "planned" },
      ip: auditIp(request),
    });
    return { publication: toPublication(outcome.row), created: true };
  }
  // A concurrent identical request won the insert: reuse its row (never a duplicate, never a 500).
  const winner = await findPublication(ctx.db, { userId: session.userId, documentSha256: digest });
  if (!winner) throw new ApiError("CONFLICT", "The publication could not be created; try again");
  return { publication: winner, created: false };
}

export function registerPublicationRoutes({ app, ctx, state }: ClaimsRouteDeps): void {
  const guard = { preHandler: app.requireSession };
  const idParams = z.object({ id: z.uuid() }).strict();

  app.post("/api/v1/publications", { ...guard, schema: { body: publicationBody } }, async (request) => {
    const session = sessionOf(request);
    const { previewId, documentSha256 } = request.body;
    // Fixed order on every request, new or retry (PRD-03 §6).
    await ctx.compliance.assertAllowed(request, session, "publish_claim");
    await assertReadModelReady(ctx);
    const preview = await findPreview(ctx.db, session.userId, previewId);
    if (!preview) throw new ApiError("NOT_FOUND", "Preview not found");
    if (preview.documentSha256 !== documentSha256) throw new ApiError("CONFLICT", "The document digest does not match the preview; preview again");
    if (preview.creator !== session.wallet.toLowerCase()) throw new ApiError("CONFLICT", "The preview was made for a different wallet");
    const draft = await one<{ revision: unknown }>(ctx.db, sql`SELECT revision::int AS revision FROM claim_drafts WHERE id = ${preview.draftId}::uuid AND user_id = ${session.userId}::uuid`);
    if (!draft) throw new ApiError("NOT_FOUND", "Preview not found");
    if (toNumber(draft.revision) !== preview.draftRevision) throw new ApiError("CONFLICT", "The draft was modified after this preview; preview again");
    let document: ClaimDocument;
    try {
      document = parseClaimDocumentBytes(preview.document, preview.documentSha256);
    } catch (error) {
      // Frozen bytes that no longer pass the document rules (e.g. a title refused since the preview): never a plan.
      if (error instanceof ClaimDocumentError) throw new ApiError("CONFLICT", "The previewed document no longer passes the claim document rules; edit the draft and preview again");
      throw error;
    }
    // Publishability gate (SEC-CLAIM-06), applied only where a row would be created or a plan built (PRD-03 §8b).
    const gate = () => {
      const policy = state.catalog.requirePublishable(document.policy.id, document.policy.version, ctx.config);
      // SEC-CLAIM-03: the policy digest recomputed from the loaded catalog bytes must equal the previewed one.
      if (policy.sha256 !== document.policy.sha256) throw new ApiError("UNPROCESSABLE", "The policy text changed since the preview; preview again");
    };

    // SEC-GH-13: at most once per request, on whichever path would return a plan.
    let repositoryRechecked = false;
    const recheckRepository = async () => {
      if (repositoryRechecked) return;
      await assertRepositoryStillPublic(ctx, session.userId, document.target.repository.id);
      repositoryRechecked = true;
    };

    const result = await createOrReusePublication(ctx, request, session, preview, documentSha256, gate, recheckRepository);
    let publication = result.publication;
    if (publication.previewId !== preview.id) throw new ApiError("CONFLICT", "This document belongs to another preview");

    // Chain re-check on every request: an existing market is returned without any plan (SEC-TX-08), whatever the
    // policy's publishability is now.
    const now = nowSeconds(ctx);
    const view = async (plan: WireTxPlan | null) => ({ publication: await publicationView(ctx.db, publication, now), planExpired: plan === null && publication.market === null && now >= publication.planExpiresAt, plan });
    if ((FINAL_STATES as readonly string[]).includes(publication.state) || publication.state === "mined") return view(null);
    const indexed = await ctx.readModel.listClaims({ creator: publication.creator, claimDocumentSha256: documentSha256, order: "created_desc", limit: 10 });
    const indexedMarket = indexed.items.find((claim) => claim.registry === state.manifest.pine.claimRegistry)?.market ?? null;
    let onChain: Address | null;
    try {
      onChain = await marketOnChain(ctx, state.manifest, publication.creator, documentSha256);
    } catch {
      throw new ApiError("UPSTREAM_UNAVAILABLE", "Could not check the chain for an existing claim; try again");
    }
    const market = indexedMarket ?? onChain;
    if (market) {
      const moved = await transitionPublication(ctx.db, publication.id, ["planned", "submitted"], "mined", ctx.clock.now(), { market });
      if (moved) {
        publication = moved;
        await ctx.audit.record({ actorUserId: null, action: "claim.publication.mined", subjectType: "claim_publication", subjectId: publication.id, details: { market, via: "request" }, ip: null });
      } else {
        publication = (await findPublication(ctx.db, { userId: session.userId, id: publication.id })) ?? publication;
      }
      return view(null);
    }
    // The plan offer expired: the stored publication without a plan, before the gate (no plan would be built).
    if (now >= publication.planExpiresAt) return view(null);
    // Existing-row path: the gate and the repository recheck run after the chain re-check and before content and plan
    // (a new row passed both already).
    if (!result.created) {
      gate();
      await recheckRepository();
    }

    // Content first: no plan is ever returned for a document that is not stored.
    const stored = await ctx.contentStore.put({ bytes: preview.document, declaredMediaType: "application/json", maxBytes: CLAIM_DOCUMENT_FETCH_MAX });
    if (stored.sha256.toLowerCase() !== documentSha256) throw new ApiError("INTEGRITY_FAILED", "The stored claim document does not match its digest");
    const plan = buildPublicationPlan(state.manifest, publication.planId, publication.creator, document, documentSha256);
    return view(planToWire(plan));
  });

  app.get("/api/v1/publications/:id", { ...guard, schema: { params: idParams } }, async (request) => {
    const session = sessionOf(request);
    const publication = await findPublication(ctx.db, { userId: session.userId, id: request.params.id });
    if (!publication) throw new ApiError("NOT_FOUND", "Publication not found");
    return { publication: await publicationView(ctx.db, publication, nowSeconds(ctx)) };
  });

  app.post(
    "/api/v1/publications/:id/submitted",
    { ...guard, schema: { params: idParams, body: z.object({ txHash: txHashSchema }).strict() } },
    async (request) => {
      const session = sessionOf(request);
      let publication = await findPublication(ctx.db, { userId: session.userId, id: request.params.id });
      if (!publication) throw new ApiError("NOT_FOUND", "Publication not found");
      const txHash = request.body.txHash;
      const now = ctx.clock.now();
      const added = await one<{ tx_hash: string }>(
        ctx.db,
        sql`INSERT INTO claim_publication_txs (publication_id, tx_hash, status, reported_at)
            SELECT ${publication.id}::uuid, ${txHash}, 'unknown', ${ts(now)}
            WHERE (SELECT count(*)::int FROM claim_publication_txs WHERE publication_id = ${publication.id}::uuid) < ${MAX_TX_HINTS}
            ON CONFLICT (publication_id, tx_hash) DO NOTHING
            RETURNING tx_hash`,
      );
      if (!added) {
        const known = await one<{ tx_hash: string }>(ctx.db, sql`SELECT tx_hash FROM claim_publication_txs WHERE publication_id = ${publication.id}::uuid AND tx_hash = ${txHash}`);
        if (!known) throw new ApiError("UNPROCESSABLE", `At most ${MAX_TX_HINTS} transaction hashes can be reported`);
      } else {
        await ctx.audit.record({ actorUserId: session.userId, action: "claim.publication.tx_reported", subjectType: "claim_publication", subjectId: publication.id, details: { txHash }, ip: auditIp(request) });
      }
      const moved = await transitionPublication(ctx.db, publication.id, ["planned"], "submitted", now);
      if (moved) {
        publication = moved;
        await ctx.audit.record({ actorUserId: session.userId, action: "claim.publication.submitted", subjectType: "claim_publication", subjectId: publication.id, details: { txHash }, ip: auditIp(request) });
      } else {
        publication = (await findPublication(ctx.db, { userId: session.userId, id: publication.id })) ?? publication;
      }
      return { publication: await publicationView(ctx.db, publication, nowSeconds(ctx)) };
    },
  );
}
