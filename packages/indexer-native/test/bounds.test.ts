import { describe, expect, it } from "vitest";
import { SCENARIO_ADDRESSES, SCENARIO_CHAIN_ID, SCENARIO_QUESTION_TIMEOUT } from "@pine/shared/testing/read-model-scenarios";
import type { SqlExecutor } from "../src/db.js";
import { DEFAULT_CHUNK, IDS_PER_REQUEST, MAX_RANGE_BYTES, MAX_RANGE_LOGS, MAX_REOPEN_ROUNDS, Poller } from "../src/poller.js";
import { createRedactor } from "../src/redact.js";
import { createHttpProvider, MAX_LOGS_PER_RESPONSE, MAX_RESPONSE_BYTES, RpcError, type FetchLike } from "../src/rpc.js";

// The production bounds of decisions.md and PRD-05 sections 2.3 and 3b, pinned with literal values: changing a constant, or
// a code path no longer reading it when no override is given, fails here. Tests elsewhere override the bounds to keep
// fixtures small; these tests use none.

const MIB = 1024 * 1024;

describe("pinned production bounds", () => {
  it("the exported constants keep their decided values", () => {
    expect(MAX_RANGE_LOGS).toBe(50_000);
    expect(MAX_RANGE_BYTES).toBe(32 * MIB);
    expect(MAX_RESPONSE_BYTES).toBe(16 * MIB);
    expect(MAX_LOGS_PER_RESPONSE).toBe(20_000);
    // One 17M-gas block holds about 5,000 zero-value bounty logs: a one-block request must always fit one response.
    expect(MAX_LOGS_PER_RESPONSE).toBeGreaterThanOrEqual(5_000);
    expect(MAX_RANGE_LOGS).toBeGreaterThanOrEqual(MAX_LOGS_PER_RESPONSE);
    expect(MAX_REOPEN_ROUNDS).toBe(8);
    expect(DEFAULT_CHUNK).toBe(500);
    expect(IDS_PER_REQUEST).toBe(100);
  });

  it("a poller built without overrides runs with exactly these bounds (10 s re-check delay, 3 re-checks)", () => {
    const unused = (): never => {
      throw new Error("the constructor must not touch the database");
    };
    const db: SqlExecutor = { exec: unused, query: unused, transaction: unused };
    const poller = new Poller({
      db,
      primary: { label: "p" } as never,
      secondary: { label: "s" } as never,
      chainId: SCENARIO_CHAIN_ID,
      questionTimeout: SCENARIO_QUESTION_TIMEOUT,
      addresses: SCENARIO_ADDRESSES,
      deploymentBlock: 1n,
      redact: createRedactor(),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    expect(poller.limits).toEqual({
      chunkSize: 500,
      maxRangeLogs: 50_000,
      maxRangeBytes: 33_554_432,
      maxReopenRounds: 8,
      idsPerRequest: 100,
      requestAttempts: 3,
      recheckAttempts: 3,
      recheckDelayMs: 10_000,
    });
  });
});

describe("pinned HTTP provider caps (no overrides)", () => {
  const redact = createRedactor();
  const QUERY = { addresses: [], topics: [], fromBlock: 1n, toBlock: 2n } as const;
  const log = (index: number) => ({
    address: "0xe78996a233895be74a66f451f1019ca9734205cc",
    topics: [`0x${"ab".repeat(32)}`],
    data: "0x",
    blockNumber: "0x10",
    blockHash: `0x${"cd".repeat(32)}`,
    transactionHash: `0x${"ef".repeat(32)}`,
    logIndex: `0x${index.toString(16)}`,
  });
  const logsReply =
    (count: number): FetchLike =>
    async (_input, request) => {
      const { id } = JSON.parse(request.body) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: Array.from({ length: count }, (_, index) => log(index)) }), { status: 200 });
    };
  /** A response of exactly `size` bytes (a valid envelope padded with JSON whitespace), streamed without content-length. */
  const sizedReply =
    (size: number): FetchLike =>
    async (_input, request) => {
      const { id } = JSON.parse(request.body) as { id: number };
      const head = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: [] }));
      const body = Buffer.alloc(size, 0x20);
      head.copy(body);
      const chunk = 1 * MIB;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < body.length; offset += chunk) controller.enqueue(new Uint8Array(body.subarray(offset, offset + chunk)));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };

  async function sizeFailure(fetchFn: FetchLike): Promise<boolean> {
    const provider = createHttpProvider({ label: "p", url: "https://rpc.invalid/", redact, fetchFn });
    return provider.getLogs(QUERY).then(
      () => false,
      (error: unknown) => error instanceof RpcError && error.kind === "size",
    );
  }

  it("20,000 logs per response parse; 20,001 are a size failure", async () => {
    const provider = createHttpProvider({ label: "p", url: "https://rpc.invalid/", redact, fetchFn: logsReply(20_000) });
    expect(await provider.getLogs(QUERY)).toHaveLength(20_000);
    expect(await sizeFailure(logsReply(20_001))).toBe(true);
  });

  it("a 16 MiB response parses; one byte more is a size failure", async () => {
    const provider = createHttpProvider({ label: "p", url: "https://rpc.invalid/", redact, fetchFn: sizedReply(16 * MIB) });
    expect(await provider.getLogs(QUERY)).toEqual([]);
    expect(await sizeFailure(sizedReply(16 * MIB + 1))).toBe(true);
  });
});
