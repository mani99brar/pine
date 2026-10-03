// FROZEN. Deterministic chain-event scenarios for the read-model conformance suite and for API tests.

import { encodePacked, keccak256 } from "viem";
import type { ChainEvent, EventEnvelope, KlerosHomeStage } from "../chain-events.js";
import { REALITY_ANSWERED_TOO_SOON } from "../read-model.js";
import type { Address, Hex32 } from "../types.js";

export const SCENARIO_CHAIN_ID = 100;
export const SCENARIO_QUESTION_TIMEOUT = 302_400; // 3.5 days

export const SCENARIO_ADDRESSES = {
  claimRegistry: "0x00000000000000000000000000000000000c1a10",
  evidenceRegistry: "0x00000000000000000000000000000000000e01de",
  reality: "0xe78996a233895be74a66f451f1019ca9734205cc",
  conditionalTokens: "0xceafdd6bc0bef976fdcd1112955828e00543c0ce",
  klerosHomeProxy: "0x68154ea682f95bf582b80dd6453fa401737491dc",
} as const satisfies Record<string, Address>;

const hex32 = (seed: string): Hex32 => keccak256(encodePacked(["string"], [seed]));
const address = (seed: string): Address => `0x${keccak256(encodePacked(["string"], [seed])).slice(26)}` as Address;
const answerOf = (value: bigint): Hex32 => `0x${value.toString(16).padStart(64, "0")}` as Hex32;

/** Builds envelopes with strictly increasing (block, logIndex) and deterministic hashes and timestamps. */
export class EventBuilder {
  private block = 1_000n;
  private logIndex = 0;
  private time = 1_800_000_000;

  constructor(private readonly chainId = SCENARIO_CHAIN_ID) {}

  /** Starts a new block `seconds` later (default 5 s, one Gnosis slot). */
  nextBlock(seconds = 5): this {
    this.block += 1n;
    this.logIndex = 0;
    this.time += seconds;
    return this;
  }

  now(): number {
    return this.time;
  }

  envelope(emitter: Address, txSeed = "tx"): EventEnvelope {
    const env: EventEnvelope = {
      chainId: this.chainId,
      address: emitter,
      blockNumber: this.block,
      blockHash: hex32(`block:${this.block}`),
      blockTimestamp: this.time,
      transactionHash: hex32(`${txSeed}:${this.block}:${this.logIndex}`),
      logIndex: this.logIndex,
    };
    this.logIndex += 1;
    return env;
  }
}

export interface ClaimFixture {
  market: Address;
  creator: Address;
  questionId: Hex32;
  conditionId: Hex32;
  evidenceDeadline: number;
  revealDeadline: number;
}

export function claimCreated(b: EventBuilder, seed: string, overrides: Partial<ClaimFixture> = {}): ChainEvent & { kind: "ClaimCreated" } {
  const now = b.now();
  const fixture: ClaimFixture = {
    market: address(`market:${seed}`),
    creator: address(`creator:${seed}`),
    questionId: hex32(`question:${seed}`),
    conditionId: hex32(`condition:${seed}`),
    evidenceDeadline: now + 7 * 86_400,
    revealDeadline: now + 9 * 86_400,
    ...overrides,
  };
  return {
    ...b.envelope(SCENARIO_ADDRESSES.claimRegistry, `claim:${seed}`),
    kind: "ClaimCreated",
    market: fixture.market,
    creator: fixture.creator,
    claimDocumentSha256: hex32(`doc:${seed}`),
    policyDocumentSha256: hex32("policy:BOT-001@0.1.0"),
    repositoryId: 123_456_789,
    commit: "ab".repeat(20),
    questionId: fixture.questionId,
    conditionId: fixture.conditionId,
    evidenceDeadline: fixture.evidenceDeadline,
    revealDeadline: fixture.revealDeadline,
    minBond: 10n ** 18n,
    title: `Claim ${seed}`,
    marketName: `Pine claim [Claim ${seed}]: was a reproducible counterexample submitted?`,
    marketNameHash: hex32(`Pine claim [Claim ${seed}]: was a reproducible counterexample submitted?`),
    yesToken: address(`yes:${seed}`),
    noToken: address(`no:${seed}`),
    invalidToken: address(`invalid:${seed}`),
  };
}

export function scenarioClaimsAndEvidence(): { events: ChainEvent[]; claims: ClaimFixture[]; builder: EventBuilder } {
  const b = new EventBuilder();
  const events: ChainEvent[] = [];
  const first = claimCreated(b, "alpha");
  events.push(first);
  b.nextBlock();
  // Same Reality question and condition as alpha (Seer reuses identical questions), different market.
  const twin = claimCreated(b, "alpha-twin", { questionId: first.questionId, conditionId: first.conditionId, evidenceDeadline: first.evidenceDeadline, revealDeadline: first.revealDeadline });
  events.push(twin);
  const second = claimCreated(b, "beta", { evidenceDeadline: b.now() + 3 * 86_400, revealDeadline: b.now() + 4 * 86_400 });
  events.push(second);
  b.nextBlock();
  const researcher = address("researcher");
  const other = address("other");
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.evidenceRegistry), kind: "EvidenceCommitted", submissionId: 1n, market: first.market, submitter: researcher, commitment: hex32("c1"), committedAt: b.now() });
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.evidenceRegistry), kind: "EvidencePublished", submissionId: 2n, market: second.market, submitter: other, contentSha256: hex32("content2"), publishedAt: b.now() });
  b.nextBlock(3600);
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.evidenceRegistry), kind: "EvidenceCommitted", submissionId: 3n, market: first.market, submitter: other, commitment: hex32("c3"), committedAt: b.now() });
  b.nextBlock(86_400);
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.evidenceRegistry), kind: "EvidenceRevealed", submissionId: 1n, market: first.market, submitter: researcher, contentSha256: hex32("content1"), committedAt: b.now() - 86_400 - 3_605, revealedAt: b.now() });
  // A reveal for an id that was never committed is ignored, never a crash.
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.evidenceRegistry), kind: "EvidenceRevealed", submissionId: 99n, market: first.market, submitter: researcher, contentSha256: hex32("ghost"), committedAt: 1, revealedAt: b.now() });
  // A second reveal of an already revealed submission is ignored (the registry reverts it; defensive).
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.evidenceRegistry), kind: "EvidenceRevealed", submissionId: 1n, market: first.market, submitter: researcher, contentSha256: hex32("other-content"), committedAt: 1, revealedAt: b.now() });
  return { events, claims: [first, twin, second].map(toFixture), builder: b };
}

function toFixture(event: ChainEvent & { kind: "ClaimCreated" }): ClaimFixture {
  return { market: event.market, creator: event.creator, questionId: event.questionId, conditionId: event.conditionId, evidenceDeadline: event.evidenceDeadline, revealDeadline: event.revealDeadline };
}

/** Oracle lifecycle on one claim: bond escalation, committed answers, arbitration cancel/answer, bounty, resolution. */
export function scenarioOracle(): { events: ChainEvent[]; claim: ClaimFixture; builder: EventBuilder; reopenedQuestionId: Hex32 } {
  const b = new EventBuilder();
  const events: ChainEvent[] = [];
  const created = claimCreated(b, "gamma");
  events.push(created);
  const q = created.questionId;
  const alice = address("alice");
  const bob = address("bob");
  const carol = address("carol");
  b.nextBlock(created.revealDeadline - b.now() + 60);
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityBountyFunded", questionId: q, bountyAdded: 5n * 10n ** 17n, bounty: 5n * 10n ** 17n, user: created.creator });
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityNewAnswer", questionId: q, answer: answerOf(1n), historyHash: hex32("h1"), user: alice, bond: 10n ** 18n, ts: b.now(), isCommitment: false });
  b.nextBlock(3_600);
  // Untracked question: ignored.
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityNewAnswer", questionId: hex32("untracked"), answer: answerOf(0n), historyHash: hex32("hx"), user: bob, bond: 10n ** 18n, ts: b.now(), isCommitment: false });
  // Bob commits to an answer with a doubled bond (does not change best answer or finalize_ts).
  const answerHash = keccak256(encodePacked(["bytes32", "uint256"], [answerOf(0n), 42n]));
  const commitmentId = keccak256(encodePacked(["bytes32", "bytes32", "uint256"], [q, answerHash, 2n * 10n ** 18n]));
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityNewAnswer", questionId: q, answer: commitmentId, historyHash: hex32("h2"), user: bob, bond: 2n * 10n ** 18n, ts: b.now(), isCommitment: true });
  b.nextBlock(600);
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityAnswerReveal", questionId: q, user: bob, answerHash, answer: answerOf(0n), nonce: 42n, bond: 2n * 10n ** 18n });
  b.nextBlock(7_200);
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityNewAnswer", questionId: q, answer: answerOf(1n), historyHash: hex32("h3"), user: carol, bond: 4n * 10n ** 18n, ts: b.now(), isCommitment: false });
  b.nextBlock(3_600);
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.klerosHomeProxy), kind: "KlerosHome", stage: "RequestNotified", questionId: q, requester: bob, maxPrevious: 4n * 10n ** 18n, reason: null, answer: null });
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityArbitrationRequested", questionId: q, user: bob });
  b.nextBlock(600);
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.klerosHomeProxy), kind: "KlerosHome", stage: "RequestCanceled", questionId: q, requester: bob, maxPrevious: null, reason: null, answer: null });
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityArbitrationCancelled", questionId: q });
  b.nextBlock(600);
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.klerosHomeProxy), kind: "KlerosHome", stage: "RequestNotified", questionId: q, requester: bob, maxPrevious: 0n, reason: null, answer: null });
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityArbitrationRequested", questionId: q, user: bob });
  b.nextBlock(1_200);
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.klerosHomeProxy), kind: "KlerosHome", stage: "RequestAcknowledged", questionId: q, requester: bob, maxPrevious: null, reason: null, answer: null });
  b.nextBlock(5 * 86_400);
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.klerosHomeProxy), kind: "KlerosHome", stage: "ArbitratorAnswered", questionId: q, requester: null, maxPrevious: null, reason: null, answer: answerOf(0n) });
  b.nextBlock(60);
  // submitAnswerByArbitrator: LogFinalize then a bond-0 LogNewAnswer in the same transaction.
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality, "arb"), kind: "RealityArbitratorAnswered", questionId: q, answer: answerOf(0n) });
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality, "arb"), kind: "RealityNewAnswer", questionId: q, answer: answerOf(0n), historyHash: hex32("h4"), user: bob, bond: 0n, ts: b.now(), isCommitment: false });
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.klerosHomeProxy, "arb"), kind: "KlerosHome", stage: "ArbitrationFinished", questionId: q, requester: null, maxPrevious: null, reason: null, answer: null });
  b.nextBlock(60);
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.conditionalTokens), kind: "ConditionResolution", conditionId: created.conditionId, oracle: address("realityProxy"), ctfQuestionId: hex32("ctfq:gamma"), outcomeSlotCount: 3, payoutNumerators: [1n, 0n, 0n] });
  // Resolution of an untracked condition: ignored.
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.conditionalTokens), kind: "ConditionResolution", conditionId: hex32("untracked-condition"), oracle: address("realityProxy"), ctfQuestionId: hex32("x"), outcomeSlotCount: 3, payoutNumerators: [0n, 1n, 0n] });

  // A second claim whose question settles "answered too soon" and is reopened.
  b.nextBlock();
  const delta = claimCreated(b, "delta");
  events.push(delta);
  b.nextBlock(delta.revealDeadline - b.now() + 10);
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityNewAnswer", questionId: delta.questionId, answer: REALITY_ANSWERED_TOO_SOON, historyHash: hex32("d1"), user: alice, bond: 10n ** 18n, ts: b.now(), isCommitment: false });
  b.nextBlock(SCENARIO_QUESTION_TIMEOUT + 10);
  const reopenedQuestionId = hex32("question:delta:reopened");
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityQuestionReopened", questionId: reopenedQuestionId, reopenedQuestionId: delta.questionId });
  b.nextBlock(30);
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityNewAnswer", questionId: reopenedQuestionId, answer: answerOf(1n), historyHash: hex32("d2"), user: carol, bond: 10n ** 18n, ts: b.now(), isCommitment: false });
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.klerosHomeProxy), kind: "KlerosHome", stage: "RequestRejected", questionId: reopenedQuestionId, requester: bob, maxPrevious: 1n, reason: "Bond has changed", answer: null });
  return { events, claim: toFixture(created), builder: b, reopenedQuestionId };
}

/** Many claims for pagination and filter checks. */
export function scenarioManyClaims(count = 23): { events: ChainEvent[]; creators: Address[] } {
  const b = new EventBuilder();
  const events: ChainEvent[] = [];
  const creators = [address("creator-a"), address("creator-b"), address("creator-c")];
  for (let index = 0; index < count; index += 1) {
    if (index % 4 === 0) b.nextBlock();
    events.push(
      claimCreated(b, `many-${index}`, {
        creator: creators[index % creators.length]!,
        // Deadlines collide in pairs to exercise the (deadline, market) tie-break.
        evidenceDeadline: 1_900_000_000 + Math.floor(index / 2) * 3_600,
        revealDeadline: 1_900_200_000 + index,
      }),
    );
  }
  return { events, creators };
}

export const KLEROS_STAGES: readonly KlerosHomeStage[] = [
  "RequestNotified",
  "RequestRejected",
  "RequestAcknowledged",
  "RequestCanceled",
  "ArbitrationFailed",
  "ArbitratorAnswered",
  "ArbitrationFinished",
];
