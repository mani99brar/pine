// Differential harness: runs ChainEvents through the real Envio handlers (createTestIndexer, simulate) and through
// MemoryReadModel, then compares every record the reference holds with the mapped entities, in both directions.

import { createTestIndexer, type TestIndexer } from "envio";
import { expect } from "vitest";
import type { ChainEvent } from "@pine/shared/chain-events";
import { MemoryReadModel } from "@pine/shared/testing/memory-read-model";
import { SCENARIO_CHAIN_ID, SCENARIO_QUESTION_TIMEOUT } from "@pine/shared/testing/read-model-scenarios";
import type { Hex32 } from "@pine/shared/types";
import { answerRecords, arbitrationRecord, claimRecord, evidenceRecord, questionRecord, resolutionRecord } from "./records.js";
import { toSimulateItem } from "./simulate.js";

export const ENTITY_NAMES = [
  "AnswerCommitment",
  "Arbitration",
  "ArbitrationStage",
  "Claim",
  "ConditionResolution",
  "EvidenceSubmission",
  "IndexerProgress",
  "OracleAnswer",
  "OracleQuestion",
  "TrackedCondition",
] as const;

export type EntityRows = Record<(typeof ENTITY_NAMES)[number], { id: string }[]>;

/** Processes `events` with the real handlers, in `batches` consecutive process() calls (split at block boundaries). */
export async function runEnvio(events: readonly ChainEvent[], batches: readonly (readonly ChainEvent[])[] = [events]): Promise<TestIndexer> {
  const indexer = createTestIndexer();
  for (const batch of batches) {
    if (batch.length === 0) continue;
    await indexer.process({ chains: { [SCENARIO_CHAIN_ID]: { simulate: batch.map(toSimulateItem) } } });
  }
  return indexer;
}

export async function allEntities(indexer: TestIndexer): Promise<EntityRows> {
  const [AnswerCommitment, Arbitration, ArbitrationStage, Claim, ConditionResolution, EvidenceSubmission, IndexerProgress, OracleAnswer, OracleQuestion, TrackedCondition] =
    await Promise.all([
      indexer.AnswerCommitment.getAll(),
      indexer.Arbitration.getAll(),
      indexer.ArbitrationStage.getAll(),
      indexer.Claim.getAll(),
      indexer.ConditionResolution.getAll(),
      indexer.EvidenceSubmission.getAll(),
      indexer.IndexerProgress.getAll(),
      indexer.OracleAnswer.getAll(),
      indexer.OracleQuestion.getAll(),
      indexer.TrackedCondition.getAll(),
    ]);
  return { AnswerCommitment, Arbitration, ArbitrationStage, Claim, ConditionResolution, EvidenceSubmission, IndexerProgress, OracleAnswer, OracleQuestion, TrackedCondition };
}

export function referenceOf(events: readonly ChainEvent[], questionTimeout = SCENARIO_QUESTION_TIMEOUT): MemoryReadModel {
  const reference = new MemoryReadModel({ chainId: SCENARIO_CHAIN_ID, questionTimeout });
  reference.apply(events);
  return reference;
}

/** Every question and condition id an event mentions: the candidates the reference may hold records for. */
function mentionedIds(events: readonly ChainEvent[]): { questions: Hex32[]; conditions: Hex32[] } {
  const questions = new Set<Hex32>();
  const conditions = new Set<Hex32>();
  for (const event of events) {
    if (event.kind === "ClaimCreated") {
      questions.add(event.questionId.toLowerCase() as Hex32);
      conditions.add(event.conditionId.toLowerCase() as Hex32);
    } else if (event.kind === "ConditionResolution") {
      conditions.add(event.conditionId.toLowerCase() as Hex32);
    } else if (event.kind === "RealityQuestionReopened") {
      questions.add(event.questionId.toLowerCase() as Hex32);
      questions.add(event.reopenedQuestionId.toLowerCase() as Hex32);
    } else if ("questionId" in event) {
      questions.add(event.questionId.toLowerCase() as Hex32);
    }
  }
  return { questions: [...questions].sort(), conditions: [...conditions].sort() };
}

const byKey = <T>(key: (item: T) => string) => (a: T, b: T): number => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/**
 * Asserts that the handlers' entities equal MemoryReadModel's records for the same events, field by field. The reference
 * uses `questionTimeout` (default: the scenarios' 302400 s, also ENVIO_QUESTION_TIMEOUT's default).
 */
export async function expectEquivalent(events: readonly ChainEvent[], indexer: TestIndexer, questionTimeout = SCENARIO_QUESTION_TIMEOUT): Promise<void> {
  const reference = referenceOf(events, questionTimeout);
  const { questions, conditions } = mentionedIds(events);

  const claims = (await indexer.Claim.getAll()).map(claimRecord).sort(byKey((claim) => claim.market));
  const expectedClaims = (await walkAll((cursor) => reference.listClaims({ order: "created_desc", limit: 100, ...(cursor ? { cursor } : {}) }))).sort(
    byKey((claim) => claim.market),
  );
  expect(claims).toEqual(expectedClaims);

  const evidence = (await indexer.EvidenceSubmission.getAll()).map(evidenceRecord);
  evidence.sort((a, b) => (a.committedBlock !== b.committedBlock ? (a.committedBlock < b.committedBlock ? -1 : 1) : a.committedLogIndex - b.committedLogIndex));
  expect(evidence).toEqual(await walkAll((cursor) => reference.listEvidence({ limit: 100, ...(cursor ? { cursor } : {}) })));

  const questionRows = await indexer.OracleQuestion.getAll();
  const answerRows = await indexer.OracleAnswer.getAll();
  const arbitrationRows = await indexer.Arbitration.getAll();
  const stageRows = await indexer.ArbitrationStage.getAll();
  let expectedQuestions = 0;
  let expectedAnswers = 0;
  let expectedArbitrations = 0;
  let expectedStages = 0;
  for (const id of questions) {
    const expectedQuestion = await reference.getOracleQuestion(id);
    const row = questionRows.find((item) => item.id === id);
    expect(row ? questionRecord(row) : null, `question ${id}`).toEqual(expectedQuestion);
    if (expectedQuestion) expectedQuestions += 1;

    const expectedAnswerList = await reference.listOracleAnswers(id);
    expect(answerRecords(answerRows.filter((item) => item.questionId === id)), `answers of ${id}`).toEqual(expectedAnswerList);
    expectedAnswers += expectedAnswerList.length;

    const expectedArbitration = await reference.getArbitration(id);
    const arbitration = arbitrationRows.find((item) => item.id === id);
    const stages = stageRows.filter((item) => item.questionId === id);
    expect(arbitration ? arbitrationRecord(arbitration, stages) : null, `arbitration of ${id}`).toEqual(expectedArbitration);
    if (expectedArbitration) {
      expectedArbitrations += 1;
      expectedStages += expectedArbitration.history.length;
    }
  }
  // Nothing beyond what the reference holds (e.g. no rows for untracked ids).
  expect(questionRows.length).toBe(expectedQuestions);
  expect(answerRows.length).toBe(expectedAnswers);
  expect(arbitrationRows.length).toBe(expectedArbitrations);
  expect(stageRows.length).toBe(expectedStages);

  const resolutionRows = await indexer.ConditionResolution.getAll();
  let expectedResolutions = 0;
  for (const id of conditions) {
    const expected = await reference.getConditionResolution(id);
    const row = resolutionRows.find((item) => item.id === id);
    expect(row ? resolutionRecord(row) : null, `resolution of ${id}`).toEqual(expected);
    if (expected) expectedResolutions += 1;
  }
  expect(resolutionRows.length).toBe(expectedResolutions);

  // status(): the progress singleton carries the reference's indexed block and its timestamp.
  const status = await reference.status();
  const progress = await indexer.IndexerProgress.getAll();
  expect(progress).toEqual(events.length === 0 ? [] : [{ id: String(SCENARIO_CHAIN_ID), blockNumber: status.indexedBlock, blockTimestamp: BigInt(status.indexedBlockTimestamp) }]);
}

async function walkAll<T>(page: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await page(cursor);
    items.push(...result.items);
    if (result.nextCursor === null) return items;
    cursor = result.nextCursor;
  }
}

/** Splits events into consecutive batches at block boundaries (each batch ends with a whole block). */
export function splitAtBlocks(events: readonly ChainEvent[], parts: number): ChainEvent[][] {
  const blocks: ChainEvent[][] = [];
  for (const event of events) {
    const last = blocks.at(-1);
    if (last && last[0]!.blockNumber === event.blockNumber) last.push(event);
    else blocks.push([event]);
  }
  const size = Math.ceil(blocks.length / parts);
  const batches: ChainEvent[][] = [];
  for (let index = 0; index < blocks.length; index += size) batches.push(blocks.slice(index, index + size).flat());
  return batches;
}
