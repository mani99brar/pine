// Cursor and halt tables: the only writes besides applyEvents (PRD-05 section 2.1). advanceCursor runs in the same
// transaction as applyEvents; a halt freezes the chain until an operator deletes the halt row after investigation.

import { REALITY_ANSWERED_TOO_SOON } from "@pine/shared/read-model";
import type { SqlExecutor } from "./db.js";

export type HaltReason =
  | "rpc_disagreement"
  | "log_disagreement"
  | "header_disagreement"
  | "log_hash_mismatch"
  | "decode_failure"
  | "finalized_conflict"
  | "invalid_rpc_data"
  | "apply_conflict";

export interface CursorAdvance {
  chainId: number;
  block: bigint;
  blockHash: string;
  blockTimestamp: number;
}

export class CursorRegressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorRegressionError";
  }
}

/** Moves the indexed cursor forward (never backwards). Call inside the transaction that applied the range. */
export async function advanceCursor(tx: SqlExecutor, advance: CursorAdvance): Promise<void> {
  await tx.query("INSERT INTO pine_index.cursor (chain_id) VALUES ($1) ON CONFLICT (chain_id) DO NOTHING", [advance.chainId]);
  const updated = await tx.query(
    `UPDATE pine_index.cursor
        SET indexed_block = $2::int8, indexed_block_hash = $3, indexed_block_timestamp = $4::int8, updated_at = now()
      WHERE chain_id = $1 AND indexed_block <= $2::int8
      RETURNING chain_id`,
    [advance.chainId, advance.block.toString(), advance.blockHash.toLowerCase(), String(advance.blockTimestamp)],
  );
  if (updated.length === 0) throw new CursorRegressionError(`Indexed block cannot move backwards to ${advance.block}`);
}

/** Records the canonical hash of a block that contained applied events (same transaction as the apply). */
export async function recordBlock(tx: SqlExecutor, chainId: number, block: bigint, blockHash: string, blockTimestamp: number): Promise<void> {
  const rows = await tx.query<{ block_hash: string }>(
    `INSERT INTO pine_index.blocks (chain_id, block_number, block_hash, block_timestamp) VALUES ($1, $2::int8, $3, $4::int8)
     ON CONFLICT (chain_id, block_number) DO UPDATE SET block_hash = pine_index.blocks.block_hash
     RETURNING block_hash`,
    [chainId, block.toString(), blockHash.toLowerCase(), String(blockTimestamp)],
  );
  if (rows[0]?.block_hash !== blockHash.toLowerCase()) throw new CursorRegressionError(`Stored hash of block ${block} differs from the canonical header`);
}

export interface CursorState {
  indexedBlock: bigint;
  indexedBlockHash: string | null;
  indexedBlockTimestamp: number;
  finalizedBlock: bigint | null;
  headBlock: bigint | null;
}

export async function readCursor(db: SqlExecutor, chainId: number): Promise<CursorState | null> {
  const rows = await db.query<{ indexed_block: string; indexed_block_hash: string | null; indexed_block_timestamp: string; finalized_block: string | null; head_block: string | null }>(
    `SELECT indexed_block::text AS indexed_block, indexed_block_hash, indexed_block_timestamp::text AS indexed_block_timestamp,
            finalized_block::text AS finalized_block, head_block::text AS head_block
       FROM pine_index.cursor WHERE chain_id = $1`,
    [chainId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    indexedBlock: BigInt(row.indexed_block),
    indexedBlockHash: row.indexed_block_hash,
    indexedBlockTimestamp: Number(row.indexed_block_timestamp),
    finalizedBlock: row.finalized_block === null ? null : BigInt(row.finalized_block),
    headBlock: row.head_block === null ? null : BigInt(row.head_block),
  };
}

/** Stores the latest observed finalized and head block numbers (status only; never moves the indexed cursor). */
export async function recordObservation(db: SqlExecutor, chainId: number, finalizedBlock: bigint, headBlock: bigint | null): Promise<void> {
  await db.query(
    `INSERT INTO pine_index.cursor (chain_id, finalized_block, head_block) VALUES ($1, $2::int8, $3::int8)
     ON CONFLICT (chain_id) DO UPDATE SET finalized_block = EXCLUDED.finalized_block, head_block = EXCLUDED.head_block, updated_at = now()`,
    [chainId, finalizedBlock.toString(), headBlock === null ? null : headBlock.toString()],
  );
}

/** Records a halt. `detail` must already be redacted. */
export async function recordHalt(db: SqlExecutor, chainId: number, reason: HaltReason, detail: string, block: bigint | null): Promise<void> {
  await db.query("INSERT INTO pine_index.halts (chain_id, reason, detail, block_number) VALUES ($1, $2, $3, $4::int8)", [
    chainId,
    reason,
    detail.slice(0, 2_000),
    block === null ? null : block.toString(),
  ]);
}

export async function isHalted(db: SqlExecutor, chainId: number): Promise<boolean> {
  const rows = await db.query<{ halted: boolean }>("SELECT EXISTS (SELECT 1 FROM pine_index.halts WHERE chain_id = $1) AS halted", [chainId]);
  return rows[0]?.halted === true;
}

export async function listHalts(db: SqlExecutor, chainId: number): Promise<{ reason: HaltReason; detail: string; blockNumber: bigint | null }[]> {
  const rows = await db.query<{ reason: HaltReason; detail: string; block_number: string | null }>(
    "SELECT reason, detail, block_number::text AS block_number FROM pine_index.halts WHERE chain_id = $1 ORDER BY id",
    [chainId],
  );
  return rows.map((row) => ({ reason: row.reason, detail: row.detail, blockNumber: row.block_number === null ? null : BigInt(row.block_number) }));
}

/**
 * The ACTIVE filter set of the request plan (PRD-05 section 3b): the stored tracked ids that can still receive a log.
 * A question is pruned once it is finalized at `chainTime` (Reality isFinalized: not pending arbitration, finalize_ts > 0
 * and finalize_ts <= chainTime) with a real answer (not settled too soon, 0xff..fe), or when it settled too soon but its
 * latest replacement finalized with a real answer (reopenQuestion then requires that replacement to be settled too soon,
 * so no further reopen of it can happen). Reality refuses answers, reveals, arbitration requests and bounties on a
 * finalized question, and block timestamps never decrease, so a question finalized at the cursor block's timestamp gets
 * no further tracked log. A resolved condition cannot be resolved again (CTF). Pruned ids stay in the database.
 *
 * `chainTime` must be the timestamp of the stored cursor block (confirmed by both providers when that block was the end
 * of a processed range), never the wall clock and never a value only one provider reported.
 */
export async function readActiveIds(db: SqlExecutor, chainTime: number): Promise<{ questions: string[]; conditions: string[] }> {
  const questions = await db.query<{ id: string }>(
    `SELECT q.question_id AS id
       FROM pine_index.questions q
       LEFT JOIN pine_index.questions r ON r.question_id = q.reopened_by
      WHERE NOT (
              q.finalize_ts > 0 AND NOT q.pending_arbitration AND q.finalize_ts <= $1::int8
              AND (
                q.best_answer IS DISTINCT FROM $2
                OR (r.question_id IS NOT NULL AND r.finalize_ts > 0 AND NOT r.pending_arbitration AND r.finalize_ts <= $1::int8
                    AND r.best_answer IS DISTINCT FROM $2)
              )
            )
      ORDER BY q.question_id`,
    [String(chainTime), REALITY_ANSWERED_TOO_SOON],
  );
  const conditions = await db.query<{ id: string }>(
    `SELECT t.condition_id AS id
       FROM pine_index.tracked_conditions t
      WHERE NOT EXISTS (SELECT 1 FROM pine_index.condition_resolutions r WHERE r.condition_id = t.condition_id)
      ORDER BY t.condition_id`,
  );
  return { questions: questions.map((row) => row.id), conditions: conditions.map((row) => row.id) };
}
