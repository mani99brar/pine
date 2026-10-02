// FROZEN. Normalized, decoded chain events: the ingestion contract shared by both indexers and the in-memory
// reference read model. Each indexer decodes raw logs into these shapes and applies them with the semantics in
// testing/memory-read-model.ts (the executable specification), in (blockNumber, logIndex) order, exactly once.
//
// Sources (all on the configured chain, Gnosis = 100):
//   ClaimRegistry          ClaimCreated
//   EvidenceRegistry       EvidenceCommitted, EvidenceRevealed, EvidencePublished
//   Reality.eth v3         LogNewAnswer, LogAnswerReveal, LogNotifyOfArbitrationRequest, LogCancelArbitration,
//                          LogFinalize, LogReopenQuestion, LogFundAnswerBounty   (only for tracked question ids)
//   ConditionalTokens      ConditionResolution                                     (only for tracked condition ids)
//   Kleros home proxy      RequestNotified, RequestRejected, RequestAcknowledged, RequestCanceled, ArbitrationFailed,
//                          ArbitratorAnswered, ArbitrationFinished                 (only for tracked question ids)
// Tracked ids: every ClaimCreated adds its questionId and conditionId; every LogReopenQuestion whose
// reopened_question_id is tracked adds its new question_id.

import type { Address, Hex32 } from "./types.js";

export interface EventEnvelope {
  chainId: number;
  /** Emitting contract, lowercase. */
  address: Address;
  blockNumber: bigint;
  blockHash: Hex32;
  /** Block timestamp, unix seconds. */
  blockTimestamp: number;
  transactionHash: Hex32;
  /** Position of the log in the block. */
  logIndex: number;
}

export interface ClaimCreatedEvent extends EventEnvelope {
  kind: "ClaimCreated";
  market: Address;
  creator: Address;
  claimDocumentSha256: Hex32;
  policyDocumentSha256: Hex32;
  /** GitHub numeric repository id (uint64 on-chain; < 2^53 in practice, enforced by decoders). */
  repositoryId: number;
  /** 40 lowercase hex characters, no 0x (bytes20 on-chain). */
  commit: string;
  questionId: Hex32;
  conditionId: Hex32;
  evidenceDeadline: number;
  revealDeadline: number;
  minBond: bigint;
  title: string;
  /** The question composed on-chain by the registry. */
  marketName: string;
  /** keccak256 of marketName (from the event's Claim struct). */
  marketNameHash: Hex32;
  /** Wrapped outcome tokens (Yes, No, Invalid), lowercase. */
  yesToken: Address;
  noToken: Address;
  invalidToken: Address;
}

export interface EvidenceCommittedEvent extends EventEnvelope {
  kind: "EvidenceCommitted";
  submissionId: bigint;
  market: Address;
  submitter: Address;
  commitment: Hex32;
  committedAt: number;
}

export interface EvidenceRevealedEvent extends EventEnvelope {
  kind: "EvidenceRevealed";
  submissionId: bigint;
  market: Address;
  submitter: Address;
  contentSha256: Hex32;
  committedAt: number;
  revealedAt: number;
}

export interface EvidencePublishedEvent extends EventEnvelope {
  kind: "EvidencePublished";
  submissionId: bigint;
  market: Address;
  submitter: Address;
  contentSha256: Hex32;
  publishedAt: number;
}

/** Reality LogNewAnswer. For a commitment (isCommitment), `answer` is the commitment id until LogAnswerReveal. */
export interface RealityNewAnswerEvent extends EventEnvelope {
  kind: "RealityNewAnswer";
  questionId: Hex32;
  answer: Hex32;
  historyHash: Hex32;
  user: Address;
  bond: bigint;
  /** Reality's `ts` field: block timestamp of the answer. */
  ts: number;
  isCommitment: boolean;
}

export interface RealityAnswerRevealEvent extends EventEnvelope {
  kind: "RealityAnswerReveal";
  questionId: Hex32;
  user: Address;
  answerHash: Hex32;
  answer: Hex32;
  nonce: bigint;
  bond: bigint;
}

export interface RealityArbitrationRequestedEvent extends EventEnvelope {
  kind: "RealityArbitrationRequested";
  questionId: Hex32;
  user: Address;
}

export interface RealityArbitrationCancelledEvent extends EventEnvelope {
  kind: "RealityArbitrationCancelled";
  questionId: Hex32;
}

/** Reality LogFinalize: emitted only when the arbitrator submits the answer. */
export interface RealityArbitratorAnsweredEvent extends EventEnvelope {
  kind: "RealityArbitratorAnswered";
  questionId: Hex32;
  answer: Hex32;
}

/** Reality LogReopenQuestion(question_id = new question, reopened_question_id = the question settled too soon). */
export interface RealityQuestionReopenedEvent extends EventEnvelope {
  kind: "RealityQuestionReopened";
  questionId: Hex32;
  reopenedQuestionId: Hex32;
}

export interface RealityBountyFundedEvent extends EventEnvelope {
  kind: "RealityBountyFunded";
  questionId: Hex32;
  bountyAdded: bigint;
  bounty: bigint;
  user: Address;
}

export interface ConditionResolutionEvent extends EventEnvelope {
  kind: "ConditionResolution";
  conditionId: Hex32;
  oracle: Address;
  /** CTF question id (Seer's hash over the Reality question ids), not the Reality question id. */
  ctfQuestionId: Hex32;
  outcomeSlotCount: number;
  payoutNumerators: bigint[];
}

export type KlerosHomeStage =
  | "RequestNotified"
  | "RequestRejected"
  | "RequestAcknowledged"
  | "RequestCanceled"
  | "ArbitrationFailed"
  | "ArbitratorAnswered"
  | "ArbitrationFinished";

export interface KlerosHomeEvent extends EventEnvelope {
  kind: "KlerosHome";
  stage: KlerosHomeStage;
  questionId: Hex32;
  /** Present for RequestNotified, RequestRejected, RequestAcknowledged, RequestCanceled, ArbitrationFailed. */
  requester: Address | null;
  /** Present for RequestNotified and RequestRejected. */
  maxPrevious: bigint | null;
  /** Present for RequestRejected. Untrusted text from chain; display as plain text only. */
  reason: string | null;
  /** Present for ArbitratorAnswered. */
  answer: Hex32 | null;
}

export type ChainEvent =
  | ClaimCreatedEvent
  | EvidenceCommittedEvent
  | EvidenceRevealedEvent
  | EvidencePublishedEvent
  | RealityNewAnswerEvent
  | RealityAnswerRevealEvent
  | RealityArbitrationRequestedEvent
  | RealityArbitrationCancelledEvent
  | RealityArbitratorAnsweredEvent
  | RealityQuestionReopenedEvent
  | RealityBountyFundedEvent
  | ConditionResolutionEvent
  | KlerosHomeEvent;

export type ChainEventKind = ChainEvent["kind"];

/** Total order used for application: (blockNumber, logIndex). */
export function compareEvents(a: EventEnvelope, b: EventEnvelope): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

/** Stable unique id of an event: chainId:blockHash:logIndex is unique even across reorgs. */
export function eventId(event: EventEnvelope): string {
  return `${event.chainId}:${event.blockHash}:${event.logIndex}`;
}
