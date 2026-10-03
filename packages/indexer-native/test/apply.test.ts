import "./lock.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChainEvent } from "@pine/shared/chain-events";
import { InvalidCursorError } from "@pine/shared/read-model";
import { MemoryReadModel } from "@pine/shared/testing/memory-read-model";
import { SCENARIO_CHAIN_ID, SCENARIO_QUESTION_TIMEOUT, scenarioClaimsAndEvidence, scenarioOracle } from "@pine/shared/testing/read-model-scenarios";
import { applyEvents, OutOfOrderEventError } from "../src/apply.js";
import { createNativeReadModel } from "../src/read-model.js";
import { advanceCursor } from "../src/store.js";
import { countRows, readModelDigest, resetDatabase } from "./digest.js";
import { openDatabase, type TestDatabase } from "./harness.js";

const OPTIONS = { chainId: SCENARIO_CHAIN_ID, questionTimeout: SCENARIO_QUESTION_TIMEOUT };

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

const apply = (events: readonly ChainEvent[]) => database.db.transaction((tx) => applyEvents(tx, events, OPTIONS));

const cursorPosition = async (): Promise<{ last_event_block: string | null; last_event_log_index: number | null }> =>
  (await database.db.query<{ last_event_block: string | null; last_event_log_index: number | null }>(
    "SELECT last_event_block::text AS last_event_block, last_event_log_index FROM pine_index.cursor WHERE chain_id = $1",
    [OPTIONS.chainId],
  ))[0]!;

describe("applyEvents", () => {
  it("SEC-IDX-04 re-applying a range is a no-op (identical digest), including mutations of existing rows", async () => {
    const { events } = scenarioOracle();
    expect(await apply(events)).toEqual({ applied: events.length, skipped: 0 });
    const first = await readModelDigest(database.db);
    expect(await apply(events)).toEqual({ applied: 0, skipped: events.length });
    expect(await readModelDigest(database.db)).toBe(first);
    // A partial replay (a suffix of the range) is also a no-op.
    expect(await apply(events.slice(10))).toEqual({ applied: 0, skipped: events.length - 10 });
    expect(await readModelDigest(database.db)).toBe(first);
  });

  it("a replayed range followed by new events applies only the new ones", async () => {
    const { events } = scenarioOracle();
    await apply(events.slice(0, 12));
    expect(await apply(events)).toEqual({ applied: events.length - 12, skipped: 12 });
    const replayed = await readModelDigest(database.db);
    await resetDatabase(database.db);
    await apply(events);
    expect(await readModelDigest(database.db)).toBe(replayed);
  });

  it("the cursor-position guard: no per-event rows, the stored (block, logIndex) is the last applied event", async () => {
    const { events } = scenarioOracle();
    await apply(events);
    const last = events.at(-1)!;
    expect(await cursorPosition()).toEqual({ last_event_block: last.blockNumber.toString(), last_event_log_index: last.logIndex });
    const tables = await database.db.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'pine_index'");
    expect(tables.map((row) => row.name)).not.toContain("applied_events");
  });

  it("skips events at or before the indexed block even without a stored event position (whole blocks are applied)", async () => {
    const { events } = scenarioClaimsAndEvidence();
    await database.db.transaction((tx) => advanceCursor(tx, { chainId: OPTIONS.chainId, block: events[0]!.blockNumber, blockHash: events[0]!.blockHash, blockTimestamp: 1 }));
    const result = await apply(events);
    const atFirstBlock = events.filter((event) => event.blockNumber <= events[0]!.blockNumber).length;
    expect(result).toEqual({ applied: events.length - atFirstBlock, skipped: atFirstBlock });
    const first = events[0]!;
    if (first.kind !== "ClaimCreated") throw new Error("the scenario starts with a claim");
    expect(await createNativeReadModel(database.db, { chainId: OPTIONS.chainId }).getClaim(first.market)).toBeNull();
  });

  it("skips an event at or before the stored position; within one call an out-of-order event throws (reference ordering)", async () => {
    const { events } = scenarioClaimsAndEvidence();
    await apply(events.slice(0, 3));
    const digest = await readModelDigest(database.db);
    const earlier = { ...events[1]!, blockHash: `0x${"ab".repeat(32)}`, logIndex: 0 } as ChainEvent;
    expect(await apply([earlier])).toEqual({ applied: 0, skipped: 1 });
    expect(await readModelDigest(database.db)).toBe(digest);
    await expect(apply([events[4]!, events[3]!])).rejects.toThrow(OutOfOrderEventError);
    // The failed transaction left nothing behind: the stored position is still the third event.
    expect(await readModelDigest(database.db)).toBe(digest);
    expect(await cursorPosition()).toEqual({ last_event_block: events[2]!.blockNumber.toString(), last_event_log_index: events[2]!.logIndex });
  });

  it("ignores events of other chains, like the reference", async () => {
    const { events, claims } = scenarioClaimsAndEvidence();
    await database.db.transaction((tx) => applyEvents(tx, events, { ...OPTIONS, chainId: 1 }));
    expect(await createNativeReadModel(database.db, { chainId: 1 }).getClaim(claims[0]!.market)).toBeNull();
    expect(await countRows(database.db, "claims")).toBe(0);
  });

  it("stores untrusted strings exactly (NUL, bidi controls, quotes) and matches the reference", async () => {
    const { events } = scenarioOracle();
    const odd = events.map((event) =>
      event.kind === "KlerosHome" && event.stage === "RequestRejected" ? { ...event, reason: "\u0000'); DROP TABLE x; --\u202e\"" } : event,
    );
    await apply(odd);
    const reference = new MemoryReadModel(OPTIONS);
    reference.apply(odd);
    const { reopenedQuestionId } = scenarioOracle();
    const model = createNativeReadModel(database.db, { chainId: OPTIONS.chainId });
    expect(await model.getArbitration(reopenedQuestionId)).toEqual(await reference.getArbitration(reopenedQuestionId));
    expect((await model.getArbitration(reopenedQuestionId))?.rejectionReason).toBe("\u0000'); DROP TABLE x; --\u202e\"");
  });

  it("applies events in many small transactions with the same result as one (range boundaries do not matter)", async () => {
    const { events } = scenarioOracle();
    for (const event of events) await apply([event]);
    const piecewise = await readModelDigest(database.db);
    await resetDatabase(database.db);
    await apply(events);
    expect(await readModelDigest(database.db)).toBe(piecewise);
  });

  it("advanceCursor never moves backwards", async () => {
    const { events } = scenarioOracle();
    const last = events.at(-1)!;
    await database.db.transaction(async (tx) => {
      await applyEvents(tx, events, OPTIONS);
      await advanceCursor(tx, { chainId: OPTIONS.chainId, block: last.blockNumber, blockHash: last.blockHash, blockTimestamp: last.blockTimestamp });
    });
    await expect(
      database.db.transaction((tx) => advanceCursor(tx, { chainId: OPTIONS.chainId, block: last.blockNumber - 1n, blockHash: last.blockHash, blockTimestamp: 1 })),
    ).rejects.toThrow(/backwards/);
    const status = await createNativeReadModel(database.db, { chainId: OPTIONS.chainId }).status();
    expect(status).toEqual({
      backend: "native",
      chainId: OPTIONS.chainId,
      indexedBlock: last.blockNumber,
      indexedBlockTimestamp: last.blockTimestamp,
      headBlock: null,
      finalizedBlock: null,
      halted: false,
    });
  });
});

describe("read-model cursors (PRD-05 section 3a)", () => {
  const model = () => createNativeReadModel(database.db, { chainId: OPTIONS.chainId });
  const craft = (scope: string, key: unknown): string => Buffer.from(JSON.stringify({ v: 1, impl: "native", scope, key }), "utf8").toString("base64url");

  it("crafted cursors with key parts outside the int8/int4 domains are InvalidCursorError, never a database error", async () => {
    await apply(scenarioClaimsAndEvidence().events);
    const market = "0x" + "11".repeat(20);
    const created = [
      ["9223372036854775808", "0"],
      ["99999999999999999999", "0"],
      ["1", "2147483648"],
      ["1", "9999999999"],
      ["-1", "0"],
      ["01", "0"],
      ["1", market],
    ];
    for (const key of created) {
      await expect(model().listClaims({ order: "created_desc", limit: 2, cursor: craft("claims:created_desc", key) }), JSON.stringify(key)).rejects.toThrow(InvalidCursorError);
      await expect(model().listEvidence({ limit: 2, cursor: craft("evidence", key) }), JSON.stringify(key)).rejects.toThrow(InvalidCursorError);
    }
    for (const key of [["9223372036854775808", market], ["1", "2147483647"], ["1", market.toUpperCase()]]) {
      await expect(model().listClaims({ order: "evidence_deadline_asc", limit: 2, cursor: craft("claims:evidence_deadline_asc", key) })).rejects.toThrow(InvalidCursorError);
    }
    // The extreme in-domain values are accepted and simply match nothing.
    expect((await model().listClaims({ order: "created_desc", limit: 2, cursor: craft("claims:created_desc", ["0", "0"]) })).items).toEqual([]);
    expect((await model().listEvidence({ limit: 2, cursor: craft("evidence", ["9223372036854775807", "2147483647"]) })).items).toEqual([]);
    expect((await model().listClaims({ order: "evidence_deadline_asc", limit: 2, cursor: craft("claims:evidence_deadline_asc", ["9223372036854775807", market]) })).items).toEqual([]);
  });

  it("every list method enforces an integer limit in 1..100 (operator gap 9)", async () => {
    await apply(scenarioClaimsAndEvidence().events);
    for (const limit of [0, 101, 1.5, -1, Number.NaN]) {
      await expect(model().listEvidence({ limit }), String(limit)).rejects.toThrow(RangeError);
      await expect(model().listClaims({ order: "created_desc", limit }), String(limit)).rejects.toThrow(RangeError);
      await expect(model().listClaims({ order: "evidence_deadline_asc", limit }), String(limit)).rejects.toThrow(RangeError);
    }
    expect((await model().listEvidence({ limit: 100 })).items.length).toBeGreaterThan(0);
    expect((await model().listClaims({ order: "created_desc", limit: 1 })).items).toHaveLength(1);
  });

  it("a cursor is accepted only by the query scope and implementation that issued it (operator gap 9)", async () => {
    await apply(scenarioClaimsAndEvidence().events);
    const created = (await model().listClaims({ order: "created_desc", limit: 1 })).nextCursor;
    const deadline = (await model().listClaims({ order: "evidence_deadline_asc", limit: 1 })).nextCursor;
    const evidence = (await model().listEvidence({ limit: 1 })).nextCursor;
    expect(created && deadline && evidence).toBeTruthy();
    // Issued cursors work for their own query.
    expect((await model().listClaims({ order: "created_desc", limit: 1, cursor: created! })).items).toHaveLength(1);
    expect((await model().listEvidence({ limit: 1, cursor: evidence! })).items).toHaveLength(1);
    // An evidence cursor has the same (int8, int4) key shape as a created_desc cursor: the scope alone tells them apart.
    await expect(model().listClaims({ order: "created_desc", limit: 1, cursor: evidence! })).rejects.toThrow(InvalidCursorError);
    await expect(model().listEvidence({ limit: 1, cursor: created! })).rejects.toThrow(InvalidCursorError);
    await expect(model().listClaims({ order: "created_desc", limit: 1, cursor: deadline! })).rejects.toThrow(InvalidCursorError);
    await expect(model().listClaims({ order: "evidence_deadline_asc", limit: 1, cursor: created! })).rejects.toThrow(InvalidCursorError);
    const decoded = JSON.parse(Buffer.from(created!, "base64url").toString("utf8")) as Record<string, unknown>;
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    expect(encode(decoded)).toBe(created);
    const forged = [
      encode({ ...decoded, impl: "memory" }),
      encode({ ...decoded, impl: "envio" }),
      encode({ ...decoded, v: 2 }),
      encode({ ...decoded, extra: 1 }),
      encode({ v: decoded.v, impl: decoded.impl, scope: decoded.scope }),
      encode({ ...decoded, key: [...(decoded.key as string[]), "1"] }),
      `${created!}${"A".repeat(513 - created!.length)}`,
      `${created!.slice(0, -1)}+`,
      `${created!}=`,
      "",
    ];
    expect(forged[6]).toHaveLength(513);
    // The length guard itself: the same JSON padded with whitespace decodes to the same cursor; 512 characters pass, longer fail.
    const padded = (bytes: number): string => {
      const json = JSON.stringify(decoded);
      return Buffer.from(json.padEnd(bytes, " "), "utf8").toString("base64url");
    };
    expect(padded(384)).toHaveLength(512);
    expect((await model().listClaims({ order: "created_desc", limit: 1, cursor: padded(384) })).items).toHaveLength(1);
    expect(padded(385)).toHaveLength(514);
    await expect(model().listClaims({ order: "created_desc", limit: 1, cursor: padded(385) })).rejects.toThrow(InvalidCursorError);
    // The charset guard: "=" padding would decode to the same JSON.
    expect(Buffer.from(`${created!}=`, "base64url").toString("utf8")).toBe(JSON.stringify(decoded));
    for (const cursor of forged) await expect(model().listClaims({ order: "created_desc", limit: 1, cursor }), cursor.slice(0, 40)).rejects.toThrow(InvalidCursorError);
  });
});
