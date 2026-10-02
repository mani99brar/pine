// FROZEN. The read model: on-chain facts the API needs, served identically by the native indexer
// (@pine/indexer-native, SQL over Postgres) and the Envio option (@pine/read-model-envio, GraphQL over Envio/Hasura).
//
// The read model reports chain facts only. It never decides whether a claim document is canonical, whether evidence
// is admissible, or what the "right" oracle answer is. Derived oracle status is computed from facts and a caller-
// supplied `now` (unix seconds) with exactly the rules of Reality.eth v3 (see deriveOracleStatus).

import type { KlerosHomeStage } from "./chain-events.js";
import type { Address, Hex32 } from "./types.js";

export interface ClaimRecord {
  /** The Seer market address; the claim's identifier. Lowercase. */
  market: Address;
  /** ClaimRegistry that created it. */
  registry: Address;
  creator: Address;
  claimDocumentSha256: Hex32;
  policyDocumentSha256: Hex32;
  repositoryCommit: Hex32;
  questionId: Hex32;
  conditionId: Hex32;
  evidenceDeadline: number;
  revealDeadline: number;
  minBond: bigint;
  /** Untrusted on-chain text; render as plain text only. */
  marketName: string;
  /** Untrusted locator; never fetched server-side except through the content store's own IPFS gateway by CID. */
  claimDocumentUri: string;
  createdAt: number;
  createdBlock: bigint;
  createdTxHash: Hex32;
  createdLogIndex: number;
}

export type EvidenceStatus = "committed" | "revealed" | "published";

export interface EvidenceRecord {
  /** EvidenceRegistry address. (registry, submissionId) is the identifier. */
  registry: Address;
  submissionId: bigint;
  market: Address;
  submitter: Address;
  status: EvidenceStatus;
  /** Null for published submissions. */
  commitment: Hex32 | null;
  /** Null while only committed. */
  contentSha256: Hex32 | null;
  /** Locator from the reveal/publish; null while only committed. Untrusted. */
  uri: string | null;
  /** Additional locators from EvidenceMirrorAdded, in event order, at most MAX_MIRRORS (later ones are ignored). */
  mirrors: string[];
  committedAt: number;
  /** Null while only committed; equals committedAt for published submissions. */
  revealedAt: number | null;
  committedTxHash: Hex32;
  committedBlock: bigint;
  committedLogIndex: number;
}

export const MAX_MIRRORS = 16;

export interface OracleAnswerRecord {
  questionId: Hex32;
  /** For an unrevealed commitment this is the commitment id. */
  answer: Hex32;
  historyHash: Hex32;
  answerer: Address;
  bond: bigint;
  ts: number;
  isCommitment: boolean;
  /** For commitments: the revealed answer, or null while unrevealed. Equal to `answer` for plain answers. */
  revealedAnswer: Hex32 | null;
  txHash: Hex32;
  blockNumber: bigint;
  logIndex: number;
}

export interface OracleQuestionRecord {
  questionId: Hex32;
  /** Markets whose claim references this question (Seer reuses identical questions). Sorted ascending. */
  markets: Address[];
  /** Reality opening time (the claim's revealDeadline). */
  openingTs: number;
  minBond: bigint;
  /** Reality answer timeout in seconds (Seer MarketFactory.questionTimeout(), identical for reopened questions). */
  timeout: number;
  /** Current best answer (after reveals and arbitrator answers), or null when unanswered. */
  bestAnswer: Hex32 | null;
  /** Bond of the latest answer (0 when unanswered or after an arbitrator answer without bond). */
  bond: bigint;
  /** Reality finalize_ts: 0 when unanswered. */
  finalizeTs: number;
  pendingArbitration: boolean;
  arbitrationRequestedBy: Address | null;
  /** True once the arbitrator answered (Reality LogFinalize). */
  answeredByArbitrator: boolean;
  /** Total bounty (Reality `bounty` after the latest LogFundAnswerBounty). */
  bounty: bigint;
  /** Id of the question that reopened this one (it settled too soon), or null. */
  reopenedBy: Hex32 | null;
  /** Id of the question this one reopens, or null. */
  reopens: Hex32 | null;
  answerCount: number;
  lastEventBlock: bigint;
}

export interface ArbitrationRecord {
  questionId: Hex32;
  /** Latest Kleros home-proxy stage observed on the indexed chain. */
  stage: KlerosHomeStage;
  requester: Address | null;
  /** Untrusted rejection reason (RequestRejected). */
  rejectionReason: string | null;
  arbitratorAnswer: Hex32 | null;
  updatedAt: number;
  /** All stages in event order. */
  history: { stage: KlerosHomeStage; at: number; txHash: Hex32 }[];
}

export interface ConditionResolutionRecord {
  conditionId: Hex32;
  ctfQuestionId: Hex32;
  payoutNumerators: bigint[];
  resolvedAt: number;
  txHash: Hex32;
  blockNumber: bigint;
}

export interface IndexerStatus {
  backend: "native" | "envio" | "memory";
  chainId: number;
  /** Highest block whose events are fully applied. */
  indexedBlock: bigint;
  indexedBlockTimestamp: number;
  /** Chain head the indexer last observed (finalized head for the native indexer), or null if unknown. */
  headBlock: bigint | null;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null at the end. */
  nextCursor: string | null;
}

export interface ListClaimsQuery {
  creator?: Address;
  claimDocumentSha256?: Hex32;
  /** Only claims with evidenceDeadline > this (unix seconds), e.g. "open for evidence". */
  evidenceDeadlineAfter?: number;
  /** Only claims with evidenceDeadline <= this. */
  evidenceDeadlineAtOrBefore?: number;
  order: "created_desc" | "evidence_deadline_asc";
  /** 1..100 */
  limit: number;
  cursor?: string;
}

export interface ListEvidenceQuery {
  market?: Address;
  submitter?: Address;
  status?: EvidenceStatus;
  /** Ordered by (committedBlock asc, committedLogIndex asc). */
  limit: number;
  cursor?: string;
}

/**
 * Semantics every implementation must satisfy (enforced by testing/read-model-conformance.ts):
 * - Addresses and hashes are returned lowercase; bigint for uint256 values; numbers for unix seconds.
 * - getX returns null for unknown ids; list methods return stable, gap-free, duplicate-free pages; a cursor from one
 *   implementation is only valid for that implementation; an invalid cursor throws InvalidCursorError.
 * - created_desc orders by (createdBlock desc, createdLogIndex desc); evidence_deadline_asc by
 *   (evidenceDeadline asc, market asc).
 */
export interface ReadModel {
  status(): Promise<IndexerStatus>;
  getClaim(market: Address): Promise<ClaimRecord | null>;
  listClaims(query: ListClaimsQuery): Promise<Page<ClaimRecord>>;
  /** Claims whose questionId equals the given Reality question id (normally one). */
  listClaimsByQuestion(questionId: Hex32): Promise<ClaimRecord[]>;
  getEvidence(registry: Address, submissionId: bigint): Promise<EvidenceRecord | null>;
  listEvidence(query: ListEvidenceQuery): Promise<Page<EvidenceRecord>>;
  getOracleQuestion(questionId: Hex32): Promise<OracleQuestionRecord | null>;
  /** Answers in event order. */
  listOracleAnswers(questionId: Hex32): Promise<OracleAnswerRecord[]>;
  getArbitration(questionId: Hex32): Promise<ArbitrationRecord | null>;
  getConditionResolution(conditionId: Hex32): Promise<ConditionResolutionRecord | null>;
}

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid cursor");
    this.name = "InvalidCursorError";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Derived oracle status (pure; identical for every implementation)
// ---------------------------------------------------------------------------------------------------------------

export const REALITY_INVALID: Hex32 = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
export const REALITY_ANSWERED_TOO_SOON: Hex32 = "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe";

export type OracleOutcome = "yes" | "no" | "invalid" | "answered_too_soon";

export type OracleStatus =
  | { state: "not_open"; opensAt: number }
  | { state: "open_unanswered" }
  | { state: "answered"; outcome: OracleOutcome; bond: bigint; finalizesAt: number }
  | { state: "pending_arbitration"; outcome: OracleOutcome | null; requestedBy: Address | null }
  | { state: "finalized"; outcome: OracleOutcome; byArbitrator: boolean };

/** Seer categorical market with outcomes ["Yes","No"]: answer 0 = Yes, 1 = No, invalid or >= 2 = Invalid. */
export function classifyAnswer(answer: Hex32): OracleOutcome {
  const lower = answer.toLowerCase();
  if (lower === REALITY_ANSWERED_TOO_SOON) return "answered_too_soon";
  const value = BigInt(lower);
  if (value === 0n) return "yes";
  if (value === 1n) return "no";
  return "invalid";
}

/** Reality v3: finalized iff !pendingArbitration && finalizeTs > 0 && finalizeTs <= now. */
export function deriveOracleStatus(question: OracleQuestionRecord, now: number): OracleStatus {
  const outcome = question.bestAnswer === null ? null : classifyAnswer(question.bestAnswer);
  if (question.pendingArbitration) {
    return { state: "pending_arbitration", outcome, requestedBy: question.arbitrationRequestedBy };
  }
  if (question.finalizeTs > 0 && outcome !== null) {
    if (question.finalizeTs <= now) {
      return { state: "finalized", outcome, byArbitrator: question.answeredByArbitrator };
    }
    return { state: "answered", outcome, bond: question.bond, finalizesAt: question.finalizeTs };
  }
  if (now < question.openingTs) return { state: "not_open", opensAt: question.openingTs };
  return { state: "open_unanswered" };
}
