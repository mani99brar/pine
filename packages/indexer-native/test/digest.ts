// A deterministic digest of every read-model table (bookkeeping timestamps excluded), for idempotency assertions.

import { createHash } from "node:crypto";
import type { SqlExecutor } from "../src/db.js";

const TABLES: Record<string, string> = {
  blocks: "chain_id, block_number",
  claims: "market",
  evidence: "registry, submission_id",
  questions: "question_id",
  question_markets: "question_id, market",
  answers: "question_id, block_number, log_index",
  arbitrations: "question_id",
  arbitration_history: "question_id, block_number, log_index",
  tracked_conditions: "condition_id",
  condition_resolutions: "condition_id",
  condition_payouts: "condition_id, position",
};

export async function readModelDigest(db: SqlExecutor): Promise<string> {
  const hash = createHash("sha256");
  for (const [table, order] of Object.entries(TABLES)) {
    const rows = await db.query<{ row: string }>(`SELECT row_to_json(t)::text AS row FROM pine_index.${table} t ORDER BY ${order}`);
    hash.update(`${table}:${rows.map((item) => item.row).join("\n")}\n`);
  }
  return hash.digest("hex");
}

export async function countRows(db: SqlExecutor, table: string): Promise<number> {
  const rows = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM pine_index.${table}`);
  return Number(rows[0]?.count ?? "0");
}

/** Empties every pine_index table except the migration ledger (one database per test file, reset between tests). */
export async function resetDatabase(db: SqlExecutor): Promise<void> {
  await db.exec(
    `TRUNCATE pine_index.condition_payouts, pine_index.condition_resolutions, pine_index.tracked_conditions, pine_index.arbitration_history,
       pine_index.arbitrations, pine_index.answers, pine_index.question_markets, pine_index.questions, pine_index.evidence, pine_index.claims,
       pine_index.blocks, pine_index.halts, pine_index.cursor`,
  );
}
