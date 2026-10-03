// createNativeReadModel (PRD-05 section 2.1): every ReadModel method as SQL over pine_index. Keyset pagination with opaque
// cursors scoped to this implementation, InvalidCursorError for anything else, limit 1..100. Strings are compared with
// COLLATE "C" so ordering equals the reference's JavaScript string comparison of lowercase hex.

import { z } from "zod";
import type { KlerosHomeStage } from "@pine/shared/chain-events";
import {
  InvalidCursorError,
  type ArbitrationRecord,
  type ClaimRecord,
  type ConditionResolutionRecord,
  type EvidenceRecord,
  type EvidenceStatus,
  type IndexerStatus,
  type ListClaimsQuery,
  type ListEvidenceQuery,
  type OracleAnswerRecord,
  type OracleQuestionRecord,
  type Page,
  type ReadModel,
} from "@pine/shared/read-model";
import type { Address, Hex32 } from "@pine/shared/types";
import type { SqlExecutor } from "./db.js";
import { isHalted, readCursor } from "./store.js";

export interface NativeReadModelOptions {
  chainId: number;
}

const lower = <T extends string>(value: T): T => value.toLowerCase() as T;

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be an integer in 1..100");
}

// ------------------------------------------------------------------------------------------------------------- cursors

type CursorScope = "claims:created_desc" | "claims:evidence_deadline_asc" | "evidence";

const INT8_MAX = 9_223_372_036_854_775_807n;
const INT4_MAX = 2_147_483_647;
// Key parts are bounded to the column domains (int8 blocks/deadlines, int4 log indexes), so a crafted cursor is an
// InvalidCursorError and never reaches the database as an out-of-range cast.
const int8Part = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,18})$/)
  .refine((value) => BigInt(value) <= INT8_MAX);
const int4Part = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,9})$/)
  .refine((value) => Number(value) <= INT4_MAX);
const addressPart = z.string().regex(/^0x[0-9a-f]{40}$/);

const cursorSchema = z
  .object({
    v: z.literal(1),
    impl: z.literal("native"),
    scope: z.enum(["claims:created_desc", "claims:evidence_deadline_asc", "evidence"]),
    key: z.tuple([z.string(), z.string()]),
  })
  .strict();

function encodeCursor(scope: CursorScope, key: [string, string]): string {
  return Buffer.from(JSON.stringify({ v: 1, impl: "native", scope, key }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, scope: CursorScope): [string, string] {
  if (typeof cursor !== "string" || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success || result.data.scope !== scope) throw new InvalidCursorError();
  const [first, second] = result.data.key;
  const secondSchema = scope === "claims:evidence_deadline_asc" ? addressPart : int4Part;
  if (!int8Part.safeParse(first).success || !secondSchema.safeParse(second).success) throw new InvalidCursorError();
  return [first, second];
}

// ------------------------------------------------------------------------------------------------------------- rows

const CLAIM_COLUMNS = `market, registry, creator, claim_document_sha256, policy_document_sha256, repository_id::text AS repository_id, commit,
  question_id, condition_id, evidence_deadline::text AS evidence_deadline, reveal_deadline::text AS reveal_deadline, min_bond::text AS min_bond,
  title_json, market_name_json, market_name_hash, yes_token, no_token, invalid_token, created_at::text AS created_at,
  created_block::text AS created_block, created_tx_hash, created_log_index`;

interface ClaimRow {
  [column: string]: unknown;
  market: Address;
  registry: Address;
  creator: Address;
  claim_document_sha256: Hex32;
  policy_document_sha256: Hex32;
  repository_id: string;
  commit: string;
  question_id: Hex32;
  condition_id: Hex32;
  evidence_deadline: string;
  reveal_deadline: string;
  min_bond: string;
  title_json: string;
  market_name_json: string;
  market_name_hash: Hex32;
  yes_token: Address;
  no_token: Address;
  invalid_token: Address;
  created_at: string;
  created_block: string;
  created_tx_hash: Hex32;
  created_log_index: number;
}

const jsonString = (value: string): string => {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "string") throw new Error("stored string is not JSON-encoded");
  return parsed;
};

function toClaim(row: ClaimRow): ClaimRecord {
  return {
    market: row.market,
    registry: row.registry,
    creator: row.creator,
    claimDocumentSha256: row.claim_document_sha256,
    policyDocumentSha256: row.policy_document_sha256,
    repositoryId: Number(row.repository_id),
    commit: row.commit,
    questionId: row.question_id,
    conditionId: row.condition_id,
    evidenceDeadline: Number(row.evidence_deadline),
    revealDeadline: Number(row.reveal_deadline),
    minBond: BigInt(row.min_bond),
    title: jsonString(row.title_json),
    marketName: jsonString(row.market_name_json),
    marketNameHash: row.market_name_hash,
    yesToken: row.yes_token,
    noToken: row.no_token,
    invalidToken: row.invalid_token,
    createdAt: Number(row.created_at),
    createdBlock: BigInt(row.created_block),
    createdTxHash: row.created_tx_hash,
    createdLogIndex: row.created_log_index,
  };
}

const EVIDENCE_COLUMNS = `registry, submission_id::text AS submission_id, market, submitter, status, commitment, content_sha256,
  committed_at::text AS committed_at, revealed_at::text AS revealed_at, committed_tx_hash, committed_block::text AS committed_block, committed_log_index`;

interface EvidenceRow {
  [column: string]: unknown;
  registry: Address;
  submission_id: string;
  market: Address;
  submitter: Address;
  status: EvidenceStatus;
  commitment: Hex32 | null;
  content_sha256: Hex32 | null;
  committed_at: string;
  revealed_at: string | null;
  committed_tx_hash: Hex32;
  committed_block: string;
  committed_log_index: number;
}

function toEvidence(row: EvidenceRow): EvidenceRecord {
  return {
    registry: row.registry,
    submissionId: BigInt(row.submission_id),
    market: row.market,
    submitter: row.submitter,
    status: row.status,
    commitment: row.commitment,
    contentSha256: row.content_sha256,
    committedAt: Number(row.committed_at),
    revealedAt: row.revealed_at === null ? null : Number(row.revealed_at),
    committedTxHash: row.committed_tx_hash,
    committedBlock: BigInt(row.committed_block),
    committedLogIndex: row.committed_log_index,
  };
}

function page<T>(rows: T[], limit: number, cursorOf: (item: T) => string): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last !== undefined ? cursorOf(last) : null };
}

// ------------------------------------------------------------------------------------------------------------- model

export function createNativeReadModel(db: SqlExecutor, options: NativeReadModelOptions): ReadModel {
  return {
    async status(): Promise<IndexerStatus> {
      const cursor = await readCursor(db, options.chainId);
      return {
        backend: "native",
        chainId: options.chainId,
        indexedBlock: cursor?.indexedBlock ?? 0n,
        indexedBlockTimestamp: cursor?.indexedBlockTimestamp ?? 0,
        headBlock: cursor?.headBlock ?? null,
        finalizedBlock: cursor?.finalizedBlock ?? null,
        halted: await isHalted(db, options.chainId),
      };
    },

    async getClaim(market: Address): Promise<ClaimRecord | null> {
      const rows = await db.query<ClaimRow>(`SELECT ${CLAIM_COLUMNS} FROM pine_index.claims WHERE market = $1`, [lower(String(market))]);
      return rows[0] ? toClaim(rows[0]) : null;
    },

    async listClaims(query: ListClaimsQuery): Promise<Page<ClaimRecord>> {
      assertLimit(query.limit);
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: (placeholder: string) => string, value: unknown): void => {
        params.push(value);
        where.push(clause(`$${params.length}`));
      };
      if (query.creator) add((p) => `creator = ${p}`, lower(String(query.creator)));
      if (query.claimDocumentSha256) add((p) => `claim_document_sha256 = ${p}`, lower(String(query.claimDocumentSha256)));
      if (query.evidenceDeadlineAfter !== undefined) add((p) => `evidence_deadline > ${p}::numeric`, String(finiteNumber(query.evidenceDeadlineAfter)));
      if (query.evidenceDeadlineAtOrBefore !== undefined) add((p) => `evidence_deadline <= ${p}::numeric`, String(finiteNumber(query.evidenceDeadlineAtOrBefore)));
      let order: string;
      let scope: CursorScope;
      if (query.order === "created_desc") {
        scope = "claims:created_desc";
        order = "created_block DESC, created_log_index DESC";
        if (query.cursor !== undefined) {
          const [block, logIndex] = decodeCursor(query.cursor, scope);
          params.push(block, Number(logIndex));
          where.push(`(created_block, created_log_index) < ($${params.length - 1}::int8, $${params.length}::int4)`);
        }
      } else if (query.order === "evidence_deadline_asc") {
        scope = "claims:evidence_deadline_asc";
        order = `evidence_deadline ASC, market COLLATE "C" ASC`;
        if (query.cursor !== undefined) {
          const [deadline, market] = decodeCursor(query.cursor, scope);
          params.push(deadline, market);
          const d = `$${params.length - 1}::int8`;
          const m = `$${params.length}::text`;
          where.push(`(evidence_deadline > ${d} OR (evidence_deadline = ${d} AND market COLLATE "C" > ${m} COLLATE "C"))`);
        }
      } else {
        throw new RangeError("unknown order");
      }
      params.push(query.limit + 1);
      const rows = await db.query<ClaimRow>(
        `SELECT ${CLAIM_COLUMNS} FROM pine_index.claims ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT $${params.length}`,
        params,
      );
      return page(rows.map(toClaim), query.limit, (claim) =>
        scope === "claims:created_desc"
          ? encodeCursor(scope, [claim.createdBlock.toString(), String(claim.createdLogIndex)])
          : encodeCursor(scope, [String(claim.evidenceDeadline), claim.market]),
      );
    },

    async listClaimsByQuestion(questionId: Hex32): Promise<ClaimRecord[]> {
      const rows = await db.query<ClaimRow>(`SELECT ${CLAIM_COLUMNS} FROM pine_index.claims WHERE question_id = $1 ORDER BY created_block, created_log_index`, [
        lower(String(questionId)),
      ]);
      return rows.map(toClaim);
    },

    async getEvidence(registry: Address, submissionId: bigint): Promise<EvidenceRecord | null> {
      if (typeof submissionId !== "bigint" || submissionId < 0n) return null;
      const rows = await db.query<EvidenceRow>(`SELECT ${EVIDENCE_COLUMNS} FROM pine_index.evidence WHERE registry = $1 AND submission_id = $2::numeric`, [
        lower(String(registry)),
        submissionId.toString(),
      ]);
      return rows[0] ? toEvidence(rows[0]) : null;
    },

    async listEvidence(query: ListEvidenceQuery): Promise<Page<EvidenceRecord>> {
      assertLimit(query.limit);
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: (placeholder: string) => string, value: unknown): void => {
        params.push(value);
        where.push(clause(`$${params.length}`));
      };
      if (query.market) add((p) => `market = ${p}`, lower(String(query.market)));
      if (query.submitter) add((p) => `submitter = ${p}`, lower(String(query.submitter)));
      if (query.status) add((p) => `status = ${p}`, String(query.status));
      if (query.cursor !== undefined) {
        const [block, logIndex] = decodeCursor(query.cursor, "evidence");
        params.push(block, Number(logIndex));
        where.push(`(committed_block, committed_log_index) > ($${params.length - 1}::int8, $${params.length}::int4)`);
      }
      params.push(query.limit + 1);
      const rows = await db.query<EvidenceRow>(
        `SELECT ${EVIDENCE_COLUMNS} FROM pine_index.evidence ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY committed_block, committed_log_index LIMIT $${params.length}`,
        params,
      );
      return page(rows.map(toEvidence), query.limit, (record) => encodeCursor("evidence", [record.committedBlock.toString(), String(record.committedLogIndex)]));
    },

    async getOracleQuestion(questionId: Hex32): Promise<OracleQuestionRecord | null> {
      const id = lower(String(questionId));
      const rows = await db.query<{
        question_id: Hex32;
        opening_ts: string;
        min_bond: string;
        timeout: string;
        best_answer: Hex32 | null;
        bond: string;
        finalize_ts: string;
        pending_arbitration: boolean;
        arbitration_requested_by: Address | null;
        answered_by_arbitrator: boolean;
        bounty: string;
        reopened_by: Hex32 | null;
        reopens: Hex32 | null;
        answer_count: number;
        last_event_block: string;
      }>(
        `SELECT question_id, opening_ts::text AS opening_ts, min_bond::text AS min_bond, timeout::text AS timeout, best_answer, bond::text AS bond,
                finalize_ts::text AS finalize_ts, pending_arbitration, arbitration_requested_by, answered_by_arbitrator, bounty::text AS bounty,
                reopened_by, reopens, answer_count, last_event_block::text AS last_event_block
           FROM pine_index.questions WHERE question_id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      const markets = await db.query<{ market: Address }>(`SELECT market FROM pine_index.question_markets WHERE question_id = $1 ORDER BY market COLLATE "C"`, [id]);
      return {
        questionId: row.question_id,
        markets: markets.map((item) => item.market),
        openingTs: Number(row.opening_ts),
        minBond: BigInt(row.min_bond),
        timeout: Number(row.timeout),
        bestAnswer: row.best_answer,
        bond: BigInt(row.bond),
        finalizeTs: Number(row.finalize_ts),
        pendingArbitration: row.pending_arbitration,
        arbitrationRequestedBy: row.arbitration_requested_by,
        answeredByArbitrator: row.answered_by_arbitrator,
        bounty: BigInt(row.bounty),
        reopenedBy: row.reopened_by,
        reopens: row.reopens,
        answerCount: row.answer_count,
        lastEventBlock: BigInt(row.last_event_block),
      };
    },

    async listOracleAnswers(questionId: Hex32): Promise<OracleAnswerRecord[]> {
      const rows = await db.query<{
        question_id: Hex32;
        answer: Hex32;
        history_hash: Hex32;
        answerer: Address;
        bond: string;
        ts: string;
        is_commitment: boolean;
        revealed_answer: Hex32 | null;
        tx_hash: Hex32;
        block_number: string;
        log_index: number;
      }>(
        `SELECT question_id, answer, history_hash, answerer, bond::text AS bond, ts::text AS ts, is_commitment, revealed_answer, tx_hash,
                block_number::text AS block_number, log_index
           FROM pine_index.answers WHERE question_id = $1 ORDER BY block_number, log_index`,
        [lower(String(questionId))],
      );
      return rows.map((row) => ({
        questionId: row.question_id,
        answer: row.answer,
        historyHash: row.history_hash,
        answerer: row.answerer,
        bond: BigInt(row.bond),
        ts: Number(row.ts),
        isCommitment: row.is_commitment,
        revealedAnswer: row.revealed_answer,
        txHash: row.tx_hash,
        blockNumber: BigInt(row.block_number),
        logIndex: row.log_index,
      }));
    },

    async getArbitration(questionId: Hex32): Promise<ArbitrationRecord | null> {
      const id = lower(String(questionId));
      const rows = await db.query<{
        question_id: Hex32;
        stage: KlerosHomeStage;
        requester: Address | null;
        rejection_reason_json: string | null;
        arbitrator_answer: Hex32 | null;
        updated_at: string;
      }>(
        "SELECT question_id, stage, requester, rejection_reason_json, arbitrator_answer, updated_at::text AS updated_at FROM pine_index.arbitrations WHERE question_id = $1",
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      const history = await db.query<{ stage: KlerosHomeStage; at: string; tx_hash: Hex32 }>(
        "SELECT stage, at::text AS at, tx_hash FROM pine_index.arbitration_history WHERE question_id = $1 ORDER BY block_number, log_index",
        [id],
      );
      return {
        questionId: row.question_id,
        stage: row.stage,
        requester: row.requester,
        rejectionReason: row.rejection_reason_json === null ? null : jsonString(row.rejection_reason_json),
        arbitratorAnswer: row.arbitrator_answer,
        updatedAt: Number(row.updated_at),
        history: history.map((entry) => ({ stage: entry.stage, at: Number(entry.at), txHash: entry.tx_hash })),
      };
    },

    async getConditionResolution(conditionId: Hex32): Promise<ConditionResolutionRecord | null> {
      const id = lower(String(conditionId));
      const rows = await db.query<{ condition_id: Hex32; ctf_question_id: Hex32; resolved_at: string; tx_hash: Hex32; block_number: string }>(
        `SELECT condition_id, ctf_question_id, resolved_at::text AS resolved_at, tx_hash, block_number::text AS block_number
           FROM pine_index.condition_resolutions WHERE condition_id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      const payouts = await db.query<{ numerator: string }>("SELECT numerator::text AS numerator FROM pine_index.condition_payouts WHERE condition_id = $1 ORDER BY position", [id]);
      return {
        conditionId: row.condition_id,
        ctfQuestionId: row.ctf_question_id,
        payoutNumerators: payouts.map((item) => BigInt(item.numerator)),
        resolvedAt: Number(row.resolved_at),
        txHash: row.tx_hash,
        blockNumber: BigInt(row.block_number),
      };
    },
  };
}

function finiteNumber(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RangeError("deadline filters must be finite numbers");
  return value;
}
