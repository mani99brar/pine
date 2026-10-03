// Read side shared by public listings and agent feeds (PRD-03 §7a/§8): keyset pages over claims_index (verified only),
// moderation applied per page at read time, chain facts from the read model (fan-out bounded by the page size).

import { z } from "zod";
import { rawCidFromSha256 } from "@pine/shared/canonical";
import { deriveOracleStatus, type ClaimRecord, type OracleStatus } from "@pine/shared/read-model";
import type { Address, Hex32 } from "@pine/shared/types";
import type { AppContext, ModerationState } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { isoSeconds } from "./common.js";
import { rows, sql, toNumber, type SQL } from "./db.js";
import type { IntegrityStatus } from "./integrity.js";

export const LISTING_PHASES = ["evidence_open", "reveal_open", "closed"] as const;
export type ListingPhase = (typeof LISTING_PHASES)[number];
export type ClaimPhase = "evidence_open" | "reveal_open" | "oracle_open" | "pending_arbitration" | "finalized" | "resolved";

export const addressParam = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed address").transform((value) => value.toLowerCase() as Address);

/** GET /api/v1/claims page size cap (PRD-03 §8c): each item fans out to several read-model calls, as in the agent feed. */
export const LISTING_MAX_LIMIT = 25;

export const listingQuerySchema = z
  .object({
    phase: z.enum(LISTING_PHASES).optional(),
    repositoryId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    creator: addressParam.optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(LISTING_MAX_LIMIT).default(20),
  })
  .strict();

export interface IndexRow {
  market: Address;
  creator: Address;
  claimDocumentSha256: Hex32;
  policyDocumentSha256: Hex32;
  policyId: string | null;
  /** Decimal string: uint64 on-chain, possibly above 2^53. */
  repositoryId: string;
  evidenceDeadline: number;
  revealDeadline: number;
  createdBlock: bigint;
  createdLogIndex: number;
  integrityStatus: IntegrityStatus;
  mismatchFields: string[];
  final: boolean;
  /** Policy parameters valid for the policy version (decided once at verification); null when not computed yet. */
  parametersValid: boolean | null;
}

interface RawIndexRow {
  market: string;
  creator: string;
  claim_document_sha256: string;
  policy_document_sha256: string;
  policy_id: string | null;
  repository_id: unknown;
  evidence_deadline: unknown;
  reveal_deadline: unknown;
  created_block: unknown;
  created_log_index: unknown;
  integrity_status: string;
  mismatch_fields: unknown;
  final: unknown;
  parameters_valid: unknown;
}

const indexColumns = sql`market, creator, claim_document_sha256, policy_document_sha256, policy_id, repository_id::text AS repository_id,
  evidence_deadline::text AS evidence_deadline, reveal_deadline::text AS reveal_deadline, created_block::text AS created_block,
  created_log_index::int AS created_log_index, integrity_status, mismatch_fields, final, parameters_valid`;

function toIndexRow(row: RawIndexRow): IndexRow {
  return {
    market: row.market as Address,
    creator: row.creator as Address,
    claimDocumentSha256: row.claim_document_sha256 as Hex32,
    policyDocumentSha256: row.policy_document_sha256 as Hex32,
    policyId: row.policy_id,
    repositoryId: String(row.repository_id),
    evidenceDeadline: toNumber(row.evidence_deadline),
    revealDeadline: toNumber(row.reveal_deadline),
    createdBlock: BigInt(String(row.created_block)),
    createdLogIndex: toNumber(row.created_log_index),
    integrityStatus: row.integrity_status as IntegrityStatus,
    mismatchFields: Array.isArray(row.mismatch_fields) ? row.mismatch_fields.map(String) : [],
    final: row.final === true,
    parametersValid: typeof row.parameters_valid === "boolean" ? row.parameters_valid : null,
  };
}

const DIGEST = /^0x[0-9a-f]{64}$/;

/**
 * The publishable policy digests as ONE text[] parameter (a JS array in drizzle's sql tag would expand to a row
 * constructor). The digests come from the verified catalog and are re-checked here, so the literal holds hex only.
 * An empty set (production before any policy is approved) is `{}` and matches nothing.
 */
export function digestArray(digests: readonly string[]): SQL {
  for (const digest of digests) if (!DIGEST.test(digest)) throw new Error("publishable policy digest is malformed");
  return sql`${`{${digests.join(",")}}`}::text[]`;
}

/**
 * Listing eligibility (PRD-03 §8a), computed at query time and never stored: verified, valid policy parameters, and a
 * policy that is publishable under the current catalog and configuration (never SC-001).
 */
export function isListable(row: IndexRow | null, publishable: readonly string[]): boolean {
  return row !== null && row.integrityStatus === "verified" && row.parametersValid === true && publishable.includes(row.policyDocumentSha256);
}

export async function findIndexRow(ctx: AppContext, market: Address): Promise<IndexRow | null> {
  const [row] = await rows<RawIndexRow>(ctx.db, sql`SELECT ${indexColumns} FROM claims_index WHERE market = ${market}`);
  return row ? toIndexRow(row) : null;
}

function encodeCursor(row: IndexRow): string {
  return Buffer.from(JSON.stringify({ v: 1, b: row.createdBlock.toString(), l: row.createdLogIndex }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { block: string; logIndex: number } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; b?: unknown; l?: unknown };
    if (parsed.v !== 1 || typeof parsed.b !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/.test(parsed.b)) throw new Error("cursor");
    if (typeof parsed.l !== "number" || !Number.isInteger(parsed.l) || parsed.l < 0 || parsed.l > 2 ** 31 - 1) throw new Error("cursor");
    return { block: parsed.b, logIndex: parsed.l };
  } catch {
    throw new ApiError("BAD_REQUEST", "Invalid cursor");
  }
}

export interface ListingQuery {
  phase?: ListingPhase | undefined;
  repositoryId?: number | undefined;
  creator?: Address | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface ListedItem {
  row: IndexRow;
}

/**
 * One keyset page of listable claims (newest first). Moderation is applied to the page at read time: claims with a
 * claim or content moderation state are dropped, so a page may hold fewer than `limit` items (even none). The cursor
 * continues after the last SCANNED row; nextCursor is null only when SQL returned fewer than `limit` rows.
 */
export async function listListable(
  ctx: AppContext,
  query: ListingQuery,
  now: number,
  publishable: readonly string[],
): Promise<{ items: ListedItem[]; nextCursor: string | null }> {
  const conditions: SQL[] = [sql`integrity_status = 'verified'`, sql`parameters_valid`, sql`policy_document_sha256 = ANY(${digestArray(publishable)})`];
  if (query.phase === "evidence_open") conditions.push(sql`evidence_deadline > ${String(now)}::bigint`);
  if (query.phase === "reveal_open") conditions.push(sql`evidence_deadline <= ${String(now)}::bigint AND reveal_deadline > ${String(now)}::bigint`);
  if (query.phase === "closed") conditions.push(sql`reveal_deadline <= ${String(now)}::bigint`);
  if (query.repositoryId !== undefined) conditions.push(sql`repository_id = ${String(query.repositoryId)}::numeric`);
  if (query.creator !== undefined) conditions.push(sql`creator = ${query.creator}`);
  if (query.cursor !== undefined) {
    const after = decodeCursor(query.cursor);
    conditions.push(sql`(created_block, created_log_index) < (${after.block}::bigint, ${after.logIndex}::int)`);
  }
  const scanned = (
    await rows<RawIndexRow>(
      ctx.db,
      sql`SELECT ${indexColumns} FROM claims_index WHERE ${sql.join(conditions, sql` AND `)} ORDER BY created_block DESC, created_log_index DESC LIMIT ${query.limit}`,
    )
  ).map(toIndexRow);
  const last = scanned[scanned.length - 1];
  const nextCursor = scanned.length === query.limit && last !== undefined ? encodeCursor(last) : null;
  const claimStates = await ctx.moderation.states("claim", scanned.map((row) => row.market));
  const contentStates = await ctx.moderation.states("content", scanned.map((row) => row.claimDocumentSha256));
  return {
    items: scanned.filter((row) => lookup(claimStates, row.market) === null && lookup(contentStates, row.claimDocumentSha256) === null).map((row) => ({ row })),
    nextCursor,
  };
}

function lookup(states: Map<string, ModerationState>, id: string): ModerationState | null {
  const wanted = id.toLowerCase();
  for (const [key, state] of states) if (key.toLowerCase() === wanted) return state;
  return null;
}

export interface Moderation {
  claim: ModerationState | null;
  content: ModerationState | null;
  /** hide or block on the claim or its document: never in lists or feeds. */
  hidden: boolean;
  /** block on the claim or its document: metadata only, no user text, no document body and no user-content URL. */
  blocked: boolean;
}

/**
 * Claim moderation (market) and content moderation (document digest), read on every request. The module checks the
 * content state itself rather than relying on the content store to withhold blocked bytes.
 */
export async function moderationOf(ctx: AppContext, market: Address, documentSha256: Hex32): Promise<Moderation> {
  const claim = lookup(await ctx.moderation.states("claim", [market]), market);
  const content = lookup(await ctx.moderation.states("content", [documentSha256]), documentSha256);
  return { claim, content, hidden: claim !== null || content !== null, blocked: claim?.action === "block" || content?.action === "block" };
}

export function moderationJson(state: ModerationState | null): { action: string; reason: string; at: string } | null {
  return state ? { action: state.action, reason: state.reason, at: state.at.toISOString() } : null;
}

/** Oracle status of the claim's question, following reopened replacements (bounded). */
export async function oracleOf(ctx: AppContext, claim: ClaimRecord, now: number): Promise<{ questionId: Hex32; status: OracleStatus } | null> {
  let questionId = claim.questionId;
  let question = await ctx.readModel.getOracleQuestion(questionId);
  for (let hop = 0; hop < 5 && question?.reopenedBy; hop += 1) {
    const next = await ctx.readModel.getOracleQuestion(question.reopenedBy);
    if (!next) break;
    questionId = next.questionId;
    question = next;
  }
  if (!question) return null;
  return { questionId, status: deriveOracleStatus(question, now) };
}

export function phaseOf(claim: Pick<ClaimRecord, "evidenceDeadline" | "revealDeadline">, oracle: OracleStatus | null, resolved: boolean, now: number): ClaimPhase {
  if (now < claim.evidenceDeadline) return "evidence_open";
  if (now < claim.revealDeadline) return "reveal_open";
  if (resolved) return "resolved";
  if (oracle?.state === "finalized") return "finalized";
  if (oracle?.state === "pending_arbitration") return "pending_arbitration";
  return "oracle_open";
}

export function oracleJson(status: OracleStatus | null): Record<string, unknown> | null {
  if (!status) return null;
  switch (status.state) {
    case "answered":
      return { ...status, bond: status.bond.toString() };
    default:
      return { ...status };
  }
}

/**
 * Platform facts of a claim (chain data and digests; no user text). `withUrl` is false for blocked claims or documents:
 * their user-content URL is never exposed.
 */
export async function platformFacts(ctx: AppContext, claim: ClaimRecord, now: number, withUrl: boolean) {
  const oracle = await oracleOf(ctx, claim, now);
  const resolution = await ctx.readModel.getConditionResolution(claim.conditionId);
  const phase = phaseOf(claim, oracle?.status ?? null, resolution !== null, now);
  return {
    market: claim.market,
    registry: claim.registry,
    creator: claim.creator,
    repositoryId: claim.repositoryId,
    commit: claim.commit,
    claimDocument: { sha256: claim.claimDocumentSha256, cid: rawCidFromSha256(claim.claimDocumentSha256), url: withUrl ? `${ctx.config.userContentOrigin}/c/${claim.claimDocumentSha256}` : null },
    policyDocument: { sha256: claim.policyDocumentSha256, cid: rawCidFromSha256(claim.policyDocumentSha256) },
    deadlines: {
      evidence: { unix: claim.evidenceDeadline, iso: isoSeconds(claim.evidenceDeadline), operator: "commit/publish while block.timestamp < evidenceDeadline" },
      reveal: { unix: claim.revealDeadline, iso: isoSeconds(claim.revealDeadline), operator: "reveal while block.timestamp < revealDeadline" },
      answers: { unix: claim.revealDeadline, iso: isoSeconds(claim.revealDeadline), operator: "answers accepted once block.timestamp >= revealDeadline" },
    },
    minBondWei: claim.minBond.toString(),
    questionId: claim.questionId,
    currentQuestionId: oracle?.questionId ?? claim.questionId,
    conditionId: claim.conditionId,
    outcomeTokens: { yes: claim.yesToken, no: claim.noToken, invalid: claim.invalidToken },
    created: { at: claim.createdAt, iso: isoSeconds(claim.createdAt), block: claim.createdBlock.toString(), txHash: claim.createdTxHash, logIndex: claim.createdLogIndex },
    phase,
    oracle: oracleJson(oracle?.status ?? null),
    resolution: resolution ? { payoutNumerators: resolution.payoutNumerators.map((value) => value.toString()), resolvedAt: resolution.resolvedAt, txHash: resolution.txHash } : null,
  };
}

export function integrityJson(row: IndexRow | null): { status: IntegrityStatus; mismatchFields: string[]; final: boolean } {
  if (!row) return { status: "pending", mismatchFields: [], final: false };
  return { status: row.integrityStatus, mismatchFields: row.mismatchFields, final: row.final };
}
