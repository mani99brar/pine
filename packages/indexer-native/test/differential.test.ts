import "./lock.js";
import { encodePacked, keccak256 } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChainEvent, KlerosHomeStage } from "@pine/shared/chain-events";
import type { ReadModel } from "@pine/shared/read-model";
import { MemoryReadModel } from "@pine/shared/testing/memory-read-model";
import { claimCreated, EventBuilder, KLEROS_STAGES, SCENARIO_ADDRESSES, SCENARIO_CHAIN_ID, SCENARIO_QUESTION_TIMEOUT } from "@pine/shared/testing/read-model-scenarios";
import type { Address, Hex32 } from "@pine/shared/types";
import { applyEvents } from "../src/apply.js";
import { createNativeReadModel } from "../src/read-model.js";
import { resetDatabase } from "./digest.js";
import { openDatabase, type TestDatabase } from "./harness.js";

// Seeded random event sequences over small id pools (so duplicates, untracked ids, reveals that match or miss, reopen
// chains and every Kleros stage collide often), applied through applyEvents in random batch sizes and compared with the
// reference through every ReadModel getter.

const OPTIONS = { chainId: SCENARIO_CHAIN_ID, questionTimeout: SCENARIO_QUESTION_TIMEOUT };

let database: TestDatabase;
beforeAll(async () => {
  database = await openDatabase();
});
afterAll(async () => {
  await database.close();
});

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const h = (seed: string): Hex32 => keccak256(encodePacked(["string"], [seed]));
const a = (seed: string): Address => `0x${h(seed).slice(26)}` as Address;
const word = (value: bigint): Hex32 => `0x${value.toString(16).padStart(64, "0")}` as Hex32;

const QUESTIONS = [h("q0"), h("q1"), h("q2")];
const REPLACEMENTS = [h("r0"), h("r1")];
const ALL_QUESTIONS = [...QUESTIONS, ...REPLACEMENTS, h("untracked")];
const CONDITIONS = [h("c0"), h("c1"), h("c-untracked")];
const MARKETS = [a("m0"), a("m1"), a("m2"), a("m3")];
const BONDS = [0n, 10n ** 18n, 2n * 10n ** 18n, 4n * 10n ** 18n];
const ANSWER_HASHES = [h("ah0"), h("ah1")];

function generate(seed: number, length: number): ChainEvent[] {
  const random = prng(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const b = new EventBuilder();
  const events: ChainEvent[] = [];
  const reality = SCENARIO_ADDRESSES.reality;
  for (let index = 0; index < length; index += 1) {
    if (random() < 0.6) b.nextBlock(1 + Math.floor(random() * 5_000));
    const roll = random();
    if (roll < 0.14) {
      const market = pick(MARKETS);
      events.push(claimCreated(b, `fuzz-${seed}-${index}`, { market, questionId: pick([...QUESTIONS, REPLACEMENTS[0]!]), conditionId: pick(CONDITIONS.slice(0, 2)) }));
    } else if (roll < 0.24) {
      const kind = pick(["EvidenceCommitted", "EvidenceRevealed", "EvidencePublished"] as const);
      const base = { ...b.envelope(SCENARIO_ADDRESSES.evidenceRegistry), submissionId: BigInt(1 + Math.floor(random() * 4)), market: pick(MARKETS), submitter: pick(MARKETS) };
      if (kind === "EvidenceCommitted") events.push({ ...base, kind, commitment: h(`c${index}`), committedAt: b.now() });
      else if (kind === "EvidenceRevealed") events.push({ ...base, kind, contentSha256: h(`r${index}`), committedAt: 1, revealedAt: b.now() });
      else events.push({ ...base, kind, contentSha256: h(`p${index}`), publishedAt: b.now() });
    } else if (roll < 0.44) {
      const questionId = pick(ALL_QUESTIONS);
      const bond = pick(BONDS);
      const isCommitment = random() < 0.3;
      const answer = isCommitment ? keccak256(encodePacked(["bytes32", "bytes32", "uint256"], [questionId, pick(ANSWER_HASHES), bond])) : word(BigInt(Math.floor(random() * 3)));
      events.push({ ...b.envelope(reality), kind: "RealityNewAnswer", questionId, answer, historyHash: h(`hh${index}`), user: pick(MARKETS), bond, ts: b.now(), isCommitment });
    } else if (roll < 0.52) {
      events.push({ ...b.envelope(reality), kind: "RealityAnswerReveal", questionId: pick(ALL_QUESTIONS), user: pick(MARKETS), answerHash: pick(ANSWER_HASHES), answer: word(BigInt(Math.floor(random() * 2))), nonce: 7n, bond: pick(BONDS) });
    } else if (roll < 0.6) {
      const questionId = pick(ALL_QUESTIONS);
      const which = random();
      if (which < 0.4) events.push({ ...b.envelope(reality), kind: "RealityArbitrationRequested", questionId, user: pick(MARKETS) });
      else if (which < 0.7) events.push({ ...b.envelope(reality), kind: "RealityArbitrationCancelled", questionId });
      else events.push({ ...b.envelope(reality), kind: "RealityArbitratorAnswered", questionId, answer: word(BigInt(Math.floor(random() * 2))) });
    } else if (roll < 0.66) {
      events.push({ ...b.envelope(reality), kind: "RealityQuestionReopened", questionId: pick(REPLACEMENTS), reopenedQuestionId: pick([...QUESTIONS, ...REPLACEMENTS]) });
    } else if (roll < 0.72) {
      const bounty = BigInt(Math.floor(random() * 1_000));
      events.push({ ...b.envelope(reality), kind: "RealityBountyFunded", questionId: pick(ALL_QUESTIONS), bountyAdded: bounty, bounty, user: pick(MARKETS) });
    } else if (roll < 0.8) {
      const count = 1 + Math.floor(random() * 3);
      events.push({
        ...b.envelope(SCENARIO_ADDRESSES.conditionalTokens),
        kind: "ConditionResolution",
        conditionId: pick(CONDITIONS),
        oracle: a("oracle"),
        ctfQuestionId: h(`ctf${index}`),
        outcomeSlotCount: count,
        payoutNumerators: Array.from({ length: count }, () => BigInt(Math.floor(random() * 3))),
      });
    } else {
      const stage: KlerosHomeStage = pick(KLEROS_STAGES);
      const withRequester = ["RequestNotified", "RequestRejected", "RequestAcknowledged", "RequestCanceled", "ArbitrationFailed"].includes(stage);
      events.push({
        ...b.envelope(SCENARIO_ADDRESSES.klerosHomeProxy),
        kind: "KlerosHome",
        stage,
        questionId: pick(ALL_QUESTIONS),
        requester: withRequester ? pick(MARKETS) : null,
        maxPrevious: stage === "RequestNotified" || stage === "RequestRejected" ? pick(BONDS) : null,
        reason: stage === "RequestRejected" ? pick(["Bond has changed", "", "\u0000x"]) : null,
        answer: stage === "ArbitratorAnswered" ? word(BigInt(Math.floor(random() * 2))) : null,
      });
    }
  }
  return events;
}

async function walk<T>(fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard += 1) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

async function snapshot(model: ReadModel): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const id of ALL_QUESTIONS) {
    out[`q:${id}`] = await model.getOracleQuestion(id);
    out[`a:${id}`] = await model.listOracleAnswers(id);
    out[`k:${id}`] = await model.getArbitration(id);
    out[`cq:${id}`] = await model.listClaimsByQuestion(id);
  }
  for (const id of CONDITIONS) out[`c:${id}`] = await model.getConditionResolution(id);
  for (const market of MARKETS) out[`m:${market}`] = await model.getClaim(market);
  for (let id = 1n; id <= 4n; id += 1n) out[`e:${id}`] = await model.getEvidence(SCENARIO_ADDRESSES.evidenceRegistry, id);
  for (const order of ["created_desc", "evidence_deadline_asc"] as const) {
    out[`claims:${order}`] = await walk((cursor) => model.listClaims(cursor === undefined ? { order, limit: 2 } : { order, limit: 2, cursor }));
  }
  out.evidence = await walk((cursor) => model.listEvidence(cursor === undefined ? { limit: 3 } : { limit: 3, cursor }));
  return out;
}

const coverage = { answers: 0, revealed: 0, reopened: 0, arbitrations: 0, resolutions: 0, revealedEvidence: 0, sharedQuestions: 0 };

async function recordCoverage(reference: MemoryReadModel): Promise<void> {
  for (const id of ALL_QUESTIONS) {
    const answers = await reference.listOracleAnswers(id);
    coverage.answers += answers.length;
    coverage.revealed += answers.filter((answer) => answer.isCommitment && answer.revealedAnswer !== null).length;
    const question = await reference.getOracleQuestion(id);
    if (question?.reopens) coverage.reopened += 1;
    if ((question?.markets.length ?? 0) > 1) coverage.sharedQuestions += 1;
    if (await reference.getArbitration(id)) coverage.arbitrations += 1;
  }
  for (const id of CONDITIONS) if (await reference.getConditionResolution(id)) coverage.resolutions += 1;
  for (let id = 1n; id <= 4n; id += 1n) if ((await reference.getEvidence(SCENARIO_ADDRESSES.evidenceRegistry, id))?.status === "revealed") coverage.revealedEvidence += 1;
}

describe("differential: applyEvents vs the reference over random sequences", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    it(`seed ${seed}`, async () => {
      await resetDatabase(database.db);
      const events = generate(seed, 90);
      const reference = new MemoryReadModel(OPTIONS);
      reference.apply(events);
      // Random batch boundaries, plus a replay of each batch (idempotency) before moving on.
      const random = prng(seed * 7919);
      for (let start = 0; start < events.length; ) {
        const end = Math.min(events.length, start + 1 + Math.floor(random() * 20));
        const batch = events.slice(start, end);
        await database.db.transaction((tx) => applyEvents(tx, batch, OPTIONS));
        await database.db.transaction((tx) => applyEvents(tx, batch, OPTIONS));
        start = end;
      }
      expect(await snapshot(createNativeReadModel(database.db, { chainId: OPTIONS.chainId }))).toEqual(await snapshot(reference));
      await recordCoverage(reference);
    });
  }

  it("the sequences exercised every tracked path (not vacuous)", () => {
    for (const [name, count] of Object.entries(coverage)) expect(count, name).toBeGreaterThan(0);
  });
});
