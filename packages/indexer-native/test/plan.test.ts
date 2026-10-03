import "./lock.js";
import { encodePacked, keccak256 } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChainEvent } from "@pine/shared/chain-events";
import { REALITY_ANSWERED_TOO_SOON, type ReadModel } from "@pine/shared/read-model";
import { MemoryReadModel } from "@pine/shared/testing/memory-read-model";
import { claimCreated, EventBuilder, SCENARIO_ADDRESSES, SCENARIO_CHAIN_ID, SCENARIO_QUESTION_TIMEOUT, scenarioOracle } from "@pine/shared/testing/read-model-scenarios";
import type { Address, Hex32 } from "@pine/shared/types";
import type { SqlExecutor } from "../src/db.js";
import { topic0Of, type RawLog } from "../src/decode.js";
import { MAX_REOPEN_ROUNDS, Poller, type CycleResult, type Logger, type PollerOptions } from "../src/poller.js";
import { createNativeReadModel } from "../src/read-model.js";
import { createRedactor } from "../src/redact.js";
import { createHttpProvider, type FetchLike, type LogQuery, type RpcProvider } from "../src/rpc.js";
import { listHalts } from "../src/store.js";
import { resetDatabase } from "./digest.js";
import { openDatabase, type TestDatabase } from "./harness.js";
import { inject, jsonRpcFetch, ScriptedChain, ScriptedProvider, type ProviderCall } from "./scripted-rpc.js";

// The tracked-id-filtered request plan, size-type splitting with a plan shared by both providers, the adaptive processed
// range and the re-check of provider differences (PRD-05 sections 2.3 and 3a).

const DEPLOYMENT_BLOCK = 1_000n;
const h = (seed: string): Hex32 => keccak256(encodePacked(["string"], [seed]));
const word = (value: bigint): Hex32 => `0x${value.toString(16).padStart(64, "0")}` as Hex32;
const user = `0x${"ab".repeat(20)}` as Address;

let database: TestDatabase;
beforeAll(async () => {
  database = await openDatabase();
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  await resetDatabase(database.db);
});

interface LogEntry {
  level: string;
  object: Record<string, unknown>;
  message: string;
}

function captureLogger(entries: LogEntry[]): Logger {
  return {
    info: (object, message) => entries.push({ level: "info", object, message }),
    warn: (object, message) => entries.push({ level: "warn", object, message }),
    error: (object, message) => entries.push({ level: "error", object, message }),
  };
}

function setup(events: readonly ChainEvent[], overrides: Partial<PollerOptions> = {}, finalized?: bigint, prepare?: (chain: ScriptedChain) => void) {
  const chain = new ScriptedChain(finalized ?? (events.at(-1)?.blockNumber ?? DEPLOYMENT_BLOCK) + 10n, events);
  prepare?.(chain);
  const primary = new ScriptedProvider("primary", chain);
  const secondary = new ScriptedProvider("secondary", chain.clone());
  const logs: LogEntry[] = [];
  const sleeps: number[] = [];
  const poller = new Poller({
    db: database.db,
    primary,
    secondary,
    chainId: SCENARIO_CHAIN_ID,
    questionTimeout: SCENARIO_QUESTION_TIMEOUT,
    addresses: SCENARIO_ADDRESSES,
    deploymentBlock: DEPLOYMENT_BLOCK,
    redact: createRedactor(),
    logger: captureLogger(logs),
    now: () => 1_900_000_000_000,
    sleep: async (ms) => void sleeps.push(ms),
    ...overrides,
  });
  return { chain, primary, secondary, poller, logs, sleeps };
}

async function drain(poller: Poller): Promise<CycleResult[]> {
  const results: CycleResult[] = [];
  for (let guard = 0; guard < 1_000; guard += 1) {
    const result = await poller.runCycle();
    results.push(result);
    if (result.kind !== "advanced") return results;
  }
  throw new Error("did not finish");
}

const model = (): ReadModel => createNativeReadModel(database.db, { chainId: SCENARIO_CHAIN_ID });

async function expectSameAsReference(events: readonly ChainEvent[], questions: readonly Hex32[]): Promise<void> {
  const memory = new MemoryReadModel({ chainId: SCENARIO_CHAIN_ID, questionTimeout: SCENARIO_QUESTION_TIMEOUT });
  memory.apply(events);
  const native = model();
  expect((await native.listClaims({ order: "created_desc", limit: 100 })).items).toEqual((await memory.listClaims({ order: "created_desc", limit: 100 })).items);
  for (const questionId of questions) {
    expect(await native.getOracleQuestion(questionId)).toEqual(await memory.getOracleQuestion(questionId));
    expect(await native.listOracleAnswers(questionId)).toEqual(await memory.listOracleAnswers(questionId));
    expect(await native.getArbitration(questionId)).toEqual(await memory.getArbitration(questionId));
  }
}

const rangesApplied = (logs: LogEntry[]): { from: bigint; to: bigint; logs: number }[] =>
  logs.filter((entry) => entry.message === "range applied").map((entry) => ({ from: BigInt(String(entry.object.from)), to: BigInt(String(entry.object.to)), logs: Number(entry.object.logs) }));

const realityCalls = (provider: ScriptedProvider): ProviderCall[] =>
  provider.getLogsCalls().filter((call) => call.query?.addresses.includes(SCENARIO_ADDRESSES.reality) === true);

function answer(b: EventBuilder, questionId: Hex32, bond: bigint, value = 1n): ChainEvent {
  return { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityNewAnswer", questionId, answer: word(value), historyHash: h(`hh:${questionId}:${bond}:${b.now()}`), user, bond, ts: b.now(), isCommitment: false };
}

function bounty(b: EventBuilder, questionId: Hex32, amount: bigint): ChainEvent {
  return { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityBountyFunded", questionId, bountyAdded: 0n, bounty: amount, user };
}

describe("request plan: only tracked ids are requested", () => {
  it("spam answers on an untracked question are never requested from either provider", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "tracked");
    const events: ChainEvent[] = [created];
    const spamQuestion = h("spam-question");
    const spam: ChainEvent[] = [];
    for (let block = 0; block < 20; block += 1) {
      b.nextBlock();
      for (let index = 0; index < 5; index += 1) spam.push(answer(b, spamQuestion, BigInt(index + 1)));
      if (block === 10) events.push(answer(b, created.questionId, 10n ** 18n));
    }
    const { chain, primary, secondary, poller } = setup([...events, ...spam].sort((x, y) => (x.blockNumber !== y.blockNumber ? (x.blockNumber < y.blockNumber ? -1 : 1) : x.logIndex - y.logIndex)));
    await poller.start();
    await drain(poller);
    for (const provider of [primary, secondary]) {
      expect(provider.served.some((log) => log.topics[1] === spamQuestion)).toBe(false);
      for (const call of realityCalls(provider)) {
        const ids = call.query!.topics.slice(1).flatMap((list) => list ?? []);
        expect(ids.length).toBeGreaterThan(0);
        expect(ids).not.toContain(spamQuestion);
      }
    }
    expect(chain.logs.filter((log) => log.topics[1] === spamQuestion)).toHaveLength(100);
    await expectSameAsReference(events, [created.questionId]);
  });

  it("before any claim exists no Reality or CTF request is made at all", async () => {
    const b = new EventBuilder();
    const events = [answer(b, h("nobody-tracks-this"), 1n)];
    const { primary, poller } = setup(events);
    await poller.start();
    await drain(poller);
    expect(realityCalls(primary)).toEqual([]);
    expect(primary.getLogsCalls().some((call) => call.query?.addresses.includes(SCENARIO_ADDRESSES.conditionalTokens))).toBe(false);
  });

  it("tracked id lists are chunked to 100 ids per request (OR-lists)", async () => {
    const b = new EventBuilder();
    const events: ChainEvent[] = [];
    for (let index = 0; index < 230; index += 1) events.push(claimCreated(b, `bulk-${index}`));
    b.nextBlock();
    const last = events.at(-1) as ChainEvent & { kind: "ClaimCreated" };
    events.push(answer(b, last.questionId, 10n ** 18n));
    const { primary, poller } = setup(events);
    await poller.start();
    await drain(poller);
    const realityAnswers = realityCalls(primary).filter((call) => call.query!.topics[0]!.length > 1);
    expect(realityAnswers.map((call) => call.query!.topics[1]!.length)).toEqual([100, 100, 30]);
    const ctf = primary.getLogsCalls().filter((call) => call.query?.addresses.includes(SCENARIO_ADDRESSES.conditionalTokens));
    expect(ctf.map((call) => call.query!.topics[1]!.length)).toEqual([100, 100, 30]);
    expect((await model().getOracleQuestion(last.questionId))?.answerCount).toBe(1);
  });

  it("the stored tracked ids drive later ranges (a claim in one range, its answer in a later one)", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "later");
    b.nextBlock(5);
    for (let step = 0; step < 120; step += 1) b.nextBlock();
    const later = answer(b, created.questionId, 10n ** 18n);
    const events = [created, later];
    const { poller, logs } = setup(events, { chunkSize: 50 });
    await poller.start();
    await drain(poller);
    expect(rangesApplied(logs).length).toBeGreaterThan(2);
    await expectSameAsReference(events, [created.questionId]);
  });

  it("a reopen chain deeper than the round limit cuts the range and completes over the next cycles", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "deep");
    const events: ChainEvent[] = [created];
    let current = created.questionId;
    const chainIds: Hex32[] = [current];
    for (let depth = 1; depth <= MAX_REOPEN_ROUNDS + 3; depth += 1) {
      b.nextBlock();
      events.push({ ...(answer(b, current, 10n ** 18n) as ChainEvent & { kind: "RealityNewAnswer" }), answer: REALITY_ANSWERED_TOO_SOON });
      b.nextBlock();
      const next = h(`deep-replacement-${depth}`);
      events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityQuestionReopened", questionId: next, reopenedQuestionId: current });
      current = next;
      chainIds.push(next);
    }
    b.nextBlock();
    events.push(answer(b, current, 3n * 10n ** 18n));
    const { poller, logs } = setup(events);
    await poller.start();
    const results = await drain(poller);
    expect(results.at(-1)).toMatchObject({ kind: "idle" });
    const ranges = rangesApplied(logs);
    // The first range was cut just before the block of the reopen that created the 8th replacement.
    const eighth = events.find((event) => event.kind === "RealityQuestionReopened" && event.questionId === chainIds[MAX_REOPEN_ROUNDS])!;
    expect(ranges[0]!.to).toBe(eighth.blockNumber - 1n);
    expect(logs.some((entry) => entry.message.includes("reopen chain deeper"))).toBe(true);
    expect((await model().getOracleQuestion(current))?.answerCount).toBe(1);
    await expectSameAsReference(events, chainIds);
  });
});

describe("request plan: one merged apply per range", () => {
  it("a tracked Reality log BELOW an unfiltered (Kleros/registry) log of the same block is applied (one sorted applyEvents call)", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "merge");
    b.nextBlock();
    // logIndex 0 and 1: Reality (tracked-id request), logIndex 2: Kleros (unfiltered request), logIndex 3: evidence.
    const events: ChainEvent[] = [
      created,
      answer(b, created.questionId, 10n ** 18n),
      { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityArbitrationRequested", questionId: created.questionId, user },
      { ...b.envelope(SCENARIO_ADDRESSES.klerosHomeProxy), kind: "KlerosHome", stage: "RequestNotified", questionId: created.questionId, requester: user, maxPrevious: 10n ** 18n, reason: null, answer: null },
      { ...b.envelope(SCENARIO_ADDRESSES.evidenceRegistry), kind: "EvidenceCommitted", submissionId: 1n, market: created.market, submitter: user, commitment: h("commitment"), committedAt: b.now() },
    ];
    const { poller } = setup(events);
    await poller.start();
    await drain(poller);
    expect(await model().getOracleQuestion(created.questionId)).toMatchObject({ answerCount: 1, pendingArbitration: true });
    expect((await model().getArbitration(created.questionId))?.stage).toBe("RequestNotified");
    await expectSameAsReference(events, [created.questionId]);
  });
});

describe("request plan: size-type failures split, a plan shared by both providers", () => {
  /** Claims with answers spread over many blocks. */
  function spread(blocks: number): { events: ChainEvent[]; questions: Hex32[] } {
    const b = new EventBuilder();
    const created = claimCreated(b, "split");
    const events: ChainEvent[] = [created];
    for (let index = 0; index < blocks; index += 1) {
      b.nextBlock();
      events.push(answer(b, created.questionId, BigInt(index + 1) * 10n ** 18n));
    }
    return { events, questions: [created.questionId] };
  }

  it("the primary forcing splits: ranges halve down to ONE block, the secondary runs exactly the refined requests", async () => {
    const { events, questions } = spread(40);
    const { primary, secondary, poller } = setup(events, { chunkSize: 64 });
    // A provider that answers "too many results" for any multi-block Reality range.
    primary.failGetLogs = (query) => (query.addresses.includes(SCENARIO_ADDRESSES.reality) && query.toBlock > query.fromBlock ? "size" : null);
    await poller.start();
    expect((await drain(poller)).at(-1)).toMatchObject({ kind: "idle" });
    const succeeded = realityCalls(primary).filter((call) => call.to === call.from);
    expect(succeeded.length).toBeGreaterThan(0);
    expect(realityCalls(secondary).map((call) => call.query)).toEqual(succeeded.map((call) => call.query));
    expect((await model().status()).halted).toBe(false);
    await expectSameAsReference(events, questions);
  });

  it("the secondary forcing a split: the halves run on BOTH providers and are compared request by request", async () => {
    const { events, questions } = spread(12);
    const { primary, secondary, poller } = setup(events, { chunkSize: 16 });
    secondary.failGetLogs = (query) => (query.addresses.includes(SCENARIO_ADDRESSES.reality) && query.toBlock - query.fromBlock + 1n > 4n ? "size" : null);
    await poller.start();
    await drain(poller);
    const small = (provider: ScriptedProvider) => realityCalls(provider).filter((call) => call.to! - call.from! + 1n <= 4n).map((call) => call.query);
    expect(small(primary).length).toBeGreaterThan(0);
    expect(small(primary)).toEqual(small(secondary));
    expect((await model().status()).halted).toBe(false);
    await expectSameAsReference(events, questions);
  });

  it("a one-block request still failing on size never halts: the cycle gives up and backs off", async () => {
    const { events } = spread(3);
    const { primary, poller } = setup(events);
    primary.failGetLogs = (query) => (query.addresses.includes(SCENARIO_ADDRESSES.reality) ? "size" : null);
    await poller.start();
    await expect(poller.runCycle()).rejects.toThrow(/more than 10000 results/);
    expect((await model().status()).halted).toBe(false);
    expect(realityCalls(primary).every((call) => call.to! >= call.from!)).toBe(true);
    expect(realityCalls(primary).some((call) => call.to === call.from)).toBe(true);
  });

  it("a response above the parser cap (logs per response) is a size failure, not a halt", async () => {
    const { events, questions } = spread(30);
    const { primary, secondary, poller } = setup(events, { chunkSize: 64 });
    primary.maxLogsPerResponse = 8;
    secondary.maxLogsPerResponse = 8;
    await poller.start();
    expect((await drain(poller)).at(-1)).toMatchObject({ kind: "idle" });
    expect((await model().status()).halted).toBe(false);
    await expectSameAsReference(events, questions);
  });
});

describe("request plan: the processed range is cut adaptively (bounded memory under floods)", () => {
  it("a flood of zero-value bounty logs on a TRACKED question is processed over several cycles under the cap", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "flooded");
    const events: ChainEvent[] = [created];
    for (let block = 0; block < 30; block += 1) {
      b.nextBlock();
      for (let index = 0; index < 12; index += 1) events.push(bounty(b, created.questionId, 1n));
    }
    b.nextBlock();
    events.push(answer(b, created.questionId, 10n ** 18n));
    const cap = 50;
    const { poller, logs, secondary } = setup(events, { maxRangeLogs: cap, chunkSize: 500 });
    await poller.start();
    const results = await drain(poller);
    expect(results.at(-1)).toMatchObject({ kind: "idle" });
    const ranges = rangesApplied(logs);
    expect(ranges.length).toBeGreaterThanOrEqual(7);
    for (const range of ranges) expect(range.logs).toBeLessThanOrEqual(cap);
    // Contiguous whole-block ranges.
    for (let index = 1; index < ranges.length; index += 1) expect(ranges[index]!.from).toBe(ranges[index - 1]!.to + 1n);
    // The secondary never fetched beyond a cut: each of its requests lies inside one processed range.
    for (const call of secondary.getLogsCalls()) expect(ranges.some((range) => call.from! >= range.from && call.to! <= range.to)).toBe(true);
    expect((await model().status()).halted).toBe(false);
    await expectSameAsReference(events, [created.questionId]);
  });

  it("a single block above the cap is still processed alone (minimum one block)", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "one-block-flood");
    b.nextBlock();
    const events: ChainEvent[] = [created];
    for (let index = 0; index < 30; index += 1) events.push(bounty(b, created.questionId, BigInt(index)));
    b.nextBlock();
    events.push(answer(b, created.questionId, 10n ** 18n));
    const { poller, logs } = setup(events, { maxRangeLogs: 10 });
    await poller.start();
    await drain(poller);
    const flooded = events[1]!.blockNumber;
    expect(rangesApplied(logs).some((range) => range.from === flooded && range.to === flooded && range.logs === 30)).toBe(true);
    await expectSameAsReference(events, [created.questionId]);
  });

  it("the byte cap also cuts the range", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "bytes");
    const events: ChainEvent[] = [created];
    for (let block = 0; block < 10; block += 1) {
      b.nextBlock();
      for (let index = 0; index < 4; index += 1) events.push(bounty(b, created.questionId, 1n));
    }
    const { poller, logs } = setup(events, { maxRangeBytes: 4_000 });
    await poller.start();
    await drain(poller);
    expect(rangesApplied(logs).length).toBeGreaterThan(3);
    await expectSameAsReference(events, [created.questionId]);
  });
});

describe("provider differences are re-checked before halting", () => {
  it("a difference that disappears on re-check (a lagging load-balanced backend) does not halt", async () => {
    const events = scenarioOracle().events;
    const { poller, secondary, sleeps } = setup(events);
    let lagging = 2;
    const original = secondary.getLogs.bind(secondary);
    secondary.getLogs = async (query) => (lagging-- > 0 ? [] : original(query));
    await poller.start();
    expect((await drain(poller)).at(-1)).toMatchObject({ kind: "idle" });
    expect(sleeps.filter((ms) => ms === 10_000).length).toBeGreaterThanOrEqual(1);
    expect((await model().status()).halted).toBe(false);
  });

  it("a persisting difference halts after 3 re-checks 10 s apart, re-fetching from BOTH providers", async () => {
    const { events, claim } = scenarioOracle();
    const { poller, primary, secondary, sleeps } = setup(events);
    const target = events.find((event) => event.kind === "RealityNewAnswer" && event.bond === 4n * 10n ** 18n)!;
    secondary.omitLog = (log) => log.blockNumber === target.blockNumber && log.logIndex === target.logIndex;
    await poller.start();
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "log_disagreement" });
    expect(sleeps.filter((ms) => ms === 10_000)).toHaveLength(3);
    // The plan was built and run four times (once plus three re-checks) on both providers.
    const first = primary.getLogsCalls()[0]!.query!;
    const same = (call: ProviderCall) => call.query !== undefined && call.from === first.fromBlock && call.to === first.toBlock && call.query.addresses[0] === first.addresses[0];
    expect(primary.getLogsCalls().filter(same)).toHaveLength(4);
    expect(secondary.getLogsCalls().filter(same)).toHaveLength(4);
    expect(await model().getOracleQuestion(claim.questionId)).toBeNull();
    expect((await listHalts(database.db, SCENARIO_CHAIN_ID)).map((halt) => halt.reason)).toEqual(["log_disagreement"]);
  });

  it("a reopen hidden by the primary is caught on the discovery request itself", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "hidden-reopen");
    b.nextBlock();
    const replacement = h("hidden-replacement");
    const reopen: ChainEvent = { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityQuestionReopened", questionId: replacement, reopenedQuestionId: created.questionId };
    b.nextBlock();
    const events = [created, reopen, answer(b, replacement, 10n ** 18n)];
    const { poller, primary } = setup(events);
    const reopenTopic0 = topic0Of("reality", "LogReopenQuestion");
    primary.omitLog = (log) => log.topics[0] === reopenTopic0;
    await poller.start();
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "log_disagreement" });
    const detail = (await listHalts(database.db, SCENARIO_CHAIN_ID))[0]!.detail;
    expect(detail).toContain("LogReopenQuestion round 1");
  });
});

// ------------------------------------------------------------------------------------------------- PRD-05 section 3b

/** Main Reality requests (answers, reveals, arbitration, ...): topic0 OR-list of several events, ids on topic1. */
const realityMainCalls = (provider: ScriptedProvider): ProviderCall[] => realityCalls(provider).filter((call) => call.query!.topics[0]!.length > 1);
const reopenDiscoveryCalls = (provider: ScriptedProvider): ProviderCall[] => realityCalls(provider).filter((call) => call.query!.topics[0]!.length === 1);
const ctfCalls = (provider: ScriptedProvider): ProviderCall[] => provider.getLogsCalls().filter((call) => call.query?.addresses.includes(SCENARIO_ADDRESSES.conditionalTokens) === true);
const offsets = (calls: ProviderCall[], base: bigint): [number, number][] => calls.map((call) => [Number(call.from! - base), Number(call.to! - base)]);

describe("request plan: size-type failures halve step by step", () => {
  /** One claim and answers on 70 consecutive blocks (DEPLOYMENT_BLOCK .. +70). */
  function answered(): ChainEvent[] {
    const b = new EventBuilder();
    const created = claimCreated(b, "halving");
    const events: ChainEvent[] = [created];
    for (let index = 0; index < 70; index += 1) {
      b.nextBlock();
      events.push(answer(b, created.questionId, BigInt(index + 1) * 10n ** 18n));
    }
    return events;
  }

  it("64 → 32 → 16 → 8, and a sub-range that succeeds is not split further", async () => {
    const events = answered();
    const { primary, secondary, poller } = setup(events, { chunkSize: 64 });
    primary.failGetLogs = (query) => (query.addresses.includes(SCENARIO_ADDRESSES.reality) && query.topics[0]!.length > 1 && query.toBlock - query.fromBlock + 1n > 8n ? "size" : null);
    await poller.start();
    expect(await poller.runCycle()).toMatchObject({ kind: "advanced", from: DEPLOYMENT_BLOCK, to: DEPLOYMENT_BLOCK + 63n });
    // Every request in order, failed ones included: each failure halves exactly its own range; successes stay whole.
    expect(offsets(realityMainCalls(primary), DEPLOYMENT_BLOCK)).toEqual([
      [0, 63], [0, 31], [0, 15], [0, 7], [8, 15], [16, 31], [16, 23], [24, 31],
      [32, 63], [32, 47], [32, 39], [40, 47], [48, 63], [48, 55], [56, 63],
    ]);
    // The secondary runs exactly the eight refined requests, never the failed wider ones.
    expect(offsets(realityMainCalls(secondary), DEPLOYMENT_BLOCK)).toEqual([[0, 7], [8, 15], [16, 23], [24, 31], [32, 39], [40, 47], [48, 55], [56, 63]]);
    expect((await model().getOracleQuestion((events[0] as ChainEvent & { kind: "ClaimCreated" }).questionId))?.answerCount).toBe(63);
  });

  it("64 → 32 → 16 → 8 → 4 → 2 → 1: a provider refusing every multi-block range is served block by block", async () => {
    const events = answered();
    const { primary, poller } = setup(events, { chunkSize: 64 });
    primary.failGetLogs = (query) => (query.addresses.includes(SCENARIO_ADDRESSES.reality) && query.topics[0]!.length > 1 && query.toBlock > query.fromBlock ? "size" : null);
    await poller.start();
    expect(await poller.runCycle()).toMatchObject({ kind: "advanced" });
    expect(offsets(realityMainCalls(primary), DEPLOYMENT_BLOCK).slice(0, 15)).toEqual([
      [0, 63], [0, 31], [0, 15], [0, 7], [0, 3], [0, 1], [0, 0], [1, 1], [2, 3], [2, 2], [3, 3], [4, 7], [4, 5], [4, 4], [5, 5],
    ]);
    expect(realityMainCalls(primary).filter((call) => call.to === call.from)).toHaveLength(64);
    expect((await model().status()).halted).toBe(false);
  });
});

/** A monotonic chain clock: event blocks keep their timestamps, `anchors` pin chosen blocks, other blocks interpolate. */
function chainClock(events: readonly ChainEvent[], anchors: readonly [bigint, number][] = []): (number: bigint) => number {
  const points = new Map<bigint, number>(anchors);
  for (const event of events) points.set(event.blockNumber, event.blockTimestamp);
  const sorted = [...points.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]![1] < sorted[index - 1]![1]) throw new Error("chain clock anchors must be monotonic");
  }
  return (number) => {
    const first = sorted[0]!;
    if (number <= first[0]) return first[1] - Number(first[0] - number) * 5;
    for (let index = 1; index < sorted.length; index += 1) {
      const [toBlock, toTime] = sorted[index]!;
      if (number > toBlock) continue;
      const [fromBlock, fromTime] = sorted[index - 1]!;
      return fromTime + Math.floor((Number(number - fromBlock) * (toTime - fromTime)) / Number(toBlock - fromBlock));
    }
    const last = sorted.at(-1)!;
    return last[1] + Number(number - last[0]) * 5;
  };
}

/** Moves an EventBuilder to `block` (it starts at DEPLOYMENT_BLOCK), the block's timestamp being `time`. */
function moveTo(b: EventBuilder, current: { block: bigint }, block: bigint, time: number): void {
  while (current.block < block - 1n) {
    b.nextBlock(0);
    current.block += 1n;
  }
  b.nextBlock(time - b.now());
  current.block += 1n;
}

/** The ids each processed range requested (topic1 of the main Reality requests, or of CTF requests), by range start. */
function requestedIds(calls: ProviderCall[], ranges: { from: bigint; to: bigint }[]): Map<bigint, string[]> {
  const out = new Map<bigint, string[]>();
  for (const range of ranges) {
    const ids = calls.filter((call) => call.from! >= range.from && call.to! <= range.to).flatMap((call) => call.query!.topics[1] ?? []);
    out.set(range.from, [...new Set(ids)].sort());
  }
  return out;
}

describe("request plan: the ACTIVE filter set (pruned at chain time, PRD-05 section 3b)", () => {
  const T = SCENARIO_QUESTION_TIMEOUT;
  const sorted = (...ids: Hex32[]): string[] => [...ids].sort();

  it("a question finalized at the cursor block is not requested; one past finalizeTs in wall-clock time but not at the range's first block still is", async () => {
    const b = new EventBuilder();
    const a = claimCreated(b, "prune-a");
    const c = claimCreated(b, "prune-c");
    b.nextBlock();
    const answerA = answer(b, a.questionId, 10n ** 18n);
    b.nextBlock(100);
    const answerC = answer(b, c.questionId, 10n ** 18n);
    const events = [a, c, answerA, answerC];
    const finalizeA = answerA.blockTimestamp + T;
    const finalizeC = answerC.blockTimestamp + T;
    // Chunks of 50: [1000..1049], [1050..1099], [1100..1149], [1150..1160]. Block 1049 (the first cursor) is exactly A's
    // finalizeTs; 5 s slots follow, so block 1050 (the second range's first block) is still before C's finalizeTs.
    const clock = chainClock(events, [[DEPLOYMENT_BLOCK + 49n, finalizeA]]);
    expect(clock(DEPLOYMENT_BLOCK + 50n)).toBeLessThan(finalizeC);
    expect(clock(DEPLOYMENT_BLOCK + 99n)).toBeGreaterThanOrEqual(finalizeC);
    // The wall clock (1.9e9 s) is past both: pruning by wall-clock time would drop C from the second range.
    const now = 1_900_000_000_000;
    expect(finalizeC * 1000).toBeLessThan(now);
    const { primary, secondary, poller, logs } = setup(events, { chunkSize: 50, now: () => now }, DEPLOYMENT_BLOCK + 160n, (chain) => (chain.timestampOf = clock));
    await poller.start();
    expect((await drain(poller)).at(-1)).toMatchObject({ kind: "idle" });
    const ranges = rangesApplied(logs);
    expect(ranges.map((range) => range.from)).toEqual([1_000n, 1_050n, 1_100n, 1_150n]);
    for (const provider of [primary, secondary]) {
      const reality = requestedIds(realityMainCalls(provider), ranges);
      expect(reality.get(1_000n)).toEqual(sorted(a.questionId, c.questionId));
      expect(reality.get(1_050n)).toEqual([c.questionId]);
      expect(reality.get(1_100n)).toEqual([]);
      expect(reality.get(1_150n)).toEqual([]);
      // No Reality request at all once nothing is live (not even the reopen discovery).
      expect(realityCalls(provider).filter((call) => call.from! >= 1_100n)).toEqual([]);
      // Conditions stay active until resolved.
      expect(requestedIds(ctfCalls(provider), ranges).get(1_150n)).toEqual(sorted(a.conditionId, c.conditionId));
    }
    await expectSameAsReference(events, [a.questionId, c.questionId]);
  });

  it("a question pending arbitration and a settled-too-soon (reopened) one are still requested; a replacement finalized with a real answer prunes it and its original", async () => {
    const b = new EventBuilder();
    const at = { block: DEPLOYMENT_BLOCK };
    const t0 = b.now();
    const p = claimCreated(b, "arbitrated");
    const s = claimCreated(b, "too-soon");
    moveTo(b, at, DEPLOYMENT_BLOCK + 1n, t0 + 5);
    const answerP = answer(b, p.questionId, 10n ** 18n);
    const answerS = { ...(answer(b, s.questionId, 10n ** 18n) as ChainEvent & { kind: "RealityNewAnswer" }), answer: REALITY_ANSWERED_TOO_SOON };
    moveTo(b, at, DEPLOYMENT_BLOCK + 2n, t0 + 10);
    const request: ChainEvent = { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityArbitrationRequested", questionId: p.questionId, user };
    // Second range [1050..1099]: the arbitrator answers P, S is reopened as R and R gets a real answer.
    moveTo(b, at, DEPLOYMENT_BLOCK + 60n, t0 + T + 100);
    const arbitratorAnswer = answer(b, p.questionId, 0n, 2n);
    const finalize: ChainEvent = { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityArbitratorAnswered", questionId: p.questionId, answer: word(2n) };
    moveTo(b, at, DEPLOYMENT_BLOCK + 70n, t0 + T + 150);
    const r = h("too-soon-replacement");
    const reopen: ChainEvent = { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityQuestionReopened", questionId: r, reopenedQuestionId: s.questionId };
    moveTo(b, at, DEPLOYMENT_BLOCK + 75n, t0 + T + 175);
    const answerR = answer(b, r, 10n ** 18n);
    const events = [p, s, answerP, answerS, request, arbitratorAnswer, finalize, reopen, answerR];
    const finalizeR = answerR.blockTimestamp + T;
    // Block 1049 (first cursor): P and S are past finalizeTs; block 1149 (third cursor): R's finalizeTs exactly.
    const clock = chainClock(events, [
      [DEPLOYMENT_BLOCK + 49n, answerP.blockTimestamp + T],
      [DEPLOYMENT_BLOCK + 149n, finalizeR],
    ]);
    expect(clock(DEPLOYMENT_BLOCK + 99n)).toBeLessThan(finalizeR);
    const { primary, secondary, poller, logs } = setup(events, { chunkSize: 50 }, DEPLOYMENT_BLOCK + 210n, (chain) => (chain.timestampOf = clock));
    await poller.start();
    expect((await drain(poller)).at(-1)).toMatchObject({ kind: "idle" });
    const ranges = rangesApplied(logs);
    expect(ranges.map((range) => range.from)).toEqual([1_000n, 1_050n, 1_100n, 1_150n, 1_200n]);
    for (const provider of [primary, secondary]) {
      const reality = requestedIds(realityMainCalls(provider), ranges);
      expect(reality.get(1_000n)).toEqual(sorted(p.questionId, s.questionId));
      // P is past finalizeTs but pending arbitration; S settled too soon (it can be reopened); R is found in this range.
      expect(reality.get(1_050n)).toEqual(sorted(p.questionId, s.questionId, r));
      // P is finalized by the arbitrator; S stays while its replacement R is not finalized.
      expect(reality.get(1_100n)).toEqual(sorted(s.questionId, r));
      // R finalized with a real answer: R and its original S leave the filter.
      expect(reality.get(1_150n)).toEqual([]);
      expect(reality.get(1_200n)).toEqual([]);
      const discovery = requestedIds(reopenDiscoveryCalls(provider).map((call) => ({ ...call, query: { ...call.query!, topics: [call.query!.topics[0]!, call.query!.topics[2]!] } })), ranges);
      expect(discovery.get(1_050n)).toContain(s.questionId);
      expect(discovery.get(1_100n)).toEqual(sorted(s.questionId, r));
      expect(discovery.get(1_150n)).toEqual([]);
    }
    expect(await model().getOracleQuestion(p.questionId)).toMatchObject({ answeredByArbitrator: true, pendingArbitration: false });
    expect((await model().getOracleQuestion(r))?.answerCount).toBe(1);
    await expectSameAsReference(events, [p.questionId, s.questionId, r]);
  });

  it("an original whose latest replacement settled too soon again stays active (it can be reopened once more)", async () => {
    const b = new EventBuilder();
    const at = { block: DEPLOYMENT_BLOCK };
    const t0 = b.now();
    const o = claimCreated(b, "twice-too-soon");
    moveTo(b, at, DEPLOYMENT_BLOCK + 1n, t0 + 5);
    const first = { ...(answer(b, o.questionId, 10n ** 18n) as ChainEvent & { kind: "RealityNewAnswer" }), answer: REALITY_ANSWERED_TOO_SOON };
    moveTo(b, at, DEPLOYMENT_BLOCK + 10n, t0 + T + 10);
    const r1 = h("twice-r1");
    const reopen1: ChainEvent = { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityQuestionReopened", questionId: r1, reopenedQuestionId: o.questionId };
    moveTo(b, at, DEPLOYMENT_BLOCK + 11n, t0 + T + 15);
    const second = { ...(answer(b, r1, 10n ** 18n) as ChainEvent & { kind: "RealityNewAnswer" }), answer: REALITY_ANSWERED_TOO_SOON };
    // Third range: the original is reopened again (R1 settled too soon too) as R2.
    moveTo(b, at, DEPLOYMENT_BLOCK + 110n, t0 + 2 * T + 100);
    const r2 = h("twice-r2");
    const reopen2: ChainEvent = { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityQuestionReopened", questionId: r2, reopenedQuestionId: o.questionId };
    moveTo(b, at, DEPLOYMENT_BLOCK + 111n, t0 + 2 * T + 105);
    const answerR2 = answer(b, r2, 10n ** 18n);
    const events = [o, first, reopen1, second, reopen2, answerR2];
    const clock = chainClock(events, [[DEPLOYMENT_BLOCK + 99n, second.blockTimestamp + T]]);
    const { primary, poller, logs } = setup(events, { chunkSize: 50 }, DEPLOYMENT_BLOCK + 120n, (chain) => (chain.timestampOf = clock));
    await poller.start();
    expect((await drain(poller)).at(-1)).toMatchObject({ kind: "idle" });
    const ranges = rangesApplied(logs);
    // At the third range's cursor (block 1099) O and R1 are both finalized as settled too soon: both stay active.
    expect(requestedIds(realityMainCalls(primary), ranges).get(1_100n)).toEqual(sorted(o.questionId, r1, r2));
    expect((await model().getOracleQuestion(o.questionId))?.reopenedBy).toBe(r2);
    expect((await model().getOracleQuestion(r2))?.answerCount).toBe(1);
    await expectSameAsReference(events, [o.questionId, r1, r2]);
  });

  it("resolved conditions leave the CTF filter; unresolved ones stay until resolved", async () => {
    const b = new EventBuilder();
    const a = claimCreated(b, "resolved");
    const c = claimCreated(b, "unresolved");
    b.nextBlock();
    const resolution: ChainEvent = {
      ...b.envelope(SCENARIO_ADDRESSES.conditionalTokens),
      kind: "ConditionResolution",
      conditionId: a.conditionId,
      oracle: user,
      ctfQuestionId: h("ctf-question"),
      outcomeSlotCount: 3,
      payoutNumerators: [1n, 0n, 0n],
    };
    const events = [a, c, resolution];
    const { primary, secondary, poller, logs } = setup(events, { chunkSize: 50 }, DEPLOYMENT_BLOCK + 120n);
    await poller.start();
    await drain(poller);
    const ranges = rangesApplied(logs);
    for (const provider of [primary, secondary]) {
      const ctf = requestedIds(ctfCalls(provider), ranges);
      expect(ctf.get(1_000n)).toEqual(sorted(a.conditionId, c.conditionId));
      expect(ctf.get(1_050n)).toEqual([c.conditionId]);
      expect(ctf.get(1_100n)).toEqual([c.conditionId]);
    }
    expect(await model().getConditionResolution(a.conditionId)).not.toBeNull();
  });

  it("the active set is computed ONCE per processed range: size splits and re-checks reuse it on both providers", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "once");
    const other = claimCreated(b, "once-other");
    const events: ChainEvent[] = [created, other];
    for (let index = 0; index < 12; index += 1) {
      b.nextBlock();
      events.push(answer(b, created.questionId, BigInt(index + 1) * 10n ** 18n));
    }
    const statements: string[] = [];
    const counting: SqlExecutor = {
      exec: (sql) => database.db.exec(sql),
      query: (sql, params) => {
        statements.push(sql);
        return database.db.query(sql, params);
      },
      transaction: (fn) => database.db.transaction(fn),
    };
    const { primary, secondary, poller, logs } = setup(events, { db: counting, chunkSize: 16, recheckDelayMs: 0 });
    primary.failGetLogs = (query) => (query.addresses.includes(SCENARIO_ADDRESSES.reality) && query.toBlock - query.fromBlock + 1n > 4n ? "size" : null);
    let lagging = 1;
    const original = secondary.getLogs.bind(secondary);
    secondary.getLogs = async (query) => (query.topics[0]!.length > 1 && query.addresses.includes(SCENARIO_ADDRESSES.reality) && lagging-- > 0 ? [] : original(query));
    await poller.start();
    expect((await drain(poller)).at(-1)).toMatchObject({ kind: "idle" });
    const ranges = rangesApplied(logs);
    const activeQueries = statements.filter((sql) => sql.includes("r.question_id = q.reopened_by"));
    expect(activeQueries).toHaveLength(ranges.length);
    // The first range was re-checked once and split, and every Reality request of it, on both providers, used one id list.
    const first = ranges[0]!;
    const lists = [primary, secondary].flatMap((provider) => realityMainCalls(provider).filter((call) => call.from! >= first.from && call.to! <= first.to)).map((call) => call.query!.topics[1]);
    expect(lists.length).toBeGreaterThan(4);
    expect(new Set(lists.map((list) => JSON.stringify(list))).size).toBe(1);
    expect((await model().status()).halted).toBe(false);
  });

  it("the pruning clock (the cursor block's timestamp) is one both providers confirmed: a range-end timestamp-only difference halts", async () => {
    const b = new EventBuilder();
    for (let step = 0; step < 120; step += 1) b.nextBlock();
    const events = [claimCreated(b, "clock")];
    const { poller, secondary, chain } = setup(events, { chunkSize: 50 });
    const end = DEPLOYMENT_BLOCK + 49n;
    secondary.chain.headers.set(end, { ...chain.header(end), timestamp: chain.header(end).timestamp + 1 });
    await poller.start();
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "header_disagreement" });
    expect((await model().status()).indexedBlock).toBe(0n);
  });

  it("pruning never changes the read model: the frozen scenarios under a monotonic chain clock, one block per range", async () => {
    for (const scenario of [scenarioOracle()]) {
      await resetDatabase(database.db);
      const events = scenario.events;
      const last = events.at(-1)!;
      // The chain clock runs two question timeouts past the last event by the finalized block, so every question that can
      // finalize does so while the scenario is indexed.
      const finalized = last.blockNumber + 20n;
      const clock = chainClock(events, [[finalized, last.blockTimestamp + 2 * SCENARIO_QUESTION_TIMEOUT]]);
      const { poller, primary } = setup(events, { chunkSize: 1 }, finalized, (chain) => (chain.timestampOf = clock));
      await poller.start();
      expect((await drain(poller)).at(-1)).toMatchObject({ kind: "idle" });
      const questions = [...new Set(events.flatMap((event) => ("questionId" in event ? [event.questionId] : [])))];
      await expectSameAsReference(events, questions);
      // Pruning did happen: the last ranges requested fewer question ids than are stored.
      const stored = await database.db.query<{ count: string }>("SELECT count(*)::text AS count FROM pine_index.questions");
      const lastRequested = realityMainCalls(primary).at(-1)?.query!.topics[1]?.length ?? 0;
      expect(lastRequested).toBeLessThan(Number(stored[0]!.count));
    }
  });
});

describe("single-response anomalies are re-checked before halting (PRD-05 section 3b)", () => {
  const anomalies = [
    ["a log outside the requested range (primary)", "primary", "invalid_rpc_data", (logs: RawLog[], query: LogQuery) => (logs.length > 0 ? [{ ...logs[0]!, blockNumber: query.toBlock + 1n }, ...logs.slice(1)] : null)],
    ["a duplicate log (secondary)", "secondary", "invalid_rpc_data", (logs: RawLog[]) => (logs.length > 0 ? [...logs, logs[0]!] : null)],
    [
      "a strict-decode failure of a ClaimRegistry log not yet cross-checked (primary)",
      "primary",
      "decode_failure",
      (logs: RawLog[], query: LogQuery) => (logs.length > 0 && query.addresses.includes(SCENARIO_ADDRESSES.claimRegistry) ? [{ ...logs[0]!, data: logs[0]!.data.slice(0, 66) as `0x${string}` }, ...logs.slice(1)] : null),
    ],
  ] as const;

  it.each(anomalies)("%s once: the plan is re-fetched (both providers) after the (injectable) delay, no halt", async (_label, side, _reason, mutate) => {
    const events = scenarioOracle().events;
    const { poller, primary, secondary, sleeps } = setup(events, { recheckDelayMs: 0 });
    inject(side === "primary" ? primary : secondary, 1, mutate);
    await poller.start();
    expect((await drain(poller)).at(-1)).toMatchObject({ kind: "idle" });
    expect(sleeps).toEqual([0]);
    // The plan was run again from its first request: twice on the primary; on the secondary once per attempt that reached
    // the cross-check (twice when the anomaly came from the secondary).
    const key = (query: LogQuery | undefined): string => JSON.stringify(query, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    const first = key(primary.getLogsCalls()[0]!.query);
    expect(primary.getLogsCalls().filter((call) => key(call.query) === first)).toHaveLength(2);
    expect(secondary.getLogsCalls().filter((call) => key(call.query) === first)).toHaveLength(side === "secondary" ? 2 : 1);
    expect((await model().status()).halted).toBe(false);
    await expectSameAsReference(events, [...new Set(events.flatMap((event) => ("questionId" in event ? [event.questionId] : [])))]);
  });

  it.each(anomalies)("%s persisting: halts after 3 re-checks", async (_label, side, reason, mutate) => {
    const events = scenarioOracle().events;
    const { poller, primary, secondary, sleeps } = setup(events, { recheckDelayMs: 0 });
    inject(side === "primary" ? primary : secondary, Number.POSITIVE_INFINITY, mutate);
    await poller.start();
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason });
    expect(sleeps).toEqual([0, 0, 0]);
    expect((await model().status()).indexedBlock).toBe(0n);
  });

  /** HTTP providers over the scripted chain; `mutate` rewrites the parsed JSON-RPC response of the primary. */
  function httpSetup(events: readonly ChainEvent[], mutate: (body: Record<string, unknown>, method: string) => Record<string, unknown>) {
    const chain = new ScriptedChain(events.at(-1)!.blockNumber + 10n, events);
    const redact = createRedactor();
    const inner = jsonRpcFetch(chain);
    const methods: string[] = [];
    const fetchFn: FetchLike = async (input, init) => {
      const method = (JSON.parse(init.body) as { method: string }).method;
      methods.push(method);
      const body = (await (await inner(input, init)).json()) as Record<string, unknown>;
      return new Response(JSON.stringify(mutate(body, method)), { status: 200 });
    };
    const primary: RpcProvider = createHttpProvider({ label: "primary", url: "https://primary.invalid/rpc", redact, fetchFn });
    const secondary: RpcProvider = createHttpProvider({ label: "secondary", url: "https://secondary.invalid/rpc", redact, fetchFn: jsonRpcFetch(chain.clone()) });
    const sleeps: number[] = [];
    const poller = new Poller({
      db: database.db,
      primary,
      secondary,
      chainId: SCENARIO_CHAIN_ID,
      questionTimeout: SCENARIO_QUESTION_TIMEOUT,
      addresses: SCENARIO_ADDRESSES,
      deploymentBlock: DEPLOYMENT_BLOCK,
      redact,
      logger: captureLogger([]),
      recheckDelayMs: 0,
      sleep: async (ms) => void sleeps.push(ms),
    });
    return { poller, sleeps, methods };
  }

  it.each([
    ["a removed log", (result: unknown) => (Array.isArray(result) && result.length > 0 ? [{ ...(result[0] as object), removed: true }, ...result.slice(1)] : null)],
    ["a wrong-shape eth_getLogs result", (result: unknown) => (Array.isArray(result) && result.length > 0 ? { not: "an array" } : null)],
  ])("over the HTTP provider, %s from one provider is re-fetched once and does not halt", async (_label, alter) => {
    const events = scenarioOracle().events;
    let left = 1;
    const { poller, sleeps } = httpSetup(events, (body, method) => {
      if (method !== "eth_getLogs" || left <= 0) return body;
      const altered = alter(body.result);
      if (altered === null) return body;
      left -= 1;
      return { ...body, result: altered };
    });
    await poller.start();
    expect((await drain(poller)).at(-1)).toMatchObject({ kind: "idle" });
    expect(left).toBe(0);
    expect(sleeps).toEqual([0]);
    expect((await model().status()).halted).toBe(false);
  });

  it("over the HTTP provider, a wrong-shape header result is re-fetched once and does not halt; persisting, it halts (invalid_rpc_data)", async () => {
    const events = scenarioOracle().events;
    let left = 1;
    const once = httpSetup(events, (body, method) => (method === "eth_getBlockByNumber" && left-- > 0 ? { ...body, result: { number: "0x1" } } : body));
    await once.poller.start();
    await once.poller.runCycle();
    expect((await model().status()).halted).toBe(false);
    await resetDatabase(database.db);
    const always = httpSetup(events, (body, method) => (method === "eth_getBlockByNumber" ? { ...body, result: { number: "0x1" } } : body));
    // Startup re-verification is skipped (no stored cursor); the first header read is the finalized block.
    await always.poller.start();
    expect(await always.poller.runCycle()).toEqual({ kind: "halted", reason: "invalid_rpc_data" });
    expect(always.sleeps).toEqual([0, 0, 0]);
  });

  it("over the HTTP provider, JSON-RPC envelopes with extra members are accepted (only the fields used are validated)", async () => {
    const events = scenarioOracle().events;
    const { poller, sleeps } = httpSetup(events, (body) => ({ ...body, extra: { served_by: "backend-7" }, usage: 3 }));
    await poller.start();
    expect((await drain(poller)).at(-1)).toMatchObject({ kind: "idle" });
    expect(sleeps).toEqual([]);
    await expectSameAsReference(events, [...new Set(events.flatMap((event) => ("questionId" in event ? [event.questionId] : [])))]);
  });
});

// ------------------------------------------------------------------------------------- operator coverage gaps (indexers-004)

const rangeBytes = (logs: LogEntry[]): { from: bigint; to: bigint; bytes: number }[] =>
  logs.filter((entry) => entry.message === "range applied").map((entry) => ({ from: BigInt(String(entry.object.from)), to: BigInt(String(entry.object.to)), bytes: Number(entry.object.bytes) }));

describe("bounded fetching under floods (operator gaps 13 and 20)", () => {
  it("each cycle fetches at most the log cap plus one response from the primary, and at most the cap from the secondary", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "bounded-fetch");
    const events: ChainEvent[] = [created];
    for (let block = 0; block < 30; block += 1) {
      b.nextBlock();
      for (let index = 0; index < 12; index += 1) events.push(bounty(b, created.questionId, 1n));
    }
    const cap = 50;
    const responseCap = 60;
    const { poller, primary, secondary } = setup(events, { maxRangeLogs: cap, chunkSize: 500 });
    primary.maxLogsPerResponse = responseCap;
    secondary.maxLogsPerResponse = responseCap;
    await poller.start();
    let cycles = 0;
    for (;;) {
      const before = [primary.served.length, secondary.served.length];
      const result = await poller.runCycle();
      if (result.kind !== "advanced") break;
      cycles += 1;
      expect(primary.served.length - before[0]!).toBeLessThanOrEqual(cap + responseCap);
      expect(secondary.served.length - before[1]!).toBeLessThanOrEqual(cap);
    }
    expect(cycles).toBeGreaterThanOrEqual(7);
    await expectSameAsReference(events, [created.questionId]);
  });

  it("every range stays within the byte cap unless it is a single block", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "byte-cap");
    const events: ChainEvent[] = [created];
    for (let block = 0; block < 10; block += 1) {
      b.nextBlock();
      for (let index = 0; index < 4; index += 1) events.push(bounty(b, created.questionId, 1n));
    }
    const maxRangeBytes = 4_000;
    const { poller, logs } = setup(events, { maxRangeBytes });
    await poller.start();
    await drain(poller);
    const ranges = rangeBytes(logs);
    expect(ranges.length).toBeGreaterThan(3);
    for (const range of ranges) if (range.to > range.from) expect(range.bytes).toBeLessThanOrEqual(maxRangeBytes);
    expect(ranges.some((range) => range.bytes > maxRangeBytes / 2)).toBe(true);
  });

  it("run() over a one-block size failure backs off exponentially (capped) and never halts", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "stuck");
    b.nextBlock();
    const events = [created, answer(b, created.questionId, 10n ** 18n)];
    const sleeps: number[] = [];
    const controller = new AbortController();
    const { primary, poller } = setup(events, {
      backoffBaseMs: 1_000,
      backoffMaxMs: 4_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length >= 5) controller.abort();
      },
    });
    primary.failGetLogs = (query) => (query.addresses.includes(SCENARIO_ADDRESSES.reality) ? "size" : null);
    await poller.start();
    await poller.run(controller.signal);
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 4_000, 4_000]);
    expect((await model().status()).halted).toBe(false);
  });
});

describe("the reopen fixpoint cuts before the EARLIEST round-8 reopen (operator gap 19)", () => {
  it("two chains deeper than 8 rounds whose round-8 replacements appear in different blocks", async () => {
    const b = new EventBuilder();
    const x = claimCreated(b, "chain-x");
    const y = claimCreated(b, "chain-y");
    const events: ChainEvent[] = [x, y];
    const ids = { x: [x.questionId], y: [y.questionId] };
    const reopenBlocks = { x: [] as bigint[], y: [] as bigint[] };
    // X reopens on even offsets, Y one block later, eleven deep each.
    for (let depth = 1; depth <= 11; depth += 1) {
      for (const name of ["x", "y"] as const) {
        b.nextBlock();
        const current = ids[name].at(-1)!;
        events.push({ ...(answer(b, current, 10n ** 18n) as ChainEvent & { kind: "RealityNewAnswer" }), answer: REALITY_ANSWERED_TOO_SOON });
        const next = h(`${name}-replacement-${depth}`);
        const reopen: ChainEvent = { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityQuestionReopened", questionId: next, reopenedQuestionId: current };
        events.push(reopen);
        ids[name].push(next);
        reopenBlocks[name].push(reopen.blockNumber);
      }
    }
    b.nextBlock();
    events.push(answer(b, ids.x.at(-1)!, 3n * 10n ** 18n), answer(b, ids.y.at(-1)!, 3n * 10n ** 18n));
    const { poller, logs } = setup(events);
    await poller.start();
    expect((await drain(poller)).at(-1)).toMatchObject({ kind: "idle" });
    const ranges = rangesApplied(logs);
    const earliestRound8 = reopenBlocks.x[7]!;
    expect(earliestRound8).toBeLessThan(reopenBlocks.y[7]!);
    expect(ranges[0]!.to).toBe(earliestRound8 - 1n);
    expect((await model().getOracleQuestion(ids.x.at(-1)!))?.answerCount).toBe(1);
    expect((await model().getOracleQuestion(ids.y.at(-1)!))?.answerCount).toBe(1);
    await expectSameAsReference(events, [...ids.x, ...ids.y]);
  });
});
