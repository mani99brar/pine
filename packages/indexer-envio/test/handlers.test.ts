import "./lock.js";

// Edge cases of the reference semantics beyond the frozen scenarios (differential against MemoryReadModel), the
// halting domain checks on Pine events, and the ingestion boundaries (look-alike emitters, third-party values).

import { createTestIndexer } from "envio";
import { encodePacked, getAddress, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { ChainEvent } from "@pine/shared/chain-events";
import { EventBuilder, SCENARIO_ADDRESSES, claimCreated } from "@pine/shared/testing/read-model-scenarios";
import type { Address, Hex32 } from "@pine/shared/types";
import { allEntities, expectEquivalent, runEnvio } from "./differential.js";
import { toSimulateItem, type SimulateItem } from "./simulate.js";

const h = (seed: string): Hex32 => keccak256(encodePacked(["string"], [seed]));
const a = (seed: string): Address => `0x${h(seed).slice(26)}` as Address;
const answerOf = (value: bigint): Hex32 => `0x${value.toString(16).padStart(64, "0")}` as Hex32;
const R = SCENARIO_ADDRESSES.reality;
const K = SCENARIO_ADDRESSES.klerosHomeProxy;
const E = SCENARIO_ADDRESSES.evidenceRegistry;
const C = SCENARIO_ADDRESSES.conditionalTokens;

function edgeEvents(): ChainEvent[] {
  const b = new EventBuilder();
  const events: ChainEvent[] = [];
  const first = claimCreated(b, "edge-a");
  const other = claimCreated(b, "edge-b");
  events.push(first, other);
  b.nextBlock();
  // Duplicate ClaimCreated for a known market: first wins (fields of the second differ).
  events.push(claimCreated(b, "edge-a", { evidenceDeadline: 1, revealDeadline: 2 }));
  // Another market on the same question and condition: markets merge, condition stays tracked once.
  events.push(claimCreated(b, "edge-c", { questionId: first.questionId, conditionId: first.conditionId }));
  // Duplicate ClaimCreated for a known market naming a NEW question and condition: ignored entirely, so neither becomes
  // tracked (the answer and resolution on them below are ignored by the reference).
  const duplicateQuestion = h("duplicate-question");
  const duplicateCondition = h("duplicate-condition");
  events.push(claimCreated(b, "edge-b", { questionId: duplicateQuestion, conditionId: duplicateCondition }));
  b.nextBlock(first.revealDeadline - b.now() + 1);
  const q = first.questionId;
  const user = a("user");
  // Two commitments with the same commitment id: a reveal updates only the first (the reference's `find`).
  const answerHash = keccak256(encodePacked(["bytes32", "uint256"], [answerOf(1n), 7n]));
  const commitmentId = keccak256(encodePacked(["bytes32", "bytes32", "uint256"], [q, answerHash, 3n]));
  events.push({ ...b.envelope(R), kind: "RealityNewAnswer", questionId: q, answer: commitmentId, historyHash: h("e1"), user, bond: 3n, ts: b.now(), isCommitment: true });
  events.push({ ...b.envelope(R), kind: "RealityNewAnswer", questionId: q, answer: commitmentId, historyHash: h("e2"), user, bond: 3n, ts: b.now(), isCommitment: true });
  b.nextBlock();
  events.push({ ...b.envelope(R), kind: "RealityNewAnswer", questionId: q, answer: answerOf(0n), historyHash: h("e3"), user, bond: 6n, ts: b.now(), isCommitment: false });
  b.nextBlock();
  // Reveal of a superseded bond: the commitment records its answer, the best answer and finalize_ts do not change.
  events.push({ ...b.envelope(R), kind: "RealityAnswerReveal", questionId: q, user, answerHash, answer: answerOf(1n), nonce: 7n, bond: 3n });
  // Reveal matching no commitment but the current bond: best answer and finalize_ts change.
  events.push({ ...b.envelope(R), kind: "RealityAnswerReveal", questionId: q, user, answerHash: h("nothing"), answer: answerOf(2n), nonce: 1n, bond: 6n });
  // Reveal for an untracked question: ignored.
  events.push({ ...b.envelope(R), kind: "RealityAnswerReveal", questionId: h("untracked"), user, answerHash, answer: answerOf(1n), nonce: 7n, bond: 3n });
  b.nextBlock();
  // Reopen into an already tracked question: the original records the link, the replacement is not overwritten.
  events.push({ ...b.envelope(R), kind: "RealityQuestionReopened", questionId: other.questionId, reopenedQuestionId: q });
  // Reopen of an untracked question: ignored, and the replacement does not become tracked.
  events.push({ ...b.envelope(R), kind: "RealityQuestionReopened", questionId: h("replacement-untracked"), reopenedQuestionId: h("untracked") });
  events.push({ ...b.envelope(R), kind: "RealityBountyFunded", questionId: h("replacement-untracked"), bountyAdded: 1n, bounty: 1n, user });
  b.nextBlock();
  events.push({ ...b.envelope(K), kind: "KlerosHome", stage: "RequestRejected", questionId: q, requester: user, maxPrevious: 6n, reason: "", answer: null });
  events.push({ ...b.envelope(K), kind: "KlerosHome", stage: "ArbitrationFailed", questionId: q, requester: a("someone"), maxPrevious: null, reason: null, answer: null });
  events.push({ ...b.envelope(K), kind: "KlerosHome", stage: "ArbitratorAnswered", questionId: q, requester: null, maxPrevious: null, reason: null, answer: answerOf(1n) });
  events.push({ ...b.envelope(K), kind: "KlerosHome", stage: "RequestNotified", questionId: h("untracked"), requester: user, maxPrevious: 0n, reason: null, answer: null });
  events.push({ ...b.envelope(R), kind: "RealityArbitrationRequested", questionId: q, user });
  events.push({ ...b.envelope(R), kind: "RealityArbitrationCancelled", questionId: q });
  b.nextBlock();
  // Events on the question and condition named only by the duplicate ClaimCreated: untracked, ignored.
  events.push({ ...b.envelope(R), kind: "RealityNewAnswer", questionId: duplicateQuestion, answer: answerOf(1n), historyHash: h("dq"), user, bond: 9n, ts: b.now(), isCommitment: false });
  events.push({ ...b.envelope(C), kind: "ConditionResolution", conditionId: duplicateCondition, oracle: a("oracle"), ctfQuestionId: h("dc"), outcomeSlotCount: 2, payoutNumerators: [1n, 0n] });
  // Resolution: first wins.
  events.push({ ...b.envelope(C), kind: "ConditionResolution", conditionId: first.conditionId, oracle: a("oracle"), ctfQuestionId: h("ctf"), outcomeSlotCount: 3, payoutNumerators: [0n, 0n, 1n] });
  events.push({ ...b.envelope(C), kind: "ConditionResolution", conditionId: first.conditionId, oracle: a("oracle"), ctfQuestionId: h("ctf2"), outcomeSlotCount: 3, payoutNumerators: [1n, 0n, 0n] });
  b.nextBlock();
  // Evidence: duplicates and reveals of published submissions are ignored.
  events.push({ ...b.envelope(E), kind: "EvidencePublished", submissionId: 5n, market: first.market, submitter: user, contentSha256: h("p5"), publishedAt: b.now() });
  events.push({ ...b.envelope(E), kind: "EvidencePublished", submissionId: 5n, market: other.market, submitter: user, contentSha256: h("p5b"), publishedAt: b.now() });
  events.push({ ...b.envelope(E), kind: "EvidenceCommitted", submissionId: 5n, market: first.market, submitter: user, commitment: h("c5"), committedAt: b.now() });
  events.push({ ...b.envelope(E), kind: "EvidenceRevealed", submissionId: 5n, market: first.market, submitter: user, contentSha256: h("r5"), committedAt: b.now(), revealedAt: b.now() });
  events.push({ ...b.envelope(E), kind: "EvidenceCommitted", submissionId: 6n, market: other.market, submitter: user, commitment: h("c6"), committedAt: b.now() });
  events.push({ ...b.envelope(E), kind: "EvidenceCommitted", submissionId: 6n, market: first.market, submitter: a("x"), commitment: h("c6b"), committedAt: b.now() });
  // A publication over an already COMMITTED submission is ignored too (the submission stays committed).
  events.push({ ...b.envelope(E), kind: "EvidencePublished", submissionId: 6n, market: first.market, submitter: user, contentSha256: h("p6"), publishedAt: b.now() });
  return events;
}

const process100 = (items: SimulateItem[]) => {
  const indexer = createTestIndexer();
  return { indexer, run: indexer.process({ chains: { 100: { simulate: items } } }) };
};

function withClaimParams(event: ChainEvent & { kind: "ClaimCreated" }, patch: Record<string, bigint>): SimulateItem {
  const item = toSimulateItem(event);
  if (item.contract !== "ClaimRegistry" || !item.params?.claim) throw new Error("not a ClaimCreated item");
  return { ...item, params: { ...item.params, claim: { ...item.params.claim, ...patch } } };
}

describe("handlers: reference edge cases", () => {
  it("duplicates, superseded reveals, reopen into a tracked question, Kleros stages and first-wins resolution match the reference", async () => {
    const events = edgeEvents();
    const indexer = await runEnvio(events);
    await expectEquivalent(events, indexer);
    // Pinned explicitly (the reference agrees): the duplicate ClaimCreated tracked nothing, and the publication over a
    // committed submission left it committed.
    expect(await indexer.OracleQuestion.get(h("duplicate-question"))).toBeUndefined();
    expect(await indexer.TrackedCondition.get(h("duplicate-condition"))).toBeUndefined();
    expect(await indexer.ConditionResolution.get(h("duplicate-condition"))).toBeUndefined();
    expect((await indexer.EvidenceSubmission.getOrThrow(`${E}:6`)).status).toBe("committed");
  });

  it("mixed-case ids, answers, hashes and checksummed addresses are stored lowercase, as the reference stores them", async () => {
    const upper = (value: Hex32): Hex32 => `0x${value.slice(2).toUpperCase()}` as Hex32;
    const b = new EventBuilder();
    const base = claimCreated(b, "case");
    const claim: ChainEvent = {
      ...base,
      transactionHash: upper(base.transactionHash),
      market: getAddress(base.market),
      creator: getAddress(base.creator),
      claimDocumentSha256: upper(base.claimDocumentSha256),
      policyDocumentSha256: upper(base.policyDocumentSha256),
      questionId: upper(base.questionId),
      conditionId: upper(base.conditionId),
      marketNameHash: upper(base.marketNameHash),
      yesToken: getAddress(base.yesToken),
      commit: base.commit.toUpperCase(),
    };
    b.nextBlock(base.revealDeadline - b.now() + 1);
    const user = getAddress(a("case-user"));
    const events: ChainEvent[] = [
      claim,
      { ...b.envelope(R), transactionHash: upper(h("case-tx")), kind: "RealityNewAnswer", questionId: upper(base.questionId), answer: upper(answerOf(10n)), historyHash: upper(h("ch")), user, bond: 2n, ts: b.now(), isCommitment: false },
      { ...b.envelope(R), kind: "RealityArbitrationRequested", questionId: upper(base.questionId), user },
      { ...b.envelope(K), kind: "KlerosHome", stage: "ArbitratorAnswered", questionId: upper(base.questionId), requester: null, maxPrevious: null, reason: null, answer: upper(answerOf(11n)) },
      { ...b.envelope(R), kind: "RealityArbitratorAnswered", questionId: upper(base.questionId), answer: upper(answerOf(11n)) },
      { ...b.envelope(C), kind: "ConditionResolution", conditionId: upper(base.conditionId), oracle: user, ctfQuestionId: upper(h("cq")), outcomeSlotCount: 2, payoutNumerators: [0n, 1n] },
      { ...b.envelope(E), kind: "EvidenceCommitted", submissionId: 3n, market: getAddress(base.market), submitter: user, commitment: upper(h("cc")), committedAt: b.now() },
    ];
    const indexer = await runEnvio(events);
    await expectEquivalent(events, indexer);
    const rows = await allEntities(indexer);
    const text = JSON.stringify(rows, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
    // Every stored hex value is lowercase (the title and market name are free text without hex).
    expect(text.match(/0x[0-9a-fA-F]*[A-F][0-9a-fA-F]*/g) ?? []).toEqual([]);
    expect(rows.Claim.map((row) => row.id)).toEqual([base.market]);
    expect((await indexer.Claim.getOrThrow(base.market)).commit).toBe(base.commit.toLowerCase());
  });

  it("events of untracked ids create no rows and only advance the progress marker", async () => {
    const b = new EventBuilder();
    b.nextBlock();
    const events: ChainEvent[] = [
      { ...b.envelope(R), kind: "RealityNewAnswer", questionId: h("nobody"), answer: answerOf(1n), historyHash: h("x"), user: a("u"), bond: 1n, ts: b.now(), isCommitment: false },
      { ...b.envelope(C), kind: "ConditionResolution", conditionId: h("nobody-c"), oracle: a("o"), ctfQuestionId: h("q"), outcomeSlotCount: 2, payoutNumerators: [1n, 0n] },
      { ...b.envelope(K), kind: "KlerosHome", stage: "ArbitrationFinished", questionId: h("nobody"), requester: null, maxPrevious: null, reason: null, answer: null },
      // Anyone can create a Reality question naming themselves arbitrator and emit these for ids Pine does not track.
      { ...b.envelope(R), kind: "RealityArbitrationRequested", questionId: h("nobody"), user: a("u") },
      { ...b.envelope(R), kind: "RealityArbitrationCancelled", questionId: h("nobody") },
      { ...b.envelope(R), kind: "RealityArbitratorAnswered", questionId: h("nobody"), answer: answerOf(1n) },
      { ...b.envelope(R), kind: "RealityAnswerReveal", questionId: h("nobody"), user: a("u"), answerHash: h("ah"), answer: answerOf(1n), nonce: 1n, bond: 1n },
      { ...b.envelope(R), kind: "RealityBountyFunded", questionId: h("nobody"), bountyAdded: 1n, bounty: 1n, user: a("u") },
    ];
    // ...and a later answer on the same id is still ignored (none of the above made it tracked).
    b.nextBlock();
    events.push({ ...b.envelope(R), kind: "RealityNewAnswer", questionId: h("nobody"), answer: answerOf(2n), historyHash: h("y"), user: a("u"), bond: 2n, ts: b.now(), isCommitment: false });
    const indexer = await runEnvio(events);
    await expectEquivalent(events, indexer);
    const rows = await allEntities(indexer);
    for (const entity of ["OracleQuestion", "OracleAnswer", "Arbitration", "ArbitrationStage", "ConditionResolution", "TrackedCondition", "AnswerCommitment", "Claim"] as const) {
      expect(rows[entity], entity).toEqual([]);
    }
    expect(await indexer.IndexerProgress.get("100")).toEqual({ id: "100", blockNumber: 1002n, blockTimestamp: BigInt(b.now()) });
  });
});

describe("handlers: Pine events outside the frozen ChainEvent domain halt", () => {
  const b = new EventBuilder();
  const claim = claimCreated(b, "domain");
  for (const [label, patch] of [
    ["repositoryId 0", { repositoryId: 0n }],
    ["repositoryId 2^53", { repositoryId: 2n ** 53n }],
    ["evidenceDeadline 2^53", { evidenceDeadline: 2n ** 53n }],
    ["revealDeadline 2^64-1", { revealDeadline: 2n ** 64n - 1n }],
  ] as const) {
    it(`SEC-IDX ClaimCreated with ${label} stops processing`, async () => {
      const { indexer, run } = process100([withClaimParams(claim, patch)]);
      await expect(run).rejects.toThrow(/out of the ChainEvent domain/);
      expect(await indexer.Claim.getAll()).toEqual([]);
    });
  }

  it("SEC-IDX EvidenceCommitted with committedAt 2^53 stops processing", async () => {
    const item = toSimulateItem({ ...b.envelope(E), kind: "EvidenceCommitted", submissionId: 1n, market: claim.market, submitter: a("s"), commitment: h("c"), committedAt: 0 });
    if (item.contract !== "EvidenceRegistry" || item.event !== "EvidenceCommitted") throw new Error("unexpected item");
    const { indexer, run } = process100([{ ...item, params: { ...item.params, committedAt: 2n ** 53n } }]);
    await expect(run).rejects.toThrow(/out of the ChainEvent domain/);
    expect(await indexer.EvidenceSubmission.getAll()).toEqual([]);
  });

  const committed = toSimulateItem({ ...b.envelope(E), kind: "EvidenceCommitted", submissionId: 2n, market: claim.market, submitter: a("s"), commitment: h("c2"), committedAt: 1 });
  // Each builder call moves to a later block than `committed` (process() only accepts blocks past the last processed one).
  const revealed = (committedAt: bigint, revealedAt: bigint): SimulateItem => {
    b.nextBlock();
    const item = toSimulateItem({ ...b.envelope(E), kind: "EvidenceRevealed", submissionId: 2n, market: claim.market, submitter: a("s"), contentSha256: h("r2"), committedAt: 0, revealedAt: 0 });
    if (item.contract !== "EvidenceRegistry" || item.event !== "EvidenceRevealed") throw new Error("unexpected item");
    return { ...item, params: { ...item.params, committedAt, revealedAt } };
  };
  const published = (publishedAt: bigint): SimulateItem => {
    b.nextBlock();
    const item = toSimulateItem({ ...b.envelope(E), kind: "EvidencePublished", submissionId: 3n, market: claim.market, submitter: a("s"), contentSha256: h("p3"), publishedAt: 0 });
    if (item.contract !== "EvidenceRegistry" || item.event !== "EvidencePublished") throw new Error("unexpected item");
    return { ...item, params: { ...item.params, publishedAt } };
  };

  for (const [label, committedAt, revealedAt] of [
    ["revealedAt 2^53", 1n, 2n ** 53n],
    ["committedAt 2^53", 2n ** 53n, 1n],
  ] as const) {
    it(`SEC-IDX EvidenceRevealed with ${label} on a committed submission stops processing and leaves it committed`, async () => {
      const indexer = createTestIndexer();
      await indexer.process({ chains: { 100: { simulate: [committed] } } });
      const before = await indexer.EvidenceSubmission.getAll();
      expect(before.map((row) => row.status)).toEqual(["committed"]);
      await expect(indexer.process({ chains: { 100: { simulate: [revealed(committedAt, revealedAt)] } } })).rejects.toThrow(/out of the ChainEvent domain/);
      expect(await indexer.EvidenceSubmission.getAll()).toEqual(before);
    });
  }

  it("SEC-IDX EvidencePublished with publishedAt 2^53 stops processing", async () => {
    const { indexer, run } = process100([published(2n ** 53n)]);
    await expect(run).rejects.toThrow(/out of the ChainEvent domain/);
    expect(await indexer.EvidenceSubmission.getAll()).toEqual([]);
  });

  for (const [label, commit] of [
    ["19 bytes", `0x${"ab".repeat(19)}`],
    ["0x plus 38 hex characters plus one", `0x${"a".repeat(39)}`],
    ["21 bytes", `0x${"ab".repeat(21)}`],
  ] as const) {
    it(`SEC-IDX ClaimCreated whose commit is not bytes20 (${label}) stops processing`, async () => {
      const item = toSimulateItem(claim);
      if (item.contract !== "ClaimRegistry" || !item.params?.claim) throw new Error("not a ClaimCreated item");
      const { indexer, run } = process100([{ ...item, params: { ...item.params, claim: { ...item.params.claim, commit } } }]);
      await expect(run).rejects.toThrow(/commit is not a bytes20 value/);
      expect(await indexer.Claim.getAll()).toEqual([]);
      expect(await indexer.OracleQuestion.getAll()).toEqual([]);
    });
  }

  it("evidence timestamps of exactly 2^53 - 1 are accepted", async () => {
    const max = 2n ** 53n - 1n;
    const { indexer, run } = process100([committed, revealed(max, max), published(max)]);
    await run;
    expect((await indexer.EvidenceSubmission.getOrThrow(`${E}:2`)).revealedAt).toBe(max);
    expect((await indexer.EvidenceSubmission.getOrThrow(`${E}:3`)).committedAt).toBe(max);
  });

  it("a repositoryId of exactly 2^53 - 1 is accepted", async () => {
    const { indexer, run } = process100([withClaimParams(claim, { repositoryId: 2n ** 53n - 1n })]);
    await run;
    expect((await indexer.Claim.get(claim.market))?.repositoryId).toBe(2n ** 53n - 1n);
  });
});

describe("handlers: block timestamps", () => {
  it("SEC-IDX-10 createdAt, resolvedAt and arbitration times are block timestamps, not values carried in the event", async () => {
    const b = new EventBuilder();
    const claim = claimCreated(b, "times");
    b.nextBlock(777);
    const resolution: ChainEvent = { ...b.envelope(C), kind: "ConditionResolution", conditionId: claim.conditionId, oracle: a("o"), ctfQuestionId: h("t"), outcomeSlotCount: 2, payoutNumerators: [1n, 0n] };
    const stage: ChainEvent = { ...b.envelope(K), kind: "KlerosHome", stage: "ArbitrationFinished", questionId: claim.questionId, requester: null, maxPrevious: null, reason: null, answer: null };
    const { indexer, run } = process100([withClaimParams(claim, { createdAt: 1n }), toSimulateItem(resolution), toSimulateItem(stage)]);
    await run;
    expect((await indexer.Claim.getOrThrow(claim.market)).createdAt).toBe(BigInt(claim.blockTimestamp));
    expect((await indexer.ConditionResolution.getOrThrow(claim.conditionId)).resolvedAt).toBe(BigInt(resolution.blockTimestamp));
    expect((await indexer.Arbitration.getOrThrow(claim.questionId)).updatedAt).toBe(BigInt(stage.blockTimestamp));
    expect(resolution.blockTimestamp - claim.blockTimestamp).toBe(777);
  });
});

describe("handlers: ingestion boundaries", () => {
  it("SEC-IDX-05 an identical event from a look-alike contract never reaches a handler", async () => {
    const b = new EventBuilder();
    const forged = { ...claimCreated(b, "forged"), address: a("look-alike") };
    const { indexer, run } = process100([toSimulateItem(forged)]);
    await expect(run).rejects.toThrow(/never reached a handler/);
    expect(await indexer.Claim.getAll()).toEqual([]);
  });

  it("SEC-IDX-05 tracked-id events of every other source from a look-alike contract never reach a handler (the genuine ones apply)", async () => {
    const b = new EventBuilder();
    const claim = claimCreated(b, "lookalike");
    b.nextBlock();
    const user = a("u");
    const genuine: ChainEvent[] = [
      { ...b.envelope(E), kind: "EvidenceCommitted", submissionId: 1n, market: claim.market, submitter: user, commitment: h("lc"), committedAt: b.now() },
      { ...b.envelope(E), kind: "EvidencePublished", submissionId: 2n, market: claim.market, submitter: user, contentSha256: h("lp"), publishedAt: b.now() },
      { ...b.envelope(R), kind: "RealityNewAnswer", questionId: claim.questionId, answer: answerOf(1n), historyHash: h("lh"), user, bond: 5n, ts: b.now(), isCommitment: false },
      { ...b.envelope(R), kind: "RealityArbitrationRequested", questionId: claim.questionId, user },
      { ...b.envelope(R), kind: "RealityArbitratorAnswered", questionId: claim.questionId, answer: answerOf(1n) },
      { ...b.envelope(R), kind: "RealityQuestionReopened", questionId: h("lookalike-replacement"), reopenedQuestionId: claim.questionId },
      { ...b.envelope(C), kind: "ConditionResolution", conditionId: claim.conditionId, oracle: a("o"), ctfQuestionId: h("lq"), outcomeSlotCount: 2, payoutNumerators: [1n, 0n] },
      { ...b.envelope(K), kind: "KlerosHome", stage: "ArbitratorAnswered", questionId: claim.questionId, requester: null, maxPrevious: null, reason: null, answer: answerOf(1n) },
      { ...b.envelope(K), kind: "KlerosHome", stage: "RequestNotified", questionId: claim.questionId, requester: user, maxPrevious: 0n, reason: null, answer: null },
    ];
    const lookAlike = a("look-alike");
    for (const event of genuine) {
      const indexer = createTestIndexer();
      await indexer.process({ chains: { 100: { simulate: [toSimulateItem(claim)] } } });
      const before = await allEntities(indexer);
      await expect(indexer.process({ chains: { 100: { simulate: [toSimulateItem({ ...event, address: lookAlike })] } } }), event.kind).rejects.toThrow(/never reached a handler/);
      expect(await allEntities(indexer), event.kind).toEqual(before);
      // Control: the same event from the configured address changes the entities.
      const control = createTestIndexer();
      await control.process({ chains: { 100: { simulate: [toSimulateItem(claim), toSimulateItem(event)] } } });
      const after = await allEntities(control);
      expect({ ...after, IndexerProgress: [] }, event.kind).not.toEqual({ ...before, IndexerProgress: [] });
    }
  });

  it("third-party values of tracked ids are stored in their full on-chain domain (no third-party event can halt)", async () => {
    const b = new EventBuilder();
    const claim = claimCreated(b, "wide");
    b.nextBlock();
    const answer = toSimulateItem({ ...b.envelope(R), kind: "RealityNewAnswer", questionId: claim.questionId, answer: answerOf(1n), historyHash: h("w"), user: a("u"), bond: 1n, ts: 1, isCommitment: false });
    const rejected = toSimulateItem({ ...b.envelope(K), kind: "KlerosHome", stage: "RequestRejected", questionId: claim.questionId, requester: a("u"), maxPrevious: 0n, reason: "x".repeat(2_000), answer: null });
    if (answer.contract !== "RealityETH" || answer.event !== "LogNewAnswer") throw new Error("unexpected item");
    const hugeBond = 2n ** 255n;
    const hugeTs = 2n ** 64n;
    const { indexer, run } = process100([toSimulateItem(claim), { ...answer, params: { ...answer.params, bond: hugeBond, ts: hugeTs } }, rejected]);
    await run;
    const question = await indexer.OracleQuestion.getOrThrow(claim.questionId);
    expect(question.bond).toBe(hugeBond);
    expect(question.finalizeTs).toBe(hugeTs + question.timeout);
    expect((await indexer.Arbitration.getOrThrow(claim.questionId)).rejectionReason).toBe("x".repeat(2_000));
  });
});
