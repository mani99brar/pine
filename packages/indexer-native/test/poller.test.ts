import "./lock.js";
import { Writable } from "node:stream";
import { toEventSelector } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChainEvent } from "@pine/shared/chain-events";
import { REALITY_ANSWERED_TOO_SOON, type ReadModel } from "@pine/shared/read-model";
import { MemoryReadModel } from "@pine/shared/testing/memory-read-model";
import {
  claimCreated,
  EventBuilder,
  SCENARIO_ADDRESSES,
  SCENARIO_CHAIN_ID,
  SCENARIO_QUESTION_TIMEOUT,
  scenarioClaimsAndEvidence,
  scenarioOracle,
} from "@pine/shared/testing/read-model-scenarios";
import type { Address, Hex32 } from "@pine/shared/types";
import type { SqlExecutor } from "../src/db.js";
import { createLogger } from "../src/logger.js";
import { createMetrics } from "../src/metrics.js";
import { Poller, StartupError, type CycleResult, type Logger, type PollerOptions } from "../src/poller.js";
import { createNativeReadModel } from "../src/read-model.js";
import { createRedactor } from "../src/redact.js";
import type { RawLog } from "../src/decode.js";
import { createHttpProvider, InvalidRpcDataError, RpcError, type FetchLike, type LogQuery, type RpcProvider } from "../src/rpc.js";
import { listHalts } from "../src/store.js";
import { countRows, readModelDigest, resetDatabase } from "./digest.js";
import { openDatabase, type TestDatabase } from "./harness.js";
import { inject, jsonRpcFetch, ScriptedChain, ScriptedProvider } from "./scripted-rpc.js";

const DEPLOYMENT_BLOCK = 1_000n;
const LOOK_ALIKE: Address = "0x000000000000000000000000000000000000beef";

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

function setup(events: readonly ChainEvent[], options: { finalized?: bigint; overrides?: Partial<PollerOptions> } = {}) {
  const finalized = options.finalized ?? (events.at(-1)?.blockNumber ?? DEPLOYMENT_BLOCK) + 10n;
  const chain = new ScriptedChain(finalized, events);
  const primary = new ScriptedProvider("primary", chain);
  const secondary = new ScriptedProvider("secondary", chain.clone());
  const logs: LogEntry[] = [];
  const poller = makePoller(primary, secondary, logs, options.overrides);
  return { chain, primary, secondary, poller, logs };
}

function makePoller(primary: RpcProvider, secondary: RpcProvider, logs: LogEntry[], overrides: Partial<PollerOptions> = {}): Poller {
  return new Poller({
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
    sleep: async () => undefined,
    ...overrides,
  });
}

async function drain(poller: Poller): Promise<CycleResult> {
  for (let guard = 0; guard < 500; guard += 1) {
    const result = await poller.runCycle();
    if (result.kind !== "advanced") return result;
  }
  throw new Error("did not finish");
}

const model = (): ReadModel => createNativeReadModel(database.db, { chainId: SCENARIO_CHAIN_ID });

function reference(events: readonly ChainEvent[]): MemoryReadModel {
  const memory = new MemoryReadModel({ chainId: SCENARIO_CHAIN_ID, questionTimeout: SCENARIO_QUESTION_TIMEOUT });
  memory.apply(events);
  return memory;
}

async function expectSameAsReference(events: readonly ChainEvent[]): Promise<void> {
  const memory = reference(events);
  const native = model();
  const claims = (await memory.listClaims({ order: "created_desc", limit: 100 })).items;
  expect((await native.listClaims({ order: "created_desc", limit: 100 })).items).toEqual(claims);
  const questions = new Set<Hex32>();
  for (const event of events) if ("questionId" in event) questions.add(event.questionId);
  for (const questionId of questions) {
    expect(await native.getOracleQuestion(questionId)).toEqual(await memory.getOracleQuestion(questionId));
    expect(await native.listOracleAnswers(questionId)).toEqual(await memory.listOracleAnswers(questionId));
    expect(await native.getArbitration(questionId)).toEqual(await memory.getArbitration(questionId));
  }
  for (const claim of claims) expect(await native.getConditionResolution(claim.conditionId)).toEqual(await memory.getConditionResolution(claim.conditionId));
  expect((await native.listEvidence({ limit: 100 })).items).toEqual((await memory.listEvidence({ limit: 100 })).items);
}

/** A delta-style flow inside a handful of blocks: claim, too-soon answer, reopen, answer and Kleros event on the replacement. */
function reopenWithinOneRange(): { events: ChainEvent[]; replacement: Hex32; original: Hex32 } {
  const b = new EventBuilder();
  const events: ChainEvent[] = [];
  const created = claimCreated(b, "two-phase");
  events.push(created);
  b.nextBlock();
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityNewAnswer", questionId: created.questionId, answer: REALITY_ANSWERED_TOO_SOON, historyHash: `0x${"11".repeat(32)}`, user: created.creator, bond: 10n ** 18n, ts: b.now(), isCommitment: false });
  b.nextBlock();
  const replacement = `0x${"22".repeat(32)}` as Hex32;
  // An answer to the replacement BEFORE the reopen is ignored (not yet tracked), exactly as the reference does.
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityNewAnswer", questionId: replacement, answer: `0x${"00".repeat(31)}01`, historyHash: `0x${"33".repeat(32)}`, user: created.creator, bond: 10n ** 18n, ts: b.now(), isCommitment: false });
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityQuestionReopened", questionId: replacement, reopenedQuestionId: created.questionId });
  b.nextBlock();
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityNewAnswer", questionId: replacement, answer: `0x${"00".repeat(32)}`, historyHash: `0x${"44".repeat(32)}`, user: created.creator, bond: 2n * 10n ** 18n, ts: b.now(), isCommitment: false });
  events.push({ ...b.envelope(SCENARIO_ADDRESSES.klerosHomeProxy), kind: "KlerosHome", stage: "RequestNotified", questionId: replacement, requester: created.creator, maxPrevious: 2n * 10n ** 18n, reason: null, answer: null });
  return { events, replacement, original: created.questionId };
}

/** Claims spread over many blocks, to exercise chunking. */
function spreadClaims(count: number, gap: number): ChainEvent[] {
  const b = new EventBuilder();
  const events: ChainEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    for (let step = 0; step < gap; step += 1) b.nextBlock();
    events.push(claimCreated(b, `spread-${index}`));
  }
  return events;
}

describe("poller: agreement and finality", () => {
  it("indexes the frozen scenarios when both providers agree and matches the reference", async () => {
    const events = scenarioOracle().events;
    const { poller, primary, secondary, chain } = setup(events);
    await poller.start();
    expect(await drain(poller)).toMatchObject({ kind: "idle" });
    await expectSameAsReference(events);
    const status = await model().status();
    expect(status).toMatchObject({ backend: "native", indexedBlock: chain.finalized, finalizedBlock: chain.finalized, headBlock: chain.finalized + 64n, halted: false });
    expect(status.indexedBlockTimestamp).toBe(chain.header(chain.finalized).timestamp);
    // The secondary ran the identical request plan (same filters, same ranges).
    expect(secondary.getLogsCalls().map((call) => call.query)).toEqual(primary.getLogsCalls().map((call) => call.query));
    expect(await countRows(database.db, "blocks")).toBe(new Set(events.map((event) => event.blockNumber)).size);
  });

  it("also indexes claims and evidence end to end", async () => {
    const events = scenarioClaimsAndEvidence().events;
    const { poller } = setup(events);
    await poller.start();
    await drain(poller);
    await expectSameAsReference(events);
  });

  it("SEC-IDX-06 providers disagreeing on the finalized hash at the same height halt (rpc_disagreement) and nothing advances", async () => {
    const events = scenarioOracle().events;
    const { poller, secondary, chain } = setup(events);
    secondary.chain.headers.set(chain.finalized, { ...chain.header(chain.finalized), hash: `0x${"ee".repeat(32)}` });
    await poller.start();
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "rpc_disagreement" });
    const status = await model().status();
    expect(status.halted).toBe(true);
    expect(status.indexedBlock).toBe(0n);
    expect(await countRows(database.db, "claims")).toBe(0);
    // Halted: later cycles make no RPC calls and never advance.
    const before = secondary.calls.length;
    expect(await poller.runCycle()).toEqual({ kind: "halted" });
    expect(secondary.calls.length).toBe(before);
    expect((await listHalts(database.db, SCENARIO_CHAIN_ID)).map((halt) => halt.reason)).toEqual(["rpc_disagreement"]);
  });

  it("SEC-IDX-06 different finalized heights: target is the lower one and its hash must match on the other provider", async () => {
    const events = scenarioOracle().events;
    const { poller, secondary, chain } = setup(events);
    secondary.chain.finalized = chain.finalized + 20n;
    await poller.start();
    await drain(poller);
    expect((await model().status()).finalizedBlock).toBe(chain.finalized);
    expect((await model().status()).indexedBlock).toBe(chain.finalized);

    await resetDatabase(database.db);
    const second = setup(events);
    const lower = second.chain.finalized;
    second.primary.chain.finalized = lower + 20n;
    second.secondary.chain.headers.set(lower, { ...second.chain.header(lower), hash: `0x${"dd".repeat(32)}` });
    await second.poller.start();
    expect(await second.poller.runCycle()).toEqual({ kind: "halted", reason: "rpc_disagreement" });
  });

  it("finalized lag: events above the finalized block are not indexed until both providers finalize them", async () => {
    const events = scenarioOracle().events;
    const cut = events[10]!.blockNumber;
    const { poller, primary, secondary } = setup(events, { finalized: cut - 1n });
    await poller.start();
    await drain(poller);
    expect((await model().status()).indexedBlock).toBe(cut - 1n);
    await expectSameAsReference(events.filter((event) => event.blockNumber < cut));
    primary.chain.finalized = events.at(-1)!.blockNumber;
    await drain(poller);
    // Only the primary moved: still limited by the secondary.
    expect((await model().status()).indexedBlock).toBe(cut - 1n);
    secondary.chain.finalized = events.at(-1)!.blockNumber;
    await drain(poller);
    await expectSameAsReference(events);
  });
});

const rangesApplied = (logs: LogEntry[]): { from: bigint; to: bigint; logs: number }[] =>
  logs.filter((entry) => entry.message === "range applied").map((entry) => ({ from: BigInt(String(entry.object.from)), to: BigInt(String(entry.object.to)), logs: Number(entry.object.logs) }));

describe("poller: ranges", () => {
  it("two-phase tracked ids within one range: the reopened replacement is tracked and its later events apply", async () => {
    const { events, replacement, original } = reopenWithinOneRange();
    const { poller, logs } = setup(events);
    await poller.start();
    await drain(poller);
    expect(rangesApplied(logs)).toHaveLength(1);
    const question = await model().getOracleQuestion(replacement);
    expect(question).toMatchObject({ reopens: original, answerCount: 1, bond: 2n * 10n ** 18n });
    expect((await model().getArbitration(replacement))?.stage).toBe("RequestNotified");
    expect((await model().getOracleQuestion(original))?.reopenedBy).toBe(replacement);
    await expectSameAsReference(events);
  });

  it("range chunking: processed ranges never exceed the chunk, are contiguous and cover the finalized range", async () => {
    const events = spreadClaims(9, 37);
    const { poller, primary, secondary, chain, logs } = setup(events, { overrides: { chunkSize: 50 } });
    await poller.start();
    await drain(poller);
    const ranges = rangesApplied(logs);
    expect(ranges.length).toBeGreaterThan(5);
    let next = DEPLOYMENT_BLOCK;
    for (const { from, to } of ranges) {
      expect(from).toBe(next);
      expect(to - from + 1n <= 50n).toBe(true);
      next = to + 1n;
    }
    expect(next - 1n).toBe(chain.finalized);
    for (const [from, to] of primary.getLogsRanges()) expect(to - from + 1n <= 50n).toBe(true);
    expect(secondary.getLogsCalls().map((call) => call.query)).toEqual(primary.getLogsCalls().map((call) => call.query));
    await expectSameAsReference(events);
  });

  it("transient provider errors retry the SAME request with capped backoff and never halt", async () => {
    const events = spreadClaims(3, 10);
    const sleeps: number[] = [];
    const { poller, primary } = setup(events, { overrides: { sleep: async (ms) => void sleeps.push(ms) } });
    let failures = 0;
    primary.failGetLogs = () => (failures++ < 2 ? "transient" : null);
    await poller.start();
    expect(await drain(poller)).toMatchObject({ kind: "idle" });
    const calls = primary.getLogsCalls();
    // The first request was attempted three times with an identical filter and range.
    expect(calls[1]!.query).toEqual(calls[0]!.query);
    expect(calls[2]!.query).toEqual(calls[0]!.query);
    expect(sleeps.slice(0, 2)).toEqual([500, 1_000]);
    expect((await model().status()).halted).toBe(false);
    await expectSameAsReference(events);
  });

  it("a request still failing after its retries fails the cycle (backoff, exponential and capped) without halting", async () => {
    const events = spreadClaims(2, 10);
    const sleeps: number[] = [];
    const controller = new AbortController();
    const { poller, secondary, logs } = setup(events, {
      overrides: {
        requestAttempts: 1,
        backoffBaseMs: 1_000,
        backoffMaxMs: 8_000,
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length >= 6) controller.abort();
        },
      },
    });
    secondary.failGetLogs = () => "transient";
    await poller.start();
    await poller.run(controller.signal);
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
    expect((await model().status()).halted).toBe(false);
    expect((await model().status()).indexedBlock).toBe(0n);
    expect(logs.some((entry) => entry.level === "warn" && String(entry.object.error).startsWith("RpcError"))).toBe(true);
  });

  it("SEC-IDX-04 an idempotent re-run of an already applied range leaves the read model identical", async () => {
    const events = scenarioOracle().events;
    const { poller } = setup(events);
    await poller.start();
    await drain(poller);
    const digest = await readModelDigest(database.db);
    // Simulate a re-run: rewind the cursor (as if the range had to be fetched again) and process it once more.
    await database.db.query("UPDATE pine_index.cursor SET indexed_block = $1::int8, indexed_block_hash = NULL WHERE chain_id = $2", [String(DEPLOYMENT_BLOCK - 1n), SCENARIO_CHAIN_ID]);
    await drain(poller);
    expect(await readModelDigest(database.db)).toBe(digest);
  });

  it("SEC-IDX-04 a crash between apply and cursor advance is impossible: one transaction, nothing persists", async () => {
    const events = scenarioOracle().events;
    const failing: SqlExecutor = {
      exec: (sql) => database.db.exec(sql),
      query: (sql, params) => database.db.query(sql, params),
      transaction: (fn) =>
        database.db.transaction((tx) =>
          fn({
            exec: (sql) => tx.exec(sql),
            query: async (sql, params) => {
              if (/SET indexed_block = \$2::int8/.test(sql)) throw new Error("simulated crash before the cursor advance");
              return tx.query(sql, params);
            },
            transaction: () => Promise.reject(new Error("nested")),
          }),
        ),
    };
    const { poller, primary, secondary } = setup(events, { overrides: { db: failing } });
    await poller.start();
    await expect(poller.runCycle()).rejects.toThrow(/simulated crash/);
    expect(await countRows(database.db, "answers")).toBe(0);
    expect(await countRows(database.db, "claims")).toBe(0);
    expect(await countRows(database.db, "questions")).toBe(0);
    expect((await model().status()).indexedBlock).toBe(0n);
    // A healthy process then applies the range exactly once.
    const healthy = makePoller(primary, secondary, []);
    await healthy.start();
    await drain(healthy);
    await expectSameAsReference(events);
  });
});

describe("poller: integrity halts", () => {
  it("a log whose blockHash differs from the canonical header halts (log_hash_mismatch)", async () => {
    const events = scenarioOracle().events;
    const { poller, primary, secondary } = setup(events);
    // logs[2] is a tracked Reality answer (untracked logs are never requested).
    for (const chain of [primary.chain, secondary.chain]) chain.logs[2] = { ...chain.logs[2]!, blockHash: `0x${"cc".repeat(32)}` };
    await poller.start();
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "log_hash_mismatch" });
    expect(await countRows(database.db, "claims")).toBe(0);
  });

  it("providers disagreeing on a header timestamp or hash of a block with logs halt (header_disagreement)", async () => {
    const events = scenarioOracle().events;
    const target = events[5]!;
    const first = setup(events);
    first.secondary.chain.headers.set(target.blockNumber, { ...first.chain.header(target.blockNumber), timestamp: target.blockTimestamp + 1 });
    await first.poller.start();
    expect(await first.poller.runCycle()).toEqual({ kind: "halted", reason: "header_disagreement" });

    await resetDatabase(database.db);
    const second = setup(events);
    second.secondary.chain.headers.set(target.blockNumber, { ...second.chain.header(target.blockNumber), hash: `0x${"bb".repeat(32)}` });
    await second.poller.start();
    expect(await second.poller.runCycle()).toEqual({ kind: "halted", reason: "header_disagreement" });
    expect(await countRows(database.db, "claims")).toBe(0);
  });

  it("a log that does not decode strictly under its topic0 halts (decode_failure), never skipped", async () => {
    const events = scenarioOracle().events;
    const { poller, primary, secondary } = setup(events);
    const index = primary.chain.logs.findIndex((log) => log.address === SCENARIO_ADDRESSES.reality);
    for (const chain of [primary.chain, secondary.chain]) chain.logs[index] = { ...chain.logs[index]!, data: chain.logs[index]!.data.slice(0, 66) as `0x${string}` };
    await poller.start();
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "decode_failure" });
    expect(await countRows(database.db, "claims")).toBe(0);
  });

  it("a Pine event outside the ChainEvent domain halts (repositoryId 0)", async () => {
    const b = new EventBuilder();
    const bad = { ...claimCreated(b, "bad-repo"), repositoryId: 0 };
    const { poller } = setup([bad]);
    await poller.start();
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "decode_failure" });
  });

  it("a Pine number field outside the ChainEvent domain halts (evidenceDeadline 2^53), on every re-check", async () => {
    const b = new EventBuilder();
    const bad = { ...claimCreated(b, "bad-deadline"), evidenceDeadline: 2 ** 53 };
    const { poller } = setup([bad]);
    await poller.start();
    await expectHaltedClean(await poller.runCycle(), "decode_failure");
  });

  it("the secondary omitting a tracked Reality answer halts (log_disagreement)", async () => {
    const events = scenarioOracle().events;
    const { poller, secondary } = setup(events);
    const answer = events.find((event) => event.kind === "RealityNewAnswer")!;
    secondary.omitLog = (log) => log.blockNumber === answer.blockNumber && log.logIndex === answer.logIndex;
    await poller.start();
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "log_disagreement" });
    expect(await countRows(database.db, "answers")).toBe(0);
  });

  it("the primary omitting a tracked Reality answer halts (log_disagreement): a faulty primary cannot hide an answer", async () => {
    const events = scenarioOracle().events;
    const { poller, primary } = setup(events);
    const answer = events.find((event) => event.kind === "RealityNewAnswer")!;
    primary.omitLog = (log) => log.blockNumber === answer.blockNumber && log.logIndex === answer.logIndex;
    await poller.start();
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "log_disagreement" });
  });

  it("the primary returning no logs where the secondary returns some halts (the secondary runs for empty ranges too)", async () => {
    const events = scenarioOracle().events;
    const { poller, primary } = setup(events);
    primary.omitLog = () => true;
    await poller.start();
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "log_disagreement" });
  });

  it("the compared tuple includes transactionHash and data", async () => {
    const events = scenarioOracle().events;
    const first = setup(events);
    first.secondary.chain.logs[2] = { ...first.secondary.chain.logs[2]!, transactionHash: `0x${"aa".repeat(32)}` };
    await first.poller.start();
    expect(await first.poller.runCycle()).toEqual({ kind: "halted", reason: "log_disagreement" });
    await resetDatabase(database.db);
    const second = setup(events);
    const log = second.secondary.chain.logs[2]!;
    second.secondary.chain.logs[2] = { ...log, data: `${log.data.slice(0, -2)}ff` as `0x${string}` };
    await second.poller.start();
    expect(await second.poller.runCycle()).toEqual({ kind: "halted", reason: "log_disagreement" });
  });

  it("a secondary differing ONLY in topics halts (log_disagreement)", async () => {
    const events = scenarioOracle().events;
    const { poller, secondary } = setup(events);
    // logs[2] is alice's LogNewAnswer: topics [topic0, question_id, user]; a different user still matches the filter.
    const log = secondary.chain.logs[2]!;
    secondary.chain.logs[2] = { ...log, topics: [log.topics[0]!, log.topics[1]!, `0x${"00".repeat(12)}${"ee".repeat(20)}` as Hex32] };
    await poller.start();
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "log_disagreement" });
    expect(await countRows(database.db, "answers")).toBe(0);
  });

  it("a secondary differing ONLY in a log's blockHash halts (log_disagreement)", async () => {
    const events = scenarioOracle().events;
    const { poller, secondary } = setup(events);
    secondary.chain.logs[2] = { ...secondary.chain.logs[2]!, blockHash: `0x${"cd".repeat(32)}` };
    await poller.start();
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "log_disagreement" });
    expect(await countRows(database.db, "answers")).toBe(0);
  });

  it("the range-end header of a logless chunk is cross-checked (header_disagreement)", async () => {
    const b = new EventBuilder();
    for (let step = 0; step < 120; step += 1) b.nextBlock();
    const events = [claimCreated(b, "late")];
    const { poller, secondary } = setup(events, { overrides: { chunkSize: 50 } });
    const end = DEPLOYMENT_BLOCK + 49n;
    secondary.chain.headers.set(end, { number: end, hash: `0x${"ab".repeat(32)}`, timestamp: 1 });
    await poller.start();
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "header_disagreement" });
    expect((await listHalts(database.db, SCENARIO_CHAIN_ID))[0]?.blockNumber).toBe(end);
    expect((await model().status()).indexedBlock).toBe(0n);
  });

  it("headers are fetched only for blocks with logs plus the range end, on both providers", async () => {
    const events = scenarioOracle().events;
    const { poller, primary, secondary, chain } = setup(events);
    await poller.start();
    await drain(poller);
    const expected = [...new Set([...events.map((event) => event.blockNumber), chain.finalized])].sort((x, y) => (x < y ? -1 : 1));
    expect(primary.headerCalls()).toEqual(expected);
    expect(secondary.headerCalls()).toEqual(expected);
  });

  it("SEC-IDX-05 a look-alike contract emitting an identical event is ignored", async () => {
    const b = new EventBuilder();
    const genuine = claimCreated(b, "genuine");
    b.nextBlock();
    const fake = { ...claimCreated(b, "fake"), address: LOOK_ALIKE };
    const { poller, primary, secondary } = setup([genuine, fake]);
    // Providers that (wrongly) return logs of other addresses: still ignored by the poller.
    primary.ignoreAddressFilter = true;
    secondary.ignoreAddressFilter = true;
    await poller.start();
    expect(await drain(poller)).toMatchObject({ kind: "idle" });
    expect(await model().getClaim(genuine.market)).not.toBeNull();
    expect(await model().getClaim(fake.market)).toBeNull();
    expect((await model().status()).halted).toBe(false);
  });
});

describe("poller: startup", () => {
  it("SEC-IDX-06 refuses to start when either provider serves another chain id", async () => {
    for (const which of ["primary", "secondary"] as const) {
      const { poller, primary, secondary } = setup(scenarioOracle().events);
      (which === "primary" ? primary : secondary).chainIdValue = 10_200;
      await expect(poller.start()).rejects.toThrow(StartupError);
      await expect(poller.runCycle()).rejects.toThrow(StartupError);
    }
    expect(await countRows(database.db, "cursor")).toBe(0);
  });

  it("re-verifies the stored cursor hash against both providers (mismatch: halt finalized_conflict)", async () => {
    const events = scenarioOracle().events;
    const { poller, primary, secondary, chain } = setup(events);
    await poller.start();
    await drain(poller);
    // A clean restart verifies and continues.
    const restarted = makePoller(primary, secondary, []);
    await restarted.start();
    expect((await model().status()).halted).toBe(false);
    // The secondary now reports another hash for the stored cursor block.
    secondary.chain.headers.set(chain.finalized, { ...chain.header(chain.finalized), hash: `0x${"99".repeat(32)}` });
    const conflicted = makePoller(primary, secondary, []);
    await conflicted.start();
    expect((await model().status()).halted).toBe(true);
    expect((await listHalts(database.db, SCENARIO_CHAIN_ID)).map((halt) => halt.reason)).toEqual(["finalized_conflict"]);
    expect(await conflicted.runCycle()).toEqual({ kind: "halted" });
  });

  it("a PRIMARY-side stored-cursor hash mismatch also halts (finalized_conflict)", async () => {
    const events = scenarioOracle().events;
    const { poller, primary, secondary, chain } = setup(events);
    await poller.start();
    await drain(poller);
    primary.chain.headers.set(chain.finalized, { ...chain.header(chain.finalized), hash: `0x${"98".repeat(32)}` });
    const conflicted = makePoller(primary, secondary, []);
    await conflicted.start();
    expect((await listHalts(database.db, SCENARIO_CHAIN_ID)).map((halt) => halt.reason)).toEqual(["finalized_conflict"]);
    expect((await listHalts(database.db, SCENARIO_CHAIN_ID))[0]?.detail).toContain("primary");
    expect(await conflicted.runCycle()).toEqual({ kind: "halted" });
  });

  it("readiness is false while halted (/readyz 503) and the halted metric is 1", async () => {
    const events = scenarioOracle().events;
    const metrics = createMetrics();
    const { poller, secondary, chain } = setup(events, { overrides: { metrics } });
    await poller.start();
    await drain(poller);
    expect(await poller.isReady(60_000)).toBe(true);
    secondary.chain.finalized = chain.finalized + 5n;
    secondary.chain.headers.set(chain.finalized + 5n, { number: chain.finalized + 5n, hash: `0x${"77".repeat(32)}`, timestamp: 1 });
    chain.finalized += 5n;
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "rpc_disagreement" });
    expect(await poller.isReady(60_000)).toBe(false);
    expect(await metrics.registry.metrics()).toContain("pine_indexer_halted 1");
  });

  it("exposes metrics and readiness from the cursor tables", async () => {
    const events = scenarioOracle().events;
    const metrics = createMetrics();
    const { poller, chain } = setup(events, { overrides: { metrics } });
    expect(await poller.isReady(60_000)).toBe(false);
    await poller.start();
    await drain(poller);
    expect(await poller.isReady(60_000)).toBe(true);
    const text = await metrics.registry.metrics();
    expect(text).toContain(`pine_indexer_indexed_block ${chain.finalized}`);
    expect(text).toContain(`pine_indexer_finalized_block ${chain.finalized}`);
    expect(text).toContain("pine_indexer_halted 0");
    expect(text).toMatch(/pine_indexer_cycles_total [1-9]/);
    expect(text).toContain(`pine_indexer_lag_seconds ${1_900_000_000 - chain.header(chain.finalized).timestamp}`);
  });
});

describe("poller over the HTTP JSON-RPC provider (served from a scripted chain)", () => {
  const FAKE_KEY = "k3y-0123456789abcdef-SECRET";

  it("indexes the oracle scenario through the real provider with strict response validation", async () => {
    const events = scenarioOracle().events;
    const chain = new ScriptedChain(events.at(-1)!.blockNumber + 3n, events);
    const redact = createRedactor();
    const primary = createHttpProvider({ label: "primary", url: "https://primary.invalid/rpc", redact, fetchFn: jsonRpcFetch(chain) });
    const secondary = createHttpProvider({ label: "secondary", url: "https://secondary.invalid/rpc", redact, fetchFn: jsonRpcFetch(chain.clone()) });
    const poller = makePoller(primary, secondary, []);
    await poller.start();
    await drain(poller);
    await expectSameAsReference(events);
  });

  it("SEC-OPS-03 an RPC URL containing a key never appears in any log line, error or halt", async () => {
    const url = `https://gnosis.example-rpc.io/v2/${FAKE_KEY}?apikey=${FAKE_KEY}`;
    const redact = createRedactor([url, FAKE_KEY]);
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString("utf8"));
        callback();
      },
    });
    const logger = createLogger(redact, "debug", stream);
    // Upstream failures that echo the URL (fetch errors, JSON-RPC error messages and error bodies all do in practice).
    const leaking: FetchLike = async (input) => {
      throw new Error(`connect ECONNREFUSED while fetching ${input}`, { cause: new Error(input) });
    };
    const rpcErrorEchoingUrl: FetchLike = async (_input, init) => {
      const { id } = JSON.parse(init.body) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: `invalid key for ${url}` } }), { status: 200 });
    };
    const failing401: FetchLike = async () => new Response(`invalid key for ${url}`, { status: 401 });
    const chain = new ScriptedChain(1_010n, []);
    for (const fetchFn of [leaking, rpcErrorEchoingUrl, failing401]) {
      const primary = createHttpProvider({ label: "primary", url, redact, fetchFn });
      const secondary = createHttpProvider({ label: "secondary", url: "https://secondary.invalid/rpc", redact, fetchFn: jsonRpcFetch(chain) });
      const errors: unknown[] = [];
      for (const call of [() => primary.chainId(), () => primary.getLogs({ addresses: [], topics: [], fromBlock: 1n, toBlock: 2n }), () => primary.blockHeader(5n)]) {
        await call().catch((error: unknown) => errors.push(error));
      }
      expect(errors).toHaveLength(3);
      for (const error of errors) {
        expect(error).toBeInstanceOf(RpcError);
        const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""} ${String((error as { cause?: unknown }).cause)}`;
        expect(text).not.toContain(FAKE_KEY);
        expect((error as { cause?: unknown }).cause).toBeUndefined();
      }
      const controller = new AbortController();
      let sleeps = 0;
      const poller = new Poller({
        db: database.db,
        primary,
        secondary,
        chainId: 100,
        questionTimeout: SCENARIO_QUESTION_TIMEOUT,
        addresses: SCENARIO_ADDRESSES,
        deploymentBlock: DEPLOYMENT_BLOCK,
        redact,
        logger,
        sleep: async () => {
          sleeps += 1;
          if (sleeps >= 2) controller.abort();
        },
      });
      await expect(poller.start()).rejects.toThrow(RpcError);
      await poller.run(controller.signal).catch(() => undefined);
      logger.error({ error: errors[0], url }, `direct attempt to log ${url}`);
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(FAKE_KEY);
    for (const halt of await listHalts(database.db, 100)) expect(halt.detail).not.toContain(FAKE_KEY);
  });
});

// ------------------------------------------------------------------------------------- operator coverage gaps (indexers-004)

/** A halted cycle with nothing applied: status, halt reason and empty read-model tables. */
async function expectHaltedClean(result: CycleResult, reason: string): Promise<void> {
  expect(result).toEqual({ kind: "halted", reason });
  const status = await model().status();
  expect(status.halted).toBe(true);
  expect(status.indexedBlock).toBe(0n);
  expect((await listHalts(database.db, SCENARIO_CHAIN_ID)).map((halt) => halt.reason)).toEqual([reason]);
  for (const table of ["claims", "questions", "answers", "evidence"]) expect(await countRows(database.db, table), table).toBe(0);
}

/** HTTP providers over a scripted chain whose responses (parsed JSON-RPC bodies) pass through `mutate` on both sides. */
function httpPair(chain: ScriptedChain, mutate: (body: Record<string, unknown>, method: string, params: unknown[]) => Record<string, unknown>) {
  const wrap = (inner: FetchLike): FetchLike => async (input, init) => {
    const request = JSON.parse(init.body) as { method: string; params: unknown[] };
    const body = (await (await inner(input, init)).json()) as Record<string, unknown>;
    return new Response(JSON.stringify(mutate(body, request.method, request.params)), { status: 200 });
  };
  const redact = createRedactor();
  return {
    primary: createHttpProvider({ label: "primary", url: "https://primary.invalid/rpc", redact, fetchFn: wrap(jsonRpcFetch(chain)) }),
    secondary: createHttpProvider({ label: "secondary", url: "https://secondary.invalid/rpc", redact, fetchFn: wrap(jsonRpcFetch(chain.clone())) }),
  };
}

describe("poller: invalid RPC data halts (invalid_rpc_data) when it persists on re-check (operator gap 1)", () => {
  it("both providers returning a tracked log outside the requested block range halt", async () => {
    const events = scenarioOracle().events;
    const { poller, primary, secondary } = setup(events);
    const outside = (logs: RawLog[], query: LogQuery) => (logs.length > 0 ? [{ ...logs[0]!, blockNumber: query.toBlock + 1n }, ...logs.slice(1)] : null);
    inject(primary, Number.POSITIVE_INFINITY, outside);
    inject(secondary, Number.POSITIVE_INFINITY, outside);
    await poller.start();
    await expectHaltedClean(await poller.runCycle(), "invalid_rpc_data");
    expect((await listHalts(database.db, SCENARIO_CHAIN_ID))[0]?.detail).toMatch(/outside/);
  });

  it("a response containing one log twice halts", async () => {
    const events = scenarioOracle().events;
    const { poller, primary, secondary } = setup(events);
    for (const provider of [primary, secondary]) inject(provider, Number.POSITIVE_INFINITY, (logs) => (logs.length > 0 ? [...logs, logs[0]!] : null));
    await poller.start();
    await expectHaltedClean(await poller.runCycle(), "invalid_rpc_data");
    expect((await listHalts(database.db, SCENARIO_CHAIN_ID))[0]?.detail).toMatch(/duplicate/);
  });

  it("a removed:true log served over HTTP halts (SEC-IDX-04: only finalized data is requested)", async () => {
    const events = scenarioOracle().events;
    const chain = new ScriptedChain(events.at(-1)!.blockNumber + 3n, events);
    const { primary, secondary } = httpPair(chain, (body, method) =>
      method === "eth_getLogs" && Array.isArray(body.result) && body.result.length > 0 ? { ...body, result: [{ ...(body.result[0] as object), removed: true }, ...body.result.slice(1)] } : body,
    );
    const poller = makePoller(primary, secondary, []);
    await poller.start();
    await expectHaltedClean(await poller.runCycle(), "invalid_rpc_data");
    expect((await listHalts(database.db, SCENARIO_CHAIN_ID))[0]?.detail).toMatch(/removed log/);
  });

  it("a non-array eth_getLogs result over HTTP halts", async () => {
    const events = scenarioOracle().events;
    const chain = new ScriptedChain(events.at(-1)!.blockNumber + 3n, events);
    const { primary, secondary } = httpPair(chain, (body, method) => (method === "eth_getLogs" ? { ...body, result: { logs: body.result } } : body));
    const poller = makePoller(primary, secondary, []);
    await poller.start();
    await expectHaltedClean(await poller.runCycle(), "invalid_rpc_data");
  });

  it("a header for another block number halts", async () => {
    const events = scenarioOracle().events;
    const { poller, primary } = setup(events);
    const original = primary.blockHeader.bind(primary);
    primary.blockHeader = async (number) => ({ ...(await original(number)), number: number + 1n });
    await poller.start();
    await expectHaltedClean(await poller.runCycle(), "invalid_rpc_data");
    expect((await listHalts(database.db, SCENARIO_CHAIN_ID))[0]?.detail).toMatch(/another number/);
  });

  it("two requests returning different content at the same (blockHash, logIndex) halt", async () => {
    // The reopen log is returned twice: by the reopen discovery and by the main Reality request of the replacement.
    const { events } = reopenWithinOneRange();
    const { poller, primary, secondary } = setup(events);
    const reopenTopic0 = toEventSelector("LogReopenQuestion(bytes32,bytes32)");
    const alter = (logs: RawLog[], query: LogQuery) =>
      query.topics[0]!.length > 1 && logs.some((log) => log.topics[0] === reopenTopic0)
        ? logs.map((log) => (log.topics[0] === reopenTopic0 ? { ...log, transactionHash: `0x${"5a".repeat(32)}` as Hex32 } : log))
        : null;
    inject(primary, Number.POSITIVE_INFINITY, alter);
    inject(secondary, Number.POSITIVE_INFINITY, alter);
    await poller.start();
    await expectHaltedClean(await poller.runCycle(), "invalid_rpc_data");
    expect((await listHalts(database.db, SCENARIO_CHAIN_ID))[0]?.detail).toMatch(/two different logs/);
  });

  it("a malformed header during the stored-cursor re-verification halts at startup instead of throwing", async () => {
    const events = scenarioOracle().events;
    const { poller, primary, secondary } = setup(events);
    await poller.start();
    await drain(poller);
    secondary.blockHeader = async () => {
      throw new InvalidRpcDataError("eth_getBlockByNumber returned data of an unexpected shape");
    };
    const restarted = makePoller(primary, secondary, []);
    await expect(restarted.start()).resolves.toBeUndefined();
    expect((await model().status()).halted).toBe(true);
    expect((await listHalts(database.db, SCENARIO_CHAIN_ID)).map((halt) => halt.reason)).toEqual(["invalid_rpc_data"]);
    expect(await restarted.runCycle()).toEqual({ kind: "halted" });
  });
});

describe("poller: the compared set is the full (blockHash, logIndex, topics, data) set, order-independent (operator gap 3)", () => {
  it("a secondary differing ONLY in a log's logIndex halts (log_disagreement)", async () => {
    const events = scenarioOracle().events;
    const { poller, secondary } = setup(events);
    const target = events.find((event) => event.kind === "RealityNewAnswer")!;
    secondary.alterLog = (log) => (log.blockNumber === target.blockNumber && log.logIndex === target.logIndex ? { ...log, logIndex: log.logIndex + 50 } : log);
    await poller.start();
    await expectHaltedClean(await poller.runCycle(), "log_disagreement");
  });

  it("a primary swapping the logIndex of two answers in one block halts (they would apply in the wrong order)", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "swap");
    b.nextBlock();
    const user = created.creator;
    const first: ChainEvent = { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityNewAnswer", questionId: created.questionId, answer: `0x${"00".repeat(31)}01`, historyHash: `0x${"61".repeat(32)}`, user, bond: 10n ** 18n, ts: b.now(), isCommitment: false };
    const second: ChainEvent = { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityNewAnswer", questionId: created.questionId, answer: `0x${"00".repeat(32)}`, historyHash: `0x${"62".repeat(32)}`, user, bond: 2n * 10n ** 18n, ts: b.now(), isCommitment: false };
    const events = [created, first, second];
    const { poller, primary } = setup(events);
    primary.alterLog = (log) => (log.blockNumber === first.blockNumber && (log.logIndex === 0 || log.logIndex === 1) ? { ...log, logIndex: 1 - log.logIndex } : log);
    await poller.start();
    await expectHaltedClean(await poller.runCycle(), "log_disagreement");
  });

  it("the same logs in another order on the secondary do not halt and match the reference", async () => {
    const events = scenarioOracle().events;
    const { poller, secondary } = setup(events);
    inject(secondary, Number.POSITIVE_INFINITY, (logs) => (logs.length > 1 ? [...logs].reverse() : null));
    await poller.start();
    expect(await drain(poller)).toMatchObject({ kind: "idle" });
    expect((await model().status()).halted).toBe(false);
    await expectSameAsReference(events);
  });
});

describe("poller: the agreed finalized target (operator gap 4, SEC-IDX-06)", () => {
  it("the primary's finalized block is lower and the secondary's header at that height differs: halt rpc_disagreement", async () => {
    const events = scenarioOracle().events;
    const { poller, secondary, chain } = setup(events);
    const lower = chain.finalized;
    secondary.chain.finalized = lower + 20n;
    secondary.chain.headers.set(lower, { ...chain.header(lower), hash: `0x${"d1".repeat(32)}` });
    await poller.start();
    await expectHaltedClean(await poller.runCycle(), "rpc_disagreement");
    expect(secondary.headerCalls()).toEqual([lower]);
  });

  it("both providers' finalized tag reports hash H while both canonical headers at that height are H': halt rpc_disagreement", async () => {
    const events = scenarioOracle().events;
    const { poller, primary, secondary, chain } = setup(events);
    const tagged = { ...chain.header(chain.finalized), hash: `0x${"f0".repeat(32)}` as Hex32 };
    primary.finalizedHeader = tagged;
    secondary.finalizedHeader = tagged;
    await poller.start();
    await expectHaltedClean(await poller.runCycle(), "rpc_disagreement");
    expect((await listHalts(database.db, SCENARIO_CHAIN_ID))[0]?.blockNumber).toBe(chain.finalized);
  });
});

describe("poller: a finalized-hash disagreement freezes finality and alerts (operator gap 6, SEC-IDX-06)", () => {
  it("finalizedBlock stays null, the halt is logged with its reason, the halted metric is 1 and halted cycles make no RPC call on either provider", async () => {
    const events = scenarioOracle().events;
    const metrics = createMetrics();
    const { poller, primary, secondary, chain, logs } = setup(events, { overrides: { metrics } });
    secondary.chain.headers.set(chain.finalized, { ...chain.header(chain.finalized), hash: `0x${"ee".repeat(32)}` });
    await poller.start();
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "rpc_disagreement" });
    expect((await model().status()).finalizedBlock).toBeNull();
    const text = await metrics.registry.metrics();
    expect(text).toContain("pine_indexer_finalized_block 0");
    expect(text).toContain("pine_indexer_halted 1");
    expect(logs.filter((entry) => entry.level === "error" && entry.message === "indexer halted on an integrity conflict").map((entry) => entry.object.reason)).toEqual(["rpc_disagreement"]);
    const before = [primary.calls.length, secondary.calls.length];
    for (let cycle = 0; cycle < 3; cycle += 1) expect(await poller.runCycle()).toEqual({ kind: "halted" });
    expect([primary.calls.length, secondary.calls.length]).toEqual(before);
    expect((await model().status()).finalizedBlock).toBeNull();
    expect(await metrics.registry.metrics()).toContain("pine_indexer_finalized_block 0");
  });

  it("errors_total counts failed cycles by kind (rpc) and re-checks (provider_difference)", async () => {
    const events = scenarioOracle().events;
    const metrics = createMetrics();
    const controller = new AbortController();
    let sleeps = 0;
    const { poller, primary, secondary } = setup(events, {
      overrides: {
        metrics,
        requestAttempts: 1,
        sleep: async () => {
          sleeps += 1;
          if (sleeps >= 4) controller.abort();
        },
      },
    });
    let failing = 1;
    primary.failGetLogs = () => (failing-- > 0 ? "transient" : null);
    let lagging = 1;
    const original = secondary.getLogs.bind(secondary);
    secondary.getLogs = async (query) => {
      const logs = await original(query);
      return logs.length > 0 && lagging-- > 0 ? [] : logs;
    };
    await poller.start();
    await poller.run(controller.signal);
    const text = await metrics.registry.metrics();
    expect(text).toContain('pine_indexer_errors_total{kind="rpc"} 1');
    expect(text).toContain('pine_indexer_errors_total{kind="provider_difference"} 1');
    expect((await model().status()).halted).toBe(false);
  });
});

describe("poller: redaction in real cycles (operator gap 7, SEC-OPS-03)", () => {
  const KEY = "Zq9xKEYk3y0123456789secret";
  const URL_WITH_KEY = `https://gnosis.example-rpc.io/v2/${KEY}`;
  const DB_URL = "postgres://pine_indexer:Db-Passw0rd-xyz@db.internal:5432/pine";

  function capture(): { stream: Writable; lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      stream: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          lines.push(chunk.toString("utf8"));
          callback();
        },
      }),
    };
  }

  it("cycle warnings, halt log lines and halt details never contain an RPC key or a database password", async () => {
    const events = scenarioOracle().events;
    const out = capture();
    const redact = createRedactor([URL_WITH_KEY, KEY, DB_URL, "Db-Passw0rd-xyz"]);
    const logger = createLogger(redact, "debug", out.stream);
    const chain = new ScriptedChain(events.at(-1)!.blockNumber + 5n, events);
    const primary = new ScriptedProvider("primary", chain);
    const secondary = new ScriptedProvider("secondary", chain.clone());
    // 1. Transient failures whose messages echo the key-bearing URL (a provider that does not redact), through run().
    let failures = 2;
    const getLogs = primary.getLogs.bind(primary);
    primary.getLogs = async (query) => {
      if (failures-- > 0) throw new RpcError(`primary eth_getLogs failed: 503 from ${URL_WITH_KEY}`);
      return getLogs(query);
    };
    // 2. A database error echoing the connection string, mid-cycle.
    let dbFailures = 1;
    const db: SqlExecutor = {
      exec: (sql) => database.db.exec(sql),
      query: async (sql, params) => {
        if (sql.includes("finalized_block, head_block) VALUES") && dbFailures-- > 0) throw new Error(`connection to ${DB_URL} lost`);
        return database.db.query(sql, params);
      },
      transaction: (fn) => database.db.transaction(fn),
    };
    const controller = new AbortController();
    let sleeps = 0;
    const poller = new Poller({
      db,
      primary,
      secondary,
      chainId: SCENARIO_CHAIN_ID,
      questionTimeout: SCENARIO_QUESTION_TIMEOUT,
      addresses: SCENARIO_ADDRESSES,
      deploymentBlock: DEPLOYMENT_BLOCK,
      redact,
      logger,
      requestAttempts: 1,
      recheckDelayMs: 0,
      sleep: async () => {
        sleeps += 1;
        if (sleeps >= 4) controller.abort();
      },
    });
    await poller.start();
    await poller.run(controller.signal);
    const warnings = out.lines.filter((line) => line.includes("indexer cycle failed"));
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.some((line) => line.includes("[REDACTED]"))).toBe(true);
    // 3. A halt whose error text echoes the URL: invalid data from the primary on every re-check.
    await resetDatabase(database.db);
    chain.finalized += 1n;
    primary.blockHeader = async () => {
      throw new InvalidRpcDataError(`eth_getBlockByNumber from ${URL_WITH_KEY} returned data of an unexpected shape`);
    };
    expect(await poller.runCycle()).toMatchObject({ kind: "halted", reason: "invalid_rpc_data" });
    const halts = await listHalts(database.db, SCENARIO_CHAIN_ID);
    expect(halts.length).toBeGreaterThan(0);
    for (const halt of halts) expect(halt.detail).not.toContain(KEY);
    expect(out.lines.some((line) => line.includes("indexer halted on an integrity conflict"))).toBe(true);
    for (const line of out.lines) {
      expect(line).not.toContain(KEY);
      expect(line).not.toContain("Db-Passw0rd-xyz");
    }
  });
});

describe("poller: logs outside the requested filter are ignored (operator gap 8, SEC-IDX-05)", () => {
  it("providers ignoring the topic filters (unrequested topic0s, spam on untracked questions) change nothing and never halt", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "topic-filter");
    b.nextBlock();
    const tracked: ChainEvent = { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityNewAnswer", questionId: created.questionId, answer: `0x${"00".repeat(31)}01`, historyHash: `0x${"71".repeat(32)}`, user: created.creator, bond: 10n ** 18n, ts: b.now(), isCommitment: false };
    const spam: ChainEvent = { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityNewAnswer", questionId: `0x${"5b".repeat(32)}`, answer: `0x${"00".repeat(32)}`, historyHash: `0x${"72".repeat(32)}`, user: created.creator, bond: 1n, ts: b.now(), isCommitment: false };
    const events = [created, tracked, spam];
    const { poller, primary, secondary } = setup(events);
    // A Reality LogNewQuestion (a topic0 the plan never requests) with garbage data: decoding it would halt.
    const newQuestion: RawLog = {
      address: SCENARIO_ADDRESSES.reality,
      topics: [toEventSelector("LogNewQuestion(bytes32,address,uint256,string,bytes32,address,uint32,uint32,uint256,uint256)"), `0x${"5c".repeat(32)}`, `0x${"00".repeat(12)}${"ab".repeat(20)}`, `0x${"5d".repeat(32)}`],
      data: "0x1234",
      blockNumber: tracked.blockNumber,
      blockHash: tracked.blockHash,
      transactionHash: `0x${"5e".repeat(32)}`,
      logIndex: 7,
    };
    for (const provider of [primary, secondary]) {
      provider.chain.logs.push({ ...newQuestion });
      provider.ignoreTopicFilter = true;
    }
    await poller.start();
    expect(await drain(poller)).toMatchObject({ kind: "idle" });
    expect((await model().status()).halted).toBe(false);
    // The providers did serve the unrequested logs; the poller dropped them.
    expect(primary.served.some((log) => log.topics[1] === spam.questionId)).toBe(true);
    expect(primary.served.some((log) => log.topics[0] === newQuestion.topics[0])).toBe(true);
    expect(await model().getOracleQuestion(spam.questionId)).toBeNull();
    expect(await model().listOracleAnswers(created.questionId)).toHaveLength(1);
    await expectSameAsReference(events);
  });
});

describe("poller: per-block hashes (operator gap 14)", () => {
  it("records (number, canonical hash, timestamp) for every event block; a conflicting canonical hash on a re-run halts (finalized_conflict)", async () => {
    const events = scenarioOracle().events;
    const { poller, primary, secondary, chain } = setup(events);
    await poller.start();
    await drain(poller);
    const rows = await database.db.query<{ block_number: string; block_hash: string; block_timestamp: string }>(
      "SELECT block_number::text AS block_number, block_hash, block_timestamp::text AS block_timestamp FROM pine_index.blocks ORDER BY block_number",
    );
    const blocks = [...new Set(events.map((event) => event.blockNumber))].sort((x, y) => (x < y ? -1 : 1));
    expect(rows).toEqual(blocks.map((number) => ({ block_number: number.toString(), block_hash: chain.header(number).hash, block_timestamp: String(chain.header(number).timestamp) })));
    const digest = await readModelDigest(database.db);
    // Both providers now report another canonical hash (and matching log hashes) for a recorded block.
    const changed = blocks[1]!;
    const other = `0x${"c3".repeat(32)}` as Hex32;
    for (const provider of [primary, secondary]) {
      provider.chain.headers.set(changed, { ...provider.chain.header(changed), hash: other });
      provider.chain.logs = provider.chain.logs.map((log) => (log.blockNumber === changed ? { ...log, blockHash: other } : log));
    }
    await database.db.query("UPDATE pine_index.cursor SET indexed_block = $1::int8, indexed_block_hash = NULL WHERE chain_id = $2", [String(DEPLOYMENT_BLOCK - 1n), SCENARIO_CHAIN_ID]);
    expect(await poller.runCycle()).toEqual({ kind: "halted", reason: "finalized_conflict" });
    expect(await readModelDigest(database.db)).toBe(digest);
  });
});

describe("poller: lagging backends and the run loop (operator gaps 17, 18, 20)", () => {
  it("a header that is not available yet (null, a lagging backend) is retried and the range applies with no halt", async () => {
    const events = scenarioOracle().events;
    const chain = new ScriptedChain(events.at(-1)!.blockNumber + 3n, events);
    let nulls = 0;
    const { primary, secondary } = httpPair(chain, (body, method, params) => {
      if (method !== "eth_getBlockByNumber" || params[0] === "finalized" || nulls > 0) return body;
      nulls += 1;
      return { ...body, result: null };
    });
    const sleeps: number[] = [];
    const poller = makePoller(primary, secondary, [], { sleep: async (ms) => void sleeps.push(ms) });
    await poller.start();
    expect(await drain(poller)).toMatchObject({ kind: "idle" });
    expect(nulls).toBe(1);
    expect(sleeps).toEqual([500]);
    expect((await model().status()).halted).toBe(false);
    await expectSameAsReference(events);
  });

  it("retries back off exponentially and are capped at 5 s (requestAttempts 6, retryBaseMs 1000)", async () => {
    const events = spreadClaims(2, 5);
    const sleeps: number[] = [];
    const { poller, primary } = setup(events, { overrides: { requestAttempts: 6, retryBaseMs: 1_000, sleep: async (ms) => void sleeps.push(ms) } });
    let failures = 5;
    primary.failGetLogs = () => (failures-- > 0 ? "transient" : null);
    await poller.start();
    expect(await drain(poller)).toMatchObject({ kind: "idle" });
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
    await expectSameAsReference(events);
  });

  it("readiness: ready after a successful cycle, not ready once the last success is older than maxAgeMs (steppable clock)", async () => {
    const events = scenarioOracle().events;
    let now = 1_900_000_000_000;
    const { poller } = setup(events, { overrides: { now: () => now } });
    await poller.start();
    expect(await poller.isReady(60_000)).toBe(false);
    await drain(poller);
    expect(await poller.isReady(60_000)).toBe(true);
    now += 60_000;
    expect(await poller.isReady(60_000)).toBe(true);
    now += 1;
    expect(await poller.isReady(60_000)).toBe(false);
    await poller.runCycle();
    expect(await poller.isReady(60_000)).toBe(true);
  });

  it("run(): no sleep between advances while behind; the poll interval when idle or halted", async () => {
    const events = spreadClaims(4, 40);
    const sleeps: number[] = [];
    const controller = new AbortController();
    const { poller, logs, primary, secondary, chain } = setup(events, {
      overrides: {
        chunkSize: 50,
        pollIntervalMs: 7_000,
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length >= 2) controller.abort();
        },
      },
    });
    await poller.start();
    await poller.run(controller.signal);
    expect(rangesApplied(logs).length).toBeGreaterThan(2);
    expect((await model().status()).indexedBlock).toBe(chain.finalized);
    // All ranges ran back to back; the two sleeps are the idle polls after catching up.
    expect(sleeps).toEqual([7_000, 7_000]);
    // Halted: the poll interval too.
    const next = chain.finalized + 3n;
    chain.finalized = next;
    secondary.chain.finalized = next;
    secondary.chain.headers.set(next, { ...chain.header(next), hash: `0x${"e1".repeat(32)}` });
    sleeps.length = 0;
    const again = new AbortController();
    const halted = makePoller(primary, secondary, [], {
      pollIntervalMs: 7_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length >= 2) again.abort();
      },
    });
    await halted.start();
    await halted.run(again.signal);
    expect((await model().status()).halted).toBe(true);
    expect(sleeps).toEqual([7_000, 7_000]);
  });
});

describe("poller over the HTTP provider with the DEFAULT caps: a flooded block (operator gap 5)", () => {
  it("one block carrying 5,000 tracked zero-value bounty logs is applied with no halt and no failing cycle", async () => {
    const b = new EventBuilder();
    const created = claimCreated(b, "flood-5000");
    b.nextBlock();
    const events: ChainEvent[] = [created];
    for (let index = 0; index < 5_000; index += 1) {
      events.push({ ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityBountyFunded", questionId: created.questionId, bountyAdded: 0n, bounty: 0n, user: created.creator });
    }
    const chain = new ScriptedChain(events.at(-1)!.blockNumber + 2n, events);
    const redact = createRedactor();
    const primary = createHttpProvider({ label: "primary", url: "https://primary.invalid/rpc", redact, fetchFn: jsonRpcFetch(chain) });
    const secondary = createHttpProvider({ label: "secondary", url: "https://secondary.invalid/rpc", redact, fetchFn: jsonRpcFetch(chain.clone()) });
    const logs: LogEntry[] = [];
    const poller = makePoller(primary, secondary, logs);
    await poller.start();
    // drain() rejects on any failing cycle; no cap is overridden.
    expect(await drain(poller)).toMatchObject({ kind: "idle" });
    expect((await model().status()).halted).toBe(false);
    expect(rangesApplied(logs).map((range) => range.logs)).toEqual([5_001]);
    expect((await model().getOracleQuestion(created.questionId))?.lastEventBlock).toBe(events.at(-1)!.blockNumber);
    await expectSameAsReference(events);
  });
});
