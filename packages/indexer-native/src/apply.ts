// The apply layer (PRD-05 section 2.1): a SQL translation of every case of MemoryReadModel.applyOne
// (packages/shared/src/testing/memory-read-model.ts, the executable specification). Comments name the reference rule each
// statement reproduces. Must run inside a transaction together with advanceCursor (the poller and the conformance
// factory both do so).
//
// Idempotency (SEC-IDX-04, operator-settled): a cursor-position guard, no per-event rows. Inside its transaction (the cursor
// row is locked FOR UPDATE) every event at or before the stored position is skipped: blockNumber <= indexed_block (the
// poller always applies whole blocks) or (blockNumber, logIndex) <= (last_event_block, last_event_log_index). Events apply
// strictly in (blockNumber, logIndex) order, so a replay ignores and tracks exactly what the first application did; within
// one call, an event at or before the previous one throws OutOfOrderEventError, as the reference does.

import { encodePacked, keccak256 } from "viem";
import type { ChainEvent } from "@pine/shared/chain-events";
import type { Address, Hex32 } from "@pine/shared/types";
import type { SqlExecutor } from "./db.js";

export interface ApplyOptions {
  chainId: number;
  /** Seer MarketFactory.questionTimeout(), seconds. */
  questionTimeout: number;
}

export interface ApplyResult {
  /** Logs applied for the first time (tracked or ignored). */
  applied: number;
  /** Logs skipped by the cursor-position guard (at or before the stored position). */
  skipped: number;
}

export class OutOfOrderEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutOfOrderEventError";
  }
}

const lower = <T extends string>(value: T): T => value.toLowerCase() as T;
const dec = (value: bigint): string => value.toString();

interface Position {
  block: bigint;
  logIndex: number;
}

const atOrBefore = (event: Position, position: Position): boolean =>
  event.block < position.block || (event.block === position.block && event.logIndex <= position.logIndex);

/** Creates the chain's cursor row if missing and locks it for the rest of the transaction. */
export async function lockCursor(tx: SqlExecutor, chainId: number): Promise<{ indexedBlock: bigint; indexedBlockHash: string | null; last: Position | null }> {
  await tx.query("INSERT INTO pine_index.cursor (chain_id) VALUES ($1) ON CONFLICT (chain_id) DO NOTHING", [chainId]);
  const rows = await tx.query<{ indexed_block: string; indexed_block_hash: string | null; last_event_block: string | null; last_event_log_index: number | null }>(
    `SELECT indexed_block::text AS indexed_block, indexed_block_hash, last_event_block::text AS last_event_block, last_event_log_index
       FROM pine_index.cursor WHERE chain_id = $1 FOR UPDATE`,
    [chainId],
  );
  const row = rows[0];
  if (!row) throw new Error("cursor row missing");
  return {
    indexedBlock: BigInt(row.indexed_block),
    indexedBlockHash: row.indexed_block_hash,
    last: row.last_event_block !== null && row.last_event_log_index !== null ? { block: BigInt(row.last_event_block), logIndex: row.last_event_log_index } : null,
  };
}

/** Applies events in (blockNumber, logIndex) order. Events at or before the stored cursor position are skipped. */
export async function applyEvents(tx: SqlExecutor, events: readonly ChainEvent[], options: ApplyOptions): Promise<ApplyResult> {
  const result: ApplyResult = { applied: 0, skipped: 0 };
  const cursor = await lockCursor(tx, options.chainId);
  const stored = cursor.last;
  let last = cursor.last;
  for (const event of events) {
    if (event.chainId !== options.chainId) continue; // Reference: events of other chains are ignored.
    const position = { block: event.blockNumber, logIndex: event.logIndex };
    if (event.blockNumber <= cursor.indexedBlock || (stored !== null && atOrBefore(position, stored))) {
      result.skipped += 1;
      continue;
    }
    if (last && atOrBefore(position, last)) {
      throw new OutOfOrderEventError(`Event at ${event.blockNumber}:${event.logIndex} is not after ${last.block}:${last.logIndex}`);
    }
    await applyOne(tx, event, options);
    last = position;
    result.applied += 1;
  }
  if (last && (cursor.last === null || last.block !== cursor.last.block || last.logIndex !== cursor.last.logIndex)) {
    await tx.query("UPDATE pine_index.cursor SET last_event_block = $2, last_event_log_index = $3, updated_at = now() WHERE chain_id = $1", [
      options.chainId,
      dec(last.block),
      last.logIndex,
    ]);
  }
  return result;
}

interface QuestionState {
  question_id: Hex32;
  bond: string;
  timeout: string;
}

async function findQuestion(tx: SqlExecutor, questionId: Hex32): Promise<QuestionState | null> {
  const rows = await tx.query<{ question_id: Hex32; bond: string; timeout: string }>(
    "SELECT question_id, bond::text AS bond, timeout::text AS timeout FROM pine_index.questions WHERE question_id = $1",
    [lower(questionId)],
  );
  return rows[0] ?? null;
}

async function insertQuestion(
  tx: SqlExecutor,
  options: ApplyOptions,
  questionId: Hex32,
  openingTs: number | string,
  minBond: string,
  reopens: Hex32 | null,
  lastEventBlock: bigint,
): Promise<void> {
  // Reference newQuestion: timeout from the options, unanswered, no bond, no bounty.
  await tx.query(
    `INSERT INTO pine_index.questions (question_id, opening_ts, min_bond, timeout, reopens, last_event_block)
     VALUES ($1, $2::int8, $3::numeric, $4::int8, $5, $6::int8)`,
    [questionId, String(openingTs), minBond, options.questionTimeout, reopens, dec(lastEventBlock)],
  );
}

async function applyOne(tx: SqlExecutor, event: ChainEvent, options: ApplyOptions): Promise<void> {
  switch (event.kind) {
    case "ClaimCreated": {
      const market = lower(event.market);
      // The registry never emits twice for one market; first wins.
      const inserted = await tx.query(
        `INSERT INTO pine_index.claims (market, registry, creator, claim_document_sha256, policy_document_sha256, repository_id, commit,
           question_id, condition_id, evidence_deadline, reveal_deadline, min_bond, title_json, market_name_json, market_name_hash,
           yes_token, no_token, invalid_token, created_at, created_block, created_tx_hash, created_log_index)
         VALUES ($1, $2, $3, $4, $5, $6::int8, $7, $8, $9, $10::int8, $11::int8, $12::numeric, $13, $14, $15, $16, $17, $18, $19::int8, $20::int8, $21, $22)
         ON CONFLICT (market) DO NOTHING
         RETURNING market`,
        [
          market,
          lower(event.address),
          lower(event.creator),
          lower(event.claimDocumentSha256),
          lower(event.policyDocumentSha256),
          String(event.repositoryId),
          event.commit.toLowerCase(),
          lower(event.questionId),
          lower(event.conditionId),
          String(event.evidenceDeadline),
          String(event.revealDeadline),
          dec(event.minBond),
          JSON.stringify(event.title),
          JSON.stringify(event.marketName),
          lower(event.marketNameHash),
          lower(event.yesToken),
          lower(event.noToken),
          lower(event.invalidToken),
          String(event.blockTimestamp),
          dec(event.blockNumber),
          lower(event.transactionHash),
          event.logIndex,
        ],
      );
      if (inserted.length === 0) return;
      await tx.query("INSERT INTO pine_index.tracked_conditions (condition_id) VALUES ($1) ON CONFLICT (condition_id) DO NOTHING", [lower(event.conditionId)]);
      const questionId = lower(event.questionId);
      if (!(await findQuestion(tx, questionId))) {
        await insertQuestion(tx, options, questionId, event.revealDeadline, dec(event.minBond), null, 0n);
      }
      // Seer reuses an identical Reality question for identical market parameters: the market joins the set.
      await tx.query("INSERT INTO pine_index.question_markets (question_id, market) VALUES ($1, $2) ON CONFLICT DO NOTHING", [questionId, market]);
      return;
    }
    case "EvidenceCommitted": {
      await tx.query(
        `INSERT INTO pine_index.evidence (registry, submission_id, market, submitter, status, commitment, content_sha256, committed_at, revealed_at,
           committed_tx_hash, committed_block, committed_log_index)
         VALUES ($1, $2::numeric, $3, $4, 'committed', $5, NULL, $6::int8, NULL, $7, $8::int8, $9)
         ON CONFLICT (registry, submission_id) DO NOTHING`,
        [
          lower(event.address),
          dec(event.submissionId),
          lower(event.market),
          lower(event.submitter),
          lower(event.commitment),
          String(event.committedAt),
          lower(event.transactionHash),
          dec(event.blockNumber),
          event.logIndex,
        ],
      );
      return;
    }
    case "EvidenceRevealed": {
      // Unknown or already disclosed: ignore (never crash).
      await tx.query(
        `UPDATE pine_index.evidence SET status = 'revealed', content_sha256 = $3, revealed_at = $4::int8
          WHERE registry = $1 AND submission_id = $2::numeric AND status = 'committed'`,
        [lower(event.address), dec(event.submissionId), lower(event.contentSha256), String(event.revealedAt)],
      );
      return;
    }
    case "EvidencePublished": {
      await tx.query(
        `INSERT INTO pine_index.evidence (registry, submission_id, market, submitter, status, commitment, content_sha256, committed_at, revealed_at,
           committed_tx_hash, committed_block, committed_log_index)
         VALUES ($1, $2::numeric, $3, $4, 'published', NULL, $5, $6::int8, $6::int8, $7, $8::int8, $9)
         ON CONFLICT (registry, submission_id) DO NOTHING`,
        [
          lower(event.address),
          dec(event.submissionId),
          lower(event.market),
          lower(event.submitter),
          lower(event.contentSha256),
          String(event.publishedAt),
          lower(event.transactionHash),
          dec(event.blockNumber),
          event.logIndex,
        ],
      );
      return;
    }
    case "RealityNewAnswer": {
      const question = await findQuestion(tx, event.questionId);
      if (!question) return;
      await tx.query(
        `INSERT INTO pine_index.answers (question_id, block_number, log_index, answer, history_hash, answerer, bond, ts, is_commitment, revealed_answer, tx_hash)
         VALUES ($1, $2::int8, $3, $4, $5, $6, $7::numeric, $8::int8, $9, $10, $11)`,
        [
          question.question_id,
          dec(event.blockNumber),
          event.logIndex,
          lower(event.answer),
          lower(event.historyHash),
          lower(event.user),
          dec(event.bond),
          String(event.ts),
          event.isCommitment,
          event.isCommitment ? null : lower(event.answer),
          lower(event.transactionHash),
        ],
      );
      // _addAnswerToHistory: the bond level changes only when a bond is posted (arbitrator answers carry none).
      // submitAnswer: finalize_ts = ts + timeout. Arbitrator answer (bond 0, after LogFinalize): finalize_ts = ts.
      await tx.query(
        `UPDATE pine_index.questions SET
           answer_count = answer_count + 1,
           bond = CASE WHEN $2::numeric > 0 THEN $2::numeric ELSE bond END,
           best_answer = CASE WHEN $3::boolean THEN best_answer ELSE $4 END,
           finalize_ts = CASE WHEN $3::boolean THEN finalize_ts WHEN $2::numeric > 0 THEN $5::int8 + timeout ELSE $5::int8 END,
           last_event_block = $6::int8
         WHERE question_id = $1`,
        [question.question_id, dec(event.bond), event.isCommitment, lower(event.answer), String(event.ts), dec(event.blockNumber)],
      );
      return;
    }
    case "RealityAnswerReveal": {
      const question = await findQuestion(tx, event.questionId);
      if (!question) return;
      // submitAnswerReveal: commitment_id = keccak256(abi.encodePacked(question_id, answer_hash, bond)).
      const commitmentId = keccak256(encodePacked(["bytes32", "bytes32", "uint256"], [question.question_id, lower(event.answerHash), event.bond]));
      await tx.query(
        `UPDATE pine_index.answers SET revealed_answer = $3
          WHERE (question_id, block_number, log_index) = (
            SELECT question_id, block_number, log_index FROM pine_index.answers
             WHERE question_id = $1 AND is_commitment AND answer = $2
             ORDER BY block_number, log_index LIMIT 1)`,
        [question.question_id, commitmentId, lower(event.answer)],
      );
      // Only the reveal of the current (highest) bond becomes the best answer and restarts the timeout.
      await tx.query(
        `UPDATE pine_index.questions SET
           best_answer = CASE WHEN bond = $2::numeric THEN $3 ELSE best_answer END,
           finalize_ts = CASE WHEN bond = $2::numeric THEN $4::int8 + timeout ELSE finalize_ts END,
           last_event_block = $5::int8
         WHERE question_id = $1`,
        [question.question_id, dec(event.bond), lower(event.answer), String(event.blockTimestamp), dec(event.blockNumber)],
      );
      return;
    }
    case "RealityArbitrationRequested": {
      await tx.query(
        "UPDATE pine_index.questions SET pending_arbitration = true, arbitration_requested_by = $2, last_event_block = $3::int8 WHERE question_id = $1",
        [lower(event.questionId), lower(event.user), dec(event.blockNumber)],
      );
      return;
    }
    case "RealityArbitrationCancelled": {
      // cancelArbitration: not pending, finalize_ts = now + timeout.
      await tx.query(
        "UPDATE pine_index.questions SET pending_arbitration = false, finalize_ts = $2::int8 + timeout, last_event_block = $3::int8 WHERE question_id = $1",
        [lower(event.questionId), String(event.blockTimestamp), dec(event.blockNumber)],
      );
      return;
    }
    case "RealityArbitratorAnswered": {
      // submitAnswerByArbitrator: best_answer = answer, finalize_ts = now, not pending.
      await tx.query(
        `UPDATE pine_index.questions SET pending_arbitration = false, best_answer = $2, finalize_ts = $3::int8, answered_by_arbitrator = true,
           last_event_block = $4::int8
         WHERE question_id = $1`,
        [lower(event.questionId), lower(event.answer), String(event.blockTimestamp), dec(event.blockNumber)],
      );
      return;
    }
    case "RealityQuestionReopened": {
      const originalId = lower(event.reopenedQuestionId);
      const original = await tx.query<{ opening_ts: string; min_bond: string }>(
        "SELECT opening_ts::text AS opening_ts, min_bond::text AS min_bond FROM pine_index.questions WHERE question_id = $1",
        [originalId],
      );
      const row = original[0];
      if (!row) return;
      const replacement = lower(event.questionId);
      await tx.query("UPDATE pine_index.questions SET reopened_by = $2, last_event_block = $3::int8 WHERE question_id = $1", [
        originalId,
        replacement,
        dec(event.blockNumber),
      ]);
      if (!(await findQuestion(tx, replacement))) {
        // reopenQuestion requires identical content, opening time, min bond and timeout.
        await insertQuestion(tx, options, replacement, row.opening_ts, row.min_bond, originalId, event.blockNumber);
        await tx.query(
          "INSERT INTO pine_index.question_markets (question_id, market) SELECT $2, market FROM pine_index.question_markets WHERE question_id = $1",
          [originalId, replacement],
        );
      }
      return;
    }
    case "RealityBountyFunded": {
      await tx.query("UPDATE pine_index.questions SET bounty = $2::numeric, last_event_block = $3::int8 WHERE question_id = $1", [
        lower(event.questionId),
        dec(event.bounty),
        dec(event.blockNumber),
      ]);
      return;
    }
    case "ConditionResolution": {
      const conditionId = lower(event.conditionId);
      // Only tracked conditions; the first resolution wins.
      const inserted = await tx.query(
        `INSERT INTO pine_index.condition_resolutions (condition_id, ctf_question_id, resolved_at, tx_hash, block_number)
         SELECT condition_id, $2, $3::int8, $4, $5::int8 FROM pine_index.tracked_conditions WHERE condition_id = $1
         ON CONFLICT (condition_id) DO NOTHING
         RETURNING condition_id`,
        [conditionId, lower(event.ctfQuestionId), String(event.blockTimestamp), lower(event.transactionHash), dec(event.blockNumber)],
      );
      if (inserted.length === 0) return;
      for (const [position, numerator] of event.payoutNumerators.entries()) {
        await tx.query("INSERT INTO pine_index.condition_payouts (condition_id, position, numerator) VALUES ($1, $2, $3::numeric)", [conditionId, position, dec(numerator)]);
      }
      return;
    }
    case "KlerosHome": {
      const questionId = lower(event.questionId);
      if (!(await findQuestion(tx, questionId))) return;
      await tx.query(
        `INSERT INTO pine_index.arbitrations (question_id, stage, requester, rejection_reason_json, arbitrator_answer, updated_at)
         VALUES ($1, $2, NULL, NULL, NULL, $3::int8)
         ON CONFLICT (question_id) DO NOTHING`,
        [questionId, event.stage, String(event.blockTimestamp)],
      );
      const requester: Address | null = event.requester ? lower(event.requester) : null;
      const arbitratorAnswer: Hex32 | null = event.stage === "ArbitratorAnswered" && event.answer ? lower(event.answer) : null;
      await tx.query(
        `UPDATE pine_index.arbitrations SET
           stage = $2,
           requester = COALESCE($3, requester),
           rejection_reason_json = CASE WHEN $2 = 'RequestRejected' THEN $4 ELSE rejection_reason_json END,
           arbitrator_answer = COALESCE($5, arbitrator_answer),
           updated_at = $6::int8
         WHERE question_id = $1`,
        [questionId, event.stage, requester, event.reason === null ? null : JSON.stringify(event.reason), arbitratorAnswer, String(event.blockTimestamp)],
      );
      await tx.query(
        "INSERT INTO pine_index.arbitration_history (question_id, block_number, log_index, stage, at, tx_hash) VALUES ($1, $2::int8, $3, $4, $5::int8, $6)",
        [questionId, dec(event.blockNumber), event.logIndex, event.stage, String(event.blockTimestamp), lower(event.transactionHash)],
      );
      return;
    }
  }
}
