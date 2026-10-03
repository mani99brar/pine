// Maps Envio entity rows to the frozen read-model records, field by field, so the entity-equivalence tests can compare
// them with MemoryReadModel. (read-model-envio maps GraphQL rows independently; the conformance suite checks that path.)

import type { Arbitration, ArbitrationStage, Claim, ConditionResolution, EvidenceSubmission, OracleAnswer, OracleQuestion } from "envio";
import type {
  ArbitrationRecord,
  ClaimRecord,
  ConditionResolutionRecord,
  EvidenceRecord,
  OracleAnswerRecord,
  OracleQuestionRecord,
} from "@pine/shared/read-model";
import type { Address, Hex32 } from "@pine/shared/types";

const num = (value: bigint): number => {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("not a safe integer");
  return Number(value);
};
const hex = (value: string): `0x${string}` => {
  if (!/^0x[0-9a-f]*$/.test(value)) throw new Error(`not lowercase hex: ${value}`);
  return value as `0x${string}`;
};
const optHex = (value: string | undefined): `0x${string}` | null => (value === undefined ? null : hex(value));
const strings = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) throw new Error("not a string list");
  return value;
};

export function claimRecord(row: Claim): ClaimRecord {
  return {
    market: hex(row.id),
    registry: hex(row.registry),
    creator: hex(row.creator),
    claimDocumentSha256: hex(row.claimDocumentSha256),
    policyDocumentSha256: hex(row.policyDocumentSha256),
    repositoryId: num(row.repositoryId),
    commit: row.commit,
    questionId: hex(row.questionId),
    conditionId: hex(row.conditionId),
    evidenceDeadline: num(row.evidenceDeadline),
    revealDeadline: num(row.revealDeadline),
    minBond: row.minBond,
    title: row.title,
    marketName: row.marketName,
    marketNameHash: hex(row.marketNameHash),
    yesToken: hex(row.yesToken),
    noToken: hex(row.noToken),
    invalidToken: hex(row.invalidToken),
    createdAt: num(row.createdAt),
    createdBlock: row.createdBlock,
    createdTxHash: hex(row.createdTxHash),
    createdLogIndex: num(row.createdLogIndex),
  };
}

export function evidenceRecord(row: EvidenceSubmission): EvidenceRecord {
  return {
    registry: hex(row.registry),
    submissionId: row.submissionId,
    market: hex(row.market),
    submitter: hex(row.submitter),
    status: row.status,
    commitment: optHex(row.commitment),
    contentSha256: optHex(row.contentSha256),
    committedAt: num(row.committedAt),
    revealedAt: row.revealedAt === undefined ? null : num(row.revealedAt),
    committedTxHash: hex(row.committedTxHash),
    committedBlock: row.committedBlock,
    committedLogIndex: num(row.committedLogIndex),
  };
}

export function questionRecord(row: OracleQuestion): OracleQuestionRecord {
  return {
    questionId: hex(row.id),
    markets: strings(row.markets).map((market) => hex(market) as Address),
    openingTs: num(row.openingTs),
    minBond: row.minBond,
    timeout: num(row.timeout),
    bestAnswer: optHex(row.bestAnswer),
    bond: row.bond,
    finalizeTs: num(row.finalizeTs),
    pendingArbitration: row.pendingArbitration,
    arbitrationRequestedBy: optHex(row.arbitrationRequestedBy),
    answeredByArbitrator: row.answeredByArbitrator,
    bounty: row.bounty,
    reopenedBy: optHex(row.reopenedBy),
    reopens: optHex(row.reopens),
    answerCount: num(row.answerCount),
    lastEventBlock: row.lastEventBlock,
  };
}

const byPosition = <T extends { blockNumber: bigint; logIndex: bigint }>(a: T, b: T): number =>
  a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.logIndex < b.logIndex ? -1 : a.logIndex > b.logIndex ? 1 : 0;

export function answerRecords(rows: readonly OracleAnswer[]): OracleAnswerRecord[] {
  return [...rows].sort(byPosition).map((row) => ({
    questionId: hex(row.questionId),
    answer: hex(row.answer),
    historyHash: hex(row.historyHash),
    answerer: hex(row.answerer),
    bond: row.bond,
    ts: num(row.ts),
    isCommitment: row.isCommitment,
    revealedAnswer: optHex(row.revealedAnswer),
    txHash: hex(row.txHash),
    blockNumber: row.blockNumber,
    logIndex: num(row.logIndex),
  }));
}

export function arbitrationRecord(row: Arbitration, stages: readonly ArbitrationStage[]): ArbitrationRecord {
  return {
    questionId: hex(row.id),
    stage: row.stage,
    requester: optHex(row.requester),
    rejectionReason: row.rejectionReason ?? null,
    arbitratorAnswer: optHex(row.arbitratorAnswer),
    updatedAt: num(row.updatedAt),
    history: [...stages].sort(byPosition).map((stage) => ({ stage: stage.stage, at: num(stage.at), txHash: hex(stage.txHash) as Hex32 })),
  };
}

export function resolutionRecord(row: ConditionResolution): ConditionResolutionRecord {
  return {
    conditionId: hex(row.id),
    ctfQuestionId: hex(row.ctfQuestionId),
    payoutNumerators: strings(row.payoutNumerators).map((value) => BigInt(value)),
    resolvedAt: num(row.resolvedAt),
    txHash: hex(row.txHash),
    blockNumber: row.blockNumber,
  };
}
