// RPC access for the poller. The poller depends only on RpcProvider, so tests inject scripted providers (no network).
// The HTTP provider speaks raw JSON-RPC over fetch, reads every response as a stream under a byte cap, validates it with
// zod (SEC-IDX-05) and builds every error from safe fields only (method, HTTP status, JSON-RPC code and a redacted
// provider message), because RPC URLs often carry an API key (operator-settled, SEC-OPS-03).
//
// Failures are classified for the poller (PRD-05 section 2.3):
//   - "size": too many results, range too large, response-size errors, timeouts, or a response above the parser caps
//     (16 MB, 20,000 logs). eth_getLogs ranges are split on these, down to one block; never a halt.
//   - "transient": anything else (429, 5xx, network, non-JSON bodies). The same request is retried with capped backoff.
//   - InvalidRpcDataError: a well-formed JSON-RPC result of the wrong shape. A single-response anomaly: the poller
//     re-fetches from both providers (up to 3 times) and halts only if it persists.

import { z } from "zod";
import type { Address, Hex32 } from "@pine/shared/types";
import type { RawLog } from "./decode.js";
import { safeErrorMessage, type Redactor } from "./redact.js";

export interface BlockHeader {
  number: bigint;
  hash: Hex32;
  timestamp: number;
}

/** One eth_getLogs request: exact addresses, positional topic OR-lists (null = any), inclusive block range. */
export interface LogQuery {
  addresses: readonly Address[];
  topics: readonly (readonly Hex32[] | null)[];
  fromBlock: bigint;
  toBlock: bigint;
}

export interface RpcProvider {
  readonly label: string;
  chainId(): Promise<number>;
  /** The `finalized` block tag. */
  finalizedBlock(): Promise<BlockHeader>;
  latestBlockNumber(): Promise<bigint>;
  blockHeader(number: bigint): Promise<BlockHeader>;
  getLogs(query: LogQuery): Promise<RawLog[]>;
}

/** Parser caps per response; one block's worst case (~5k logs per 17M-gas block) stays well below both. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_LOGS_PER_RESPONSE = 20_000;

export type RpcErrorKind = "size" | "transient";

/** A transport or provider failure (retried or split, never a halt). Message is redacted. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly kind: RpcErrorKind = "transient",
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** A response that is valid JSON-RPC but not data of the expected shape: an integrity failure (halt). */
export class InvalidRpcDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRpcDataError";
  }
}

// Provider wordings for result-size failures (geth/erigon/nethermind, Infura, Alchemy, QuickNode, Ankr, BlockPI, ...).
const SIZE_MESSAGE =
  /too many|more than \d+ (?:results|logs)|limit exceeded|exceeds? (?:the )?(?:max|limit|range)|range (?:is )?too (?:large|wide|big)|block range|response (?:size|is too|too)|too large|query timeout|timed? ?out/i;

/** Classifies a JSON-RPC error object (code, message) or an HTTP status into the poller's failure kinds. */
export function classifyFailure(input: { code?: number; message?: string; status?: number }): RpcErrorKind {
  if (input.status === 413 || input.status === 504) return "size";
  if (input.code === -32005) return "size";
  if (input.message !== undefined && SIZE_MESSAGE.test(input.message)) return "size";
  return "transient";
}

// ------------------------------------------------------------------------------------------------------------- schemas

const quantity = z
  .string()
  .regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/)
  .transform((value) => BigInt(value));
const hex32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex32);
const addressHex = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase() as Address);
const dataHex = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
  .transform((value) => value.toLowerCase() as `0x${string}`);

const rawLogSchema = z.object({
  address: addressHex,
  topics: z.array(hex32).min(1).max(4),
  data: dataHex,
  blockNumber: quantity,
  blockHash: hex32,
  transactionHash: hex32,
  logIndex: quantity.refine((value) => value <= 0xffffffffn),
  removed: z.boolean().optional(),
});

const headerSchema = z.object({
  number: quantity,
  hash: hex32,
  timestamp: quantity.refine((value) => value <= BigInt(Number.MAX_SAFE_INTEGER)),
});

/**
 * Validates an eth_getLogs result. More than `maxLogs` entries is a size failure (split the range, never a halt);
 * a removed or pending log is invalid here because only finalized data is requested.
 */
export function parseRawLogs(value: unknown, maxLogs: number = MAX_LOGS_PER_RESPONSE): RawLog[] {
  if (!Array.isArray(value)) throw new InvalidRpcDataError("eth_getLogs returned data of an unexpected shape");
  if (value.length > maxLogs) throw new RpcError(`eth_getLogs returned more than ${maxLogs} logs`, "size");
  const result = z.array(rawLogSchema).safeParse(value);
  if (!result.success) throw new InvalidRpcDataError("eth_getLogs returned data of an unexpected shape");
  return result.data.map((log) => {
    if (log.removed === true) throw new InvalidRpcDataError("eth_getLogs returned a removed log for a finalized range");
    return {
      address: log.address,
      topics: log.topics,
      data: log.data,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      logIndex: Number(log.logIndex),
    };
  });
}

export function parseHeader(value: unknown): BlockHeader {
  const result = headerSchema.safeParse(value);
  if (!result.success) throw new InvalidRpcDataError("eth_getBlockByNumber returned data of an unexpected shape");
  return { number: result.data.number, hash: result.data.hash, timestamp: Number(result.data.timestamp) };
}

// Only the fields used are validated; extra members (provider extensions) are accepted and ignored (PRD-05 section 3b).
const envelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

// ------------------------------------------------------------------------------------------------------------- http

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export interface HttpProviderOptions {
  label: string;
  url: string;
  redact: Redactor;
  /** Per-request timeout (a timeout is a size-type failure for eth_getLogs). Default 30 s. */
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxLogsPerResponse?: number;
  /** Test seam: a fetch implementation (tests never touch the network). */
  fetchFn?: FetchLike;
}

const toQuantity = (value: bigint): `0x${string}` => `0x${value.toString(16)}`;

class SizeLimitError extends Error {}

/** Reads a body as a stream and stops (cancelling the stream) once it exceeds `cap` bytes. */
async function readCapped(response: Response, cap: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel().catch(() => undefined);
    throw new SizeLimitError();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new SizeLimitError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createHttpProvider(options: HttpProviderOptions): RpcProvider {
  const fetchFn: FetchLike = options.fetchFn ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const maxLogs = options.maxLogsPerResponse ?? MAX_LOGS_PER_RESPONSE;
  const label = options.label;
  let nextId = 1;

  const request = async (method: string, params: unknown[]): Promise<unknown> => {
    const id = nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let text: string;
    try {
      let response: Response;
      try {
        response = await fetchFn(options.url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new RpcError(`${label} ${method} timed out after ${timeoutMs} ms`, "size");
        // Never keep the fetch error (its cause can carry the URL); its redacted name and message are enough.
        throw new RpcError(`${label} ${method} failed: ${safeErrorMessage(error, options.redact)}`);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new RpcError(`${label} ${method} failed: HTTP ${response.status}`, classifyFailure({ status: response.status }));
      }
      try {
        text = await readCapped(response, maxBytes);
      } catch (error) {
        if (error instanceof SizeLimitError) throw new RpcError(`${label} ${method} response exceeds ${maxBytes} bytes`, "size");
        if (controller.signal.aborted) throw new RpcError(`${label} ${method} timed out after ${timeoutMs} ms`, "size");
        throw new RpcError(`${label} ${method} failed while reading the response: ${safeErrorMessage(error, options.redact)}`);
      }
    } finally {
      clearTimeout(timer);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // A truncated or HTML body from a load balancer: transient, never a halt.
      throw new RpcError(`${label} ${method} returned a body that is not JSON`);
    }
    const envelope = envelopeSchema.safeParse(body);
    if (!envelope.success || envelope.data.id !== id) throw new RpcError(`${label} ${method} returned a malformed JSON-RPC envelope`);
    if (envelope.data.error !== undefined) {
      const { code, message } = envelope.data.error;
      const safe = options.redact(message).slice(0, 200);
      throw new RpcError(`${label} ${method} failed: JSON-RPC ${code}: ${safe}`, classifyFailure({ code, message }));
    }
    // An envelope with neither an error nor a result member is malformed (transient); `result: null` is a value.
    if (typeof body !== "object" || body === null || !("result" in body)) throw new RpcError(`${label} ${method} returned a malformed JSON-RPC envelope`);
    return (body as { result: unknown }).result;
  };

  const header = async (tag: string): Promise<BlockHeader> => {
    const value = await request("eth_getBlockByNumber", [tag, false]);
    if (value === null) throw new RpcError(`${label} eth_getBlockByNumber: block ${tag} not available`);
    return parseHeader(value);
  };

  return {
    label,
    async chainId() {
      const parsed = quantity.safeParse(await request("eth_chainId", []));
      if (!parsed.success) throw new InvalidRpcDataError("eth_chainId returned data of an unexpected shape");
      return Number(parsed.data);
    },
    finalizedBlock: () => header("finalized"),
    async latestBlockNumber() {
      const parsed = quantity.safeParse(await request("eth_blockNumber", []));
      if (!parsed.success) throw new InvalidRpcDataError("eth_blockNumber returned data of an unexpected shape");
      return parsed.data;
    },
    async blockHeader(number) {
      const value = await header(toQuantity(number));
      if (value.number !== number) throw new InvalidRpcDataError(`eth_getBlockByNumber returned block ${value.number} for ${number}`);
      return value;
    },
    async getLogs(query) {
      const value = await request("eth_getLogs", [
        {
          address: [...query.addresses],
          topics: query.topics.map((list) => (list === null ? null : [...list])),
          fromBlock: toQuantity(query.fromBlock),
          toBlock: toQuantity(query.toBlock),
        },
      ]);
      try {
        return parseRawLogs(value, maxLogs);
      } catch (error) {
        if (error instanceof RpcError) throw new RpcError(`${label} ${error.message}`, error.kind);
        throw error;
      }
    },
  };
}
