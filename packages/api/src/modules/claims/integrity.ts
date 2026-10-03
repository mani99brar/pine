// Job claims.verify-integrity (PRD-03 §7/§7a, SEC-CLAIM-03..08, SEC-IDX-08). Two phases so a partial run never loses claims:
//   1. discovery walks created_desc from the head to the first indexed claim, then inserts everything it collected as
//      `pending` in ONE transaction (an error inserts nothing);
//   2. verification takes up to 50 due never-attempted rows (oldest first) and up to 50 due retries (by next_attempt_at),
//      so retries can never crowd out new claims; each row in its own try/catch and its own compare-and-set write.
// Only `verified` claims are listed. Transient failures are not results: the row stays as it is with backoff. A verdict is
// final, so it is reached only for a claim created in a final block (PRD-07 §3g, finality.ts): `isFinal(claim.createdBlock)`
// with one bound F per run; otherwise the claim stays pending with backoff.

import { keccak256, toBytes as utf8Bytes } from "viem";
import { ClaimDocumentError, parseClaimDocumentBytes, type ClaimDocument } from "@pine/shared/claim-document";
import { renderQuestion } from "@pine/shared/question";
import type { ClaimRecord } from "@pine/shared/read-model";
import type { Hex32 } from "@pine/shared/types";
import type { AppContext, AuditEntry, JobDefinition } from "../../contracts/app.js";
import { safeErrorMessage } from "../../contracts/redact.js";
import { flushAudit, outboxInsert } from "./audit.js";
import { CLAIM_DOCUMENT_FETCH_MAX, DAY } from "./common.js";
import { fromMs, msOf, rows, sql, toNumber, ts, type Executor, type SQL } from "./db.js";
import { finalityOf, type Finality } from "./finality.js";
import { claimCreatedMarkets, fetchReceipt, hasMatchingNewMarket } from "./receipts.js";
import type { ClaimsState } from "./state.js";

export const INTEGRITY_STATUSES = ["pending", "verified", "mismatch", "document_unavailable"] as const;
export type IntegrityStatus = (typeof INTEGRITY_STATUSES)[number];
export const DISCOVERY_PAGE = 100;
export const VERIFY_BATCH = 50;
export const BACKOFF_CAP_SECONDS = 3_600;
export const UNAVAILABLE_RETRY_WINDOW_SECONDS = 7 * DAY;

/** Exponential backoff from one minute, capped at one hour. */
export const backoffSeconds = (attempts: number): number => Math.min(60 * 2 ** Math.min(Math.max(attempts - 1, 0), 10), BACKOFF_CAP_SECONDS);

class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

/** The document is blocked by moderation: transient, and time withheld never counts toward the unavailable window. */
class WithheldError extends TransientError {
  constructor() {
    super("claim document withheld by moderation");
    this.name = "WithheldError";
  }
}

export interface IntegrityVerdict {
  status: "verified" | "mismatch" | "document_unavailable";
  fields: string[];
  policyId: string | null;
  /** The document's policy parameters against the per-version schema (PRD-03 §8a); null without a parsed document. */
  parametersValid: boolean | null;
}

/** Throws a transient error while the content subject `digest` is blocked by moderation (or moderation is unreachable). */
async function assertNotWithheld(ctx: AppContext, digest: Hex32): Promise<void> {
  let states;
  try {
    states = await ctx.moderation.states("content", [digest]);
  } catch (error) {
    throw new TransientError(`moderation: ${error instanceof Error ? error.name : "error"}`);
  }
  if ([...states.values()].some((item) => item.action === "block")) throw new WithheldError();
}

/** Compares one on-chain claim with its document, the catalog and the deployment manifest. Throws on transient failures. */
export async function evaluateClaim(ctx: AppContext, state: ClaimsState, claim: ClaimRecord): Promise<IntegrityVerdict> {
  const { manifest, catalog } = state;
  const fields = new Set<string>();

  // Creation receipt: it must prove the read model's registry, creator and digest for this market (its ClaimCreated
  // event; the read model is not trusted alone), and carry Seer's NewMarket for the same market from the configured
  // factory (SEC-IDX-08). A missing receipt or an RPC failure is transient, never a verdict.
  const receipt = await fetchReceipt(ctx, claim.createdTxHash);
  if (!receipt) throw new TransientError("creation receipt unavailable");
  if (!claimCreatedMarkets(receipt, claim.registry, claim.creator, claim.claimDocumentSha256).includes(claim.market.toLowerCase() as ClaimRecord["market"])) {
    fields.add("creation");
  }
  if (!hasMatchingNewMarket(receipt, manifest.seer.marketFactory, { market: claim.market, conditionId: claim.conditionId, questionId: claim.questionId, marketName: claim.marketName })) {
    fields.add("newMarket");
  }
  if (claim.registry !== manifest.pine.claimRegistry) fields.add("claimRegistry");

  // The on-chain question must be exactly what the frozen renderer produces for the on-chain fields.
  try {
    const expected = renderQuestion({
      evidenceRegistry: manifest.pine.evidenceRegistry,
      title: claim.title,
      evidenceDeadline: claim.evidenceDeadline,
      revealDeadline: claim.revealDeadline,
      repositoryId: claim.repositoryId,
      commit: claim.commit,
      claimDocumentSha256: claim.claimDocumentSha256,
      policyDocumentSha256: claim.policyDocumentSha256,
    });
    if (expected !== claim.marketName || keccak256(utf8Bytes(claim.marketName)) !== claim.marketNameHash) fields.add("question");
  } catch {
    // Inputs the frozen renderer refuses (e.g. a repository id above 2^53 - 1 from a direct contract call).
    fields.add("question");
  }

  // A document withheld by moderation is not "unavailable" (the store returns null for blocked content): the claim
  // stays pending with backoff and is re-evaluated once the block is lifted (PRD-03 §8c).
  await assertNotWithheld(ctx, claim.claimDocumentSha256);
  let bytes: Uint8Array | null;
  try {
    bytes = await ctx.contentStore.retrieve(claim.claimDocumentSha256, CLAIM_DOCUMENT_FETCH_MAX);
  } catch (error) {
    throw new TransientError(`content store: ${error instanceof Error ? error.name : "error"}`);
  }
  if (bytes === null) {
    // Without the document the claim cannot be canonical; on-chain mismatches found so far are final regardless.
    if (fields.size > 0) return { status: "mismatch", fields: [...fields].sort(), policyId: null, parametersValid: null };
    return { status: "document_unavailable", fields: [], policyId: null, parametersValid: null };
  }

  let document: ClaimDocument;
  try {
    document = parseClaimDocumentBytes(bytes, claim.claimDocumentSha256);
  } catch (error) {
    if (!(error instanceof ClaimDocumentError)) throw error;
    fields.add("document");
    return { status: "mismatch", fields: [...fields].sort(), policyId: null, parametersValid: null };
  }

  const check = (name: string, ok: boolean) => {
    if (!ok) fields.add(name);
  };
  check("creator", document.creator === claim.creator);
  check("repositoryId", document.target.repository.id === claim.repositoryId);
  check("commit", document.target.commit === claim.commit);
  // The on-chain policy digest must be a catalog file (any status) whose entry carries the document's id and version.
  const policyEntries = catalog.bySha256(claim.policyDocumentSha256);
  check(
    "policy",
    document.policy.sha256 === claim.policyDocumentSha256 && policyEntries.some((entry) => entry.id === document.policy.id && entry.version === document.policy.version),
  );
  check("evidenceDeadline", document.evidence.evidenceDeadline === claim.evidenceDeadline);
  check("revealDeadline", document.evidence.revealDeadline === claim.revealDeadline && document.market.openingTime === claim.revealDeadline);
  check("minBond", BigInt(document.market.minBondWei) === claim.minBond);
  check("evidenceRegistry", document.evidence.registry === manifest.pine.evidenceRegistry);
  check("claimRegistry", document.market.claimRegistry === manifest.pine.claimRegistry);
  check("title", document.claim.title === claim.title);
  check("chainId", document.market.chainId === manifest.chainId && document.evidence.chainId === manifest.chainId);
  check("seerMarketFactory", document.market.seerMarketFactory === manifest.seer.marketFactory);
  check("collateralToken", document.market.collateralToken === manifest.seer.collateralToken);
  check("realitio", document.market.realitio === manifest.seer.realitio);
  check("arbitrator", document.market.arbitrator === manifest.seer.arbitrator);
  check("questionTimeoutSeconds", document.market.questionTimeoutSeconds === manifest.seer.questionTimeoutSeconds);

  return {
    status: fields.size === 0 ? "verified" : "mismatch",
    fields: [...fields].sort(),
    policyId: document.policy.id,
    parametersValid: catalog.parametersValid(document.policy.id, document.policy.version, document.claim.policyParameters),
  };
}

/** The stored document's parameters against the per-version schema, for verified rows indexed before the column existed. */
async function parametersValidOf(ctx: AppContext, state: ClaimsState, digest: Hex32): Promise<boolean> {
  let bytes: Uint8Array | null;
  try {
    bytes = await ctx.contentStore.retrieve(digest, CLAIM_DOCUMENT_FETCH_MAX);
  } catch (error) {
    throw new TransientError(`content store: ${error instanceof Error ? error.name : "error"}`);
  }
  if (bytes === null) throw new TransientError("claim document unavailable");
  let document: ClaimDocument;
  try {
    document = parseClaimDocumentBytes(bytes, digest);
  } catch (error) {
    if (error instanceof ClaimDocumentError) return false;
    throw error;
  }
  return state.catalog.parametersValid(document.policy.id, document.policy.version, document.claim.policyParameters);
}

// ------------------------------------------------------------------------------------------------ discovery

/** Decimal text of a uint64 the read model carries as a JS number (never throws: discovery must not stall on one claim). */
const uintText = (value: number): string => (Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? BigInt(value).toString() : "0");

async function indexedAmong(db: Executor, markets: string[]): Promise<Set<string>> {
  if (markets.length === 0) return new Set();
  const found = await rows<{ market: string }>(db, sql`SELECT market FROM claims_index WHERE market IN (SELECT jsonb_array_elements_text(${JSON.stringify(markets)}::jsonb))`);
  return new Set(found.map((row) => row.market));
}

/** Phase 1. Returns the number of newly inserted claims. Throws (inserting nothing) on any error during the walk. */
export async function discoverClaims(ctx: AppContext, signal?: AbortSignal): Promise<number> {
  const collected: ClaimRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    if (signal?.aborted) throw new Error("aborted");
    const page = await ctx.readModel.listClaims(cursor === undefined ? { order: "created_desc", limit: DISCOVERY_PAGE } : { order: "created_desc", limit: DISCOVERY_PAGE, cursor });
    const known = await indexedAmong(ctx.db, page.items.map((claim) => claim.market));
    let reachedIndexed = false;
    for (const claim of page.items) {
      if (known.has(claim.market)) {
        reachedIndexed = true;
        break;
      }
      collected.push(claim);
    }
    if (reachedIndexed || page.nextCursor === null || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  if (collected.length === 0) return 0;
  const now = ctx.clock.now();
  let inserted = 0;
  await ctx.db.transaction(async (tx) => {
    for (let offset = 0; offset < collected.length; offset += 500) {
      const chunk = collected.slice(offset, offset + 500).map((claim) => ({
        market: claim.market,
        registry: claim.registry,
        creator: claim.creator,
        claim_document_sha256: claim.claimDocumentSha256,
        policy_document_sha256: claim.policyDocumentSha256,
        repository_id: uintText(claim.repositoryId),
        evidence_deadline: String(claim.evidenceDeadline),
        reveal_deadline: String(claim.revealDeadline),
        created_block: claim.createdBlock.toString(),
        created_log_index: claim.createdLogIndex,
      }));
      const result = await rows<{ market: string }>(
        tx,
        sql`INSERT INTO claims_index (market, registry, creator, claim_document_sha256, policy_document_sha256, repository_id, evidence_deadline,
              reveal_deadline, created_block, created_log_index, integrity_status, next_attempt_at, discovered_at)
            SELECT x.market, x.registry, x.creator, x.claim_document_sha256, x.policy_document_sha256, x.repository_id::numeric,
              x.evidence_deadline::bigint, x.reveal_deadline::bigint, x.created_block::bigint, x.created_log_index, 'pending', ${ts(now)}, ${ts(now)}
            FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS x(market text, registry text, creator text, claim_document_sha256 text,
              policy_document_sha256 text, repository_id text, evidence_deadline text, reveal_deadline text, created_block text, created_log_index int)
            ON CONFLICT (market) DO NOTHING
            RETURNING market`,
      );
      inserted += result.length;
    }
  });
  return inserted;
}

// ------------------------------------------------------------------------------------------------ verification

interface WorkRow {
  market: string;
  integrity_status: string;
  attempts: unknown;
  version: unknown;
  first_unavailable_ms: unknown;
}

/**
 * Compare-and-set write of one row in its own transaction; success only from RETURNING rows. An `audit` entry goes to the
 * outbox as the second statement of the same transaction, only when the write happened.
 */
async function writeResult(ctx: AppContext, row: Pick<WorkRow, "market" | "version">, update: SQL, guard: SQL = sql`NOT final`, audit?: AuditEntry): Promise<boolean> {
  const version = toNumber(row.version);
  return ctx.db.transaction(async (tx) => {
    const updated = await rows<{ market: string }>(tx, sql`UPDATE claims_index SET ${update}, version = version + 1 WHERE market = ${row.market} AND version = ${version} AND ${guard} RETURNING market`);
    if (updated.length !== 1) return false;
    if (audit) await outboxInsert(tx, audit, ctx.clock.now());
    return true;
  });
}

/**
 * Phase 2. Verifies due rows independently; one claim's failure never aborts the others. Up to VERIFY_BATCH never-attempted
 * rows (oldest first) and, separately, up to VERIFY_BATCH retries (soonest due first), so retries of unavailable
 * documents can never crowd out new claims.
 */
export async function verifyPendingClaims(ctx: AppContext, state: ClaimsState, signal?: AbortSignal): Promise<Record<string, number>> {
  const counts: Record<string, number> = { verified: 0, mismatch: 0, document_unavailable: 0, transient: 0, skipped: 0 };
  const now = ctx.clock.now();
  const work = (attempted: boolean, order: SQL) =>
    rows<WorkRow>(
      ctx.db,
      sql`SELECT market, integrity_status, attempts::int AS attempts, version::int AS version,
            CASE WHEN first_unavailable_at IS NULL THEN NULL ELSE ${msOf(sql`first_unavailable_at`)} END AS first_unavailable_ms
          FROM claims_index
          WHERE NOT final AND integrity_status IN ('pending', 'document_unavailable') AND next_attempt_at <= ${ts(now)}
            AND ${attempted ? sql`attempts > 0` : sql`attempts = 0`}
          ORDER BY ${order}
          LIMIT ${VERIFY_BATCH}`,
    );
  const due = [
    ...(await work(false, sql`created_block ASC, created_log_index ASC`)),
    ...(await work(true, sql`next_attempt_at ASC, created_block ASC, created_log_index ASC`)),
  ];
  // One finality bound F for the whole run (PRD-07 §3f, §3g), computed when the first due claim needs it.
  let finality: Promise<Finality> | null = null;
  const finalityOfRun = () => (finality ??= ctx.readModel.status().then((status) => finalityOf(ctx, status)));
  for (const row of due) {
    if (signal?.aborted) break;
    const attempts = toNumber(row.attempts) + 1;
    const checkedAt = ctx.clock.now();
    const retryAt = new Date(checkedAt.getTime() + backoffSeconds(attempts) * 1000);
    try {
      const claim = await ctx.readModel.getClaim(row.market as ClaimRecord["market"]);
      if (!claim) throw new TransientError("claim not in the read model");
      // No verdict (verified, mismatch or unavailable) for a claim a reorg could still remove or change: pending with backoff.
      if (!(await finalityOfRun()).isFinal(claim.createdBlock)) throw new TransientError("claim creation not final");
      const verdict = await evaluateClaim(ctx, state, claim);
      let update;
      if (verdict.status === "document_unavailable") {
        const firstUnavailable = row.first_unavailable_ms === null ? checkedAt : fromMs(row.first_unavailable_ms);
        const giveUp = checkedAt.getTime() - firstUnavailable.getTime() >= UNAVAILABLE_RETRY_WINDOW_SECONDS * 1000;
        update = sql`integrity_status = 'document_unavailable', mismatch_fields = '[]'::jsonb, parameters_valid = NULL, attempts = ${attempts}, final = ${giveUp},
          first_unavailable_at = ${ts(firstUnavailable)}, next_attempt_at = ${giveUp ? null : retryAt.toISOString()}::timestamptz,
          checked_at = ${ts(checkedAt)}, last_error = NULL`;
      } else {
        update = sql`integrity_status = ${verdict.status}, mismatch_fields = ${JSON.stringify(verdict.fields)}::jsonb, policy_id = ${verdict.policyId},
          parameters_valid = ${verdict.parametersValid}::boolean,
          attempts = ${attempts}, final = true, next_attempt_at = NULL, checked_at = ${ts(checkedAt)}, last_error = NULL`;
      }
      const audit: AuditEntry | undefined =
        verdict.status === "document_unavailable"
          ? undefined
          : { actorUserId: null, action: `claim.integrity.${verdict.status}`, subjectType: "claim", subjectId: row.market, details: { fields: verdict.fields }, ip: null };
      if (await writeResult(ctx, row, update, sql`NOT final`, audit)) {
        counts[verdict.status] = (counts[verdict.status] ?? 0) + 1;
        if (audit) await flushAudit(ctx, signal);
      } else {
        counts.skipped = (counts.skipped ?? 0) + 1;
      }
    } catch (error) {
      counts.transient = (counts.transient ?? 0) + 1;
      // Withheld by moderation (PRD-03 §8d): not unavailable, and the 7-day window restarts once the block is lifted.
      const withheld = error instanceof WithheldError ? sql`, integrity_status = 'pending', first_unavailable_at = NULL` : sql``;
      try {
        await writeResult(ctx, row, sql`attempts = ${attempts}, next_attempt_at = ${ts(retryAt)}, checked_at = ${ts(checkedAt)}, last_error = ${safeErrorMessage(error, ctx.redact).slice(0, 300)}${withheld}`);
      } catch {
        // The next run retries the row; nothing else depends on this write.
      }
    }
  }
  await backfillParameters(ctx, state, counts, signal);
  for (const [outcome, count] of Object.entries(counts)) if (count > 0) ctx.metrics.increment("claims_integrity", { outcome });
  return counts;
}

/**
 * Verified rows with parameters_valid NULL (indexed before migration 0002) get it computed, at most VERIFY_BATCH per
 * run, oldest first, with the same backoff on transient failures. NULL is never listable, so the backlog fails closed.
 */
async function backfillParameters(ctx: AppContext, state: ClaimsState, counts: Record<string, number>, signal?: AbortSignal): Promise<void> {
  const now = ctx.clock.now();
  const backlog = await rows<WorkRow>(
    ctx.db,
    sql`SELECT market, integrity_status, attempts::int AS attempts, version::int AS version, NULL AS first_unavailable_ms
        FROM claims_index
        WHERE integrity_status = 'verified' AND parameters_valid IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ${ts(now)})
        ORDER BY created_block ASC, created_log_index ASC
        LIMIT ${VERIFY_BATCH}`,
  );
  const guard = sql`integrity_status = 'verified' AND parameters_valid IS NULL`;
  for (const row of backlog) {
    if (signal?.aborted) break;
    const attempts = toNumber(row.attempts) + 1;
    const checkedAt = ctx.clock.now();
    try {
      const claim = await ctx.readModel.getClaim(row.market as ClaimRecord["market"]);
      if (!claim) throw new TransientError("claim not in the read model");
      const valid = await parametersValidOf(ctx, state, claim.claimDocumentSha256);
      if (await writeResult(ctx, row, sql`parameters_valid = ${valid}::boolean, next_attempt_at = NULL`, guard)) counts.parameters = (counts.parameters ?? 0) + 1;
    } catch (error) {
      counts.transient = (counts.transient ?? 0) + 1;
      const retryAt = new Date(checkedAt.getTime() + backoffSeconds(attempts) * 1000);
      try {
        await writeResult(ctx, row, sql`attempts = ${attempts}, next_attempt_at = ${ts(retryAt)}, last_error = ${safeErrorMessage(error, ctx.redact).slice(0, 300)}`, guard);
      } catch {
        // The next run retries the row.
      }
    }
  }
}

export async function runIntegrity(ctx: AppContext, state: ClaimsState, signal?: AbortSignal): Promise<{ discovered: number; verification: Record<string, number> }> {
  // Entries an audit outage left in the outbox, before anything else.
  await flushAudit(ctx, signal);
  let discoveryError: unknown = null;
  let discovered = 0;
  try {
    discovered = await discoverClaims(ctx, signal);
  } catch (error) {
    discoveryError = error;
  }
  const verification = await verifyPendingClaims(ctx, state, signal);
  if (discoveryError !== null) throw discoveryError;
  return { discovered, verification };
}

export function integrityJob(stateFor: (ctx: AppContext) => ClaimsState): JobDefinition {
  return {
    name: "claims.verify-integrity",
    intervalMs: 60_000,
    async run(ctx, signal) {
      await runIntegrity(ctx, stateFor(ctx), signal);
    },
  };
}
