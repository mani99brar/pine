import { describe, expect, it } from "vitest";
import { claimCreated, EventBuilder } from "@pine/shared/testing/read-model-scenarios";
import { createRedactor } from "../src/redact.js";
import { classifyFailure, createHttpProvider, InvalidRpcDataError, RpcError, type FetchLike, type RpcErrorKind } from "../src/rpc.js";
import { jsonRpcFetch, ScriptedChain } from "./scripted-rpc.js";

// The HTTP JSON-RPC provider: failure classification (size-type failures split, others retry, wrong shapes halt), the
// response byte and log caps, timeouts, and the JSON-RPC envelope checks.

const redact = createRedactor();
const QUERY = { addresses: [], topics: [], fromBlock: 1n, toBlock: 2n } as const;

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: unknown) => error,
  );
}

async function kindOf(fetchFn: FetchLike, options: { maxResponseBytes?: number; maxLogsPerResponse?: number; timeoutMs?: number } = {}): Promise<RpcErrorKind | "invalid"> {
  const provider = createHttpProvider({ label: "p", url: "https://rpc.invalid/", redact, fetchFn, ...options });
  const error = await failureOf(provider.getLogs(QUERY));
  if (error instanceof InvalidRpcDataError) return "invalid";
  expect(error).toBeInstanceOf(RpcError);
  return (error as RpcError).kind;
}

const reply =
  (body: (id: number) => unknown, init: ResponseInit = { status: 200 }): FetchLike =>
  async (_input, request) => {
    const { id } = JSON.parse(request.body) as { id: number };
    const value = body(id);
    return new Response(typeof value === "string" ? value : JSON.stringify(value), init);
  };

describe("failure classification", () => {
  it.each([
    [{ code: -32005, message: "limit exceeded" }, "size"],
    [{ code: -32000, message: "query returned more than 10000 results" }, "size"],
    [{ code: -32602, message: "block range is too large" }, "size"],
    [{ code: -32000, message: "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range" }, "size"],
    [{ code: -32000, message: "request timed out" }, "size"],
    [{ status: 413 }, "size"],
    [{ status: 504 }, "size"],
    [{ status: 429 }, "transient"],
    [{ status: 502 }, "transient"],
    [{ code: -32000, message: "header not found" }, "transient"],
    [{ code: 429, message: "rate limited" }, "transient"],
  ] as const)("%o is %s", (input, expected) => {
    expect(classifyFailure(input)).toBe(expected);
  });
});

describe("HTTP JSON-RPC provider", () => {
  it("a response above the byte cap is a size failure (streamed, without a content-length header)", async () => {
    const big: FetchLike = async (_input, request) => {
      const { id } = JSON.parse(request.body) as { id: number };
      const payload = JSON.stringify({ jsonrpc: "2.0", id, result: [] }).padEnd(5_000, " ");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < payload.length; offset += 500) controller.enqueue(new TextEncoder().encode(payload.slice(offset, offset + 500)));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };
    expect(await kindOf(big, { maxResponseBytes: 2_000 })).toBe("size");
    // The same body under the cap parses.
    const provider = createHttpProvider({ label: "p", url: "https://rpc.invalid/", redact, fetchFn: big, maxResponseBytes: 10_000 });
    expect(await provider.getLogs(QUERY)).toEqual([]);
  });

  it("a declared content-length above the cap is refused before reading", async () => {
    const declared: FetchLike = async () => new Response("[]", { status: 200, headers: { "content-length": "99999999" } });
    expect(await kindOf(declared, { maxResponseBytes: 1_000 })).toBe("size");
  });

  it("more logs than the per-response cap is a size failure", async () => {
    const b = new EventBuilder();
    const events = Array.from({ length: 4 }, (_, index) => claimCreated(b, `cap-${index}`));
    const chain = new ScriptedChain(2_000n, events);
    const provider = createHttpProvider({ label: "p", url: "https://rpc.invalid/", redact, fetchFn: jsonRpcFetch(chain), maxLogsPerResponse: 3 });
    const error = await failureOf(provider.getLogs({ addresses: [events[0]!.address], topics: [], fromBlock: 0n, toBlock: 5_000n }));
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).kind).toBe("size");
  });

  it("a timeout is a size failure for eth_getLogs", async () => {
    const hanging: FetchLike = (_input, request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      });
    expect(await kindOf(hanging, { timeoutMs: 20 })).toBe("size");
  });

  it("HTTP 429/5xx, network failures, non-JSON bodies and malformed envelopes are transient", async () => {
    expect(await kindOf(async () => new Response("slow down", { status: 429 }))).toBe("transient");
    expect(await kindOf(async () => new Response("bad gateway", { status: 502 }))).toBe("transient");
    expect(await kindOf(async () => new Response("payload too large", { status: 413 }))).toBe("size");
    expect(
      await kindOf(async () => {
        throw new TypeError("fetch failed");
      }),
    ).toBe("transient");
    expect(await kindOf(reply(() => "<html>502</html>"))).toBe("transient");
    expect(await kindOf(reply((id) => ({ jsonrpc: "2.0", id: id + 1, result: [] })))).toBe("transient");
    expect(await kindOf(reply((id) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "upstream unavailable" } })))).toBe("transient");
    expect(await kindOf(reply((id) => ({ jsonrpc: "2.0", id, error: { code: -32005, message: "query returned more than 10000 results" } })))).toBe("size");
  });

  it("a well-formed JSON-RPC result of the wrong shape is invalid data (halt)", async () => {
    expect(await kindOf(reply((id) => ({ jsonrpc: "2.0", id, result: [{ address: "0x1234" }] })))).toBe("invalid");
    expect(await kindOf(reply((id) => ({ jsonrpc: "2.0", id, result: { not: "an array" } })))).toBe("invalid");
  });

  it("sends exact addresses, positional topic OR-lists and hex block numbers", async () => {
    const bodies: unknown[] = [];
    const capture: FetchLike = async (input, request) => {
      bodies.push({ input, body: JSON.parse(request.body) as unknown, method: request.method });
      const { id } = JSON.parse(request.body) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: [] }), { status: 200 });
    };
    const provider = createHttpProvider({ label: "p", url: "https://rpc.invalid/x", redact, fetchFn: capture });
    const topic = `0x${"11".repeat(32)}` as const;
    await provider.getLogs({ addresses: ["0x00000000000000000000000000000000000000aa"], topics: [[topic], null, [topic]], fromBlock: 16n, toBlock: 255n });
    expect(bodies).toEqual([
      {
        input: "https://rpc.invalid/x",
        method: "POST",
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getLogs",
          params: [{ address: ["0x00000000000000000000000000000000000000aa"], topics: [[topic], null, [topic]], fromBlock: "0x10", toBlock: "0xff" }],
        },
      },
    ]);
  });
});

describe("header and chain-id responses (operator gap 17)", () => {
  const provider = (result: (method: string, params: unknown[]) => unknown) =>
    createHttpProvider({
      label: "p",
      url: "https://rpc.invalid/",
      redact,
      fetchFn: async (_input, request) => {
        const { id, method, params } = JSON.parse(request.body) as { id: number; method: string; params: unknown[] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: result(method, params) }), { status: 200 });
      },
    });
  const header = (number: string, timestamp = "0x5") => ({ number, hash: `0x${"0a".repeat(32)}`, timestamp });

  it("a null header (a lagging backend that has not seen the block) is a transient RpcError, never invalid data", async () => {
    const lagging = provider(() => null);
    for (const call of [() => lagging.finalizedBlock(), () => lagging.blockHeader(16n)]) {
      const error = await failureOf(call());
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).kind).toBe("transient");
    }
  });

  it("a header for another block number, or a timestamp above 2^53-1, is invalid data", async () => {
    expect(await failureOf(provider(() => header("0x11")).blockHeader(16n))).toBeInstanceOf(InvalidRpcDataError);
    expect(await provider(() => header("0x10")).blockHeader(16n)).toEqual({ number: 16n, hash: `0x${"0a".repeat(32)}`, timestamp: 5 });
    expect(await failureOf(provider(() => header("0x10", "0x20000000000000")).blockHeader(16n))).toBeInstanceOf(InvalidRpcDataError);
    expect(await provider(() => header("0x10", "0x1fffffffffffff")).blockHeader(16n)).toMatchObject({ timestamp: Number.MAX_SAFE_INTEGER });
  });

  it.each([["0x01"], [100], ["100"], [null]])("eth_chainId returning %o is invalid data", async (value) => {
    expect(await failureOf(provider(() => value).chainId())).toBeInstanceOf(InvalidRpcDataError);
  });

  it("eth_chainId 0x64 is chain 100", async () => {
    expect(await provider(() => "0x64").chainId()).toBe(100);
  });

  it("an envelope with neither result nor error is malformed (transient); extra members are accepted", async () => {
    const missing: FetchLike = async (_input, request) => {
      const { id } = JSON.parse(request.body) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id }), { status: 200 });
    };
    expect(await kindOf(missing)).toBe("transient");
    const extra: FetchLike = async (_input, request) => {
      const { id } = JSON.parse(request.body) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: [], served_by: "node-3", meta: { cached: false } }), { status: 200 });
    };
    expect(await createHttpProvider({ label: "p", url: "https://rpc.invalid/", redact, fetchFn: extra }).getLogs(QUERY)).toEqual([]);
    const extraError: FetchLike = async (_input, request) => {
      const { id } = JSON.parse(request.body) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message: "query returned more than 10000 results", data: { from: 1 } }, trace: "x" }), { status: 200 });
    };
    expect(await kindOf(extraError)).toBe("size");
  });
});
