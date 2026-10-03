// Scripted RPC providers for poller tests: an in-memory chain (headers and raw logs) served with eth_getLogs filter
// semantics (exact addresses, positional topic OR-lists, inclusive block range), plus per-provider faults.

import { encodePacked, keccak256 } from "viem";
import type { ChainEvent } from "@pine/shared/chain-events";
import type { Address, Hex32 } from "@pine/shared/types";
import type { RawLog } from "../src/decode.js";
import { RpcError, type BlockHeader, type FetchLike, type LogQuery, type RpcErrorKind, type RpcProvider } from "../src/rpc.js";
import { encodeChainEvent } from "./encode.js";

export const syntheticHash = (block: bigint): Hex32 => keccak256(encodePacked(["string"], [`block:${block}`]));

/** The timestamp of a block without events: a 5 s slot from a fixed origin. */
export const slotTimestamp = (number: bigint): number => 1_700_000_000 + Number(number) * 5;

export class ScriptedChain {
  readonly headers = new Map<bigint, BlockHeader>();
  logs: RawLog[] = [];
  /** Timestamp of blocks without events (replaceable, e.g. by a monotonic schedule for chain-time tests). */
  timestampOf: (number: bigint) => number = slotTimestamp;

  constructor(
    public finalized: bigint,
    events: readonly ChainEvent[] = [],
  ) {
    for (const event of events) this.add(event);
  }

  add(event: ChainEvent): void {
    this.headers.set(event.blockNumber, { number: event.blockNumber, hash: event.blockHash.toLowerCase() as Hex32, timestamp: event.blockTimestamp });
    this.logs.push(encodeChainEvent(event));
  }

  header(number: bigint): BlockHeader {
    // Blocks without events get a deterministic hash and the `timestampOf` timestamp.
    return this.headers.get(number) ?? { number, hash: syntheticHash(number), timestamp: this.timestampOf(number) };
  }

  /** A deep copy, for a second provider whose view is then altered. */
  clone(): ScriptedChain {
    const copy = new ScriptedChain(this.finalized);
    copy.timestampOf = this.timestampOf;
    for (const [number, header] of this.headers) copy.headers.set(number, { ...header });
    copy.logs = this.logs.map((log) => ({ ...log, topics: [...log.topics] }));
    return copy;
  }
}

export interface ProviderCall {
  method: string;
  from?: bigint;
  to?: bigint;
  query?: LogQuery;
}

/** The eth_getLogs filter semantics. */
export function matchesQuery(query: LogQuery, log: RawLog): boolean {
  if (log.blockNumber < query.fromBlock || log.blockNumber > query.toBlock) return false;
  if (!query.addresses.some((address) => address.toLowerCase() === log.address)) return false;
  return query.topics.every((list, index) => list === null || (log.topics[index] !== undefined && list.some((topic) => topic.toLowerCase() === log.topics[index])));
}

export class ScriptedProvider implements RpcProvider {
  chainIdValue = 100;
  readonly calls: ProviderCall[] = [];
  /** Every log this provider returned from eth_getLogs. */
  readonly served: RawLog[] = [];
  /** Throws an RpcError of the returned kind for eth_getLogs when it returns one. */
  failGetLogs: ((query: LogQuery) => RpcErrorKind | null) | null = null;
  /** A provider response cap: more matching logs than this is a size failure (like "query returned more than N results"). */
  maxLogsPerResponse = Number.POSITIVE_INFINITY;
  /** Ignores the address filter (a provider that returns look-alike logs). */
  ignoreAddressFilter = false;
  /** Ignores the topic filters (a provider that returns every log of the requested addresses). */
  ignoreTopicFilter = false;
  /** Overrides the `finalized` tag's header (default: the chain's header at `chain.finalized`). */
  finalizedHeader: BlockHeader | null = null;
  /** Drops logs from the response when it returns true. */
  omitLog: ((log: RawLog) => boolean) | null = null;
  /** Rewrites logs in the response. */
  alterLog: ((log: RawLog) => RawLog) | null = null;

  constructor(
    readonly label: string,
    public chain: ScriptedChain,
  ) {}

  async chainId(): Promise<number> {
    this.calls.push({ method: "eth_chainId" });
    return this.chainIdValue;
  }

  async finalizedBlock(): Promise<BlockHeader> {
    this.calls.push({ method: "finalized" });
    return this.finalizedHeader ?? this.chain.header(this.chain.finalized);
  }

  async latestBlockNumber(): Promise<bigint> {
    this.calls.push({ method: "eth_blockNumber" });
    return this.chain.finalized + 64n;
  }

  async blockHeader(number: bigint): Promise<BlockHeader> {
    this.calls.push({ method: "eth_getBlockByNumber", from: number });
    return this.chain.header(number);
  }

  async getLogs(query: LogQuery): Promise<RawLog[]> {
    this.calls.push({ method: "eth_getLogs", from: query.fromBlock, to: query.toBlock, query });
    const failure = this.failGetLogs?.(query) ?? null;
    if (failure === "size") throw new RpcError(`${this.label} eth_getLogs failed: query returned more than 10000 results`, "size");
    if (failure === "transient") throw new RpcError(`${this.label} eth_getLogs failed: HTTP 503`, "transient");
    let effective: LogQuery = this.ignoreAddressFilter ? { ...query, addresses: [...new Set(this.chain.logs.map((log) => log.address))] as Address[] } : query;
    if (this.ignoreTopicFilter) effective = { ...effective, topics: [] };
    const logs = this.chain.logs
      .filter((log) => matchesQuery(effective, log))
      .filter((log) => !this.omitLog?.(log))
      .map((log) => ({ ...log, topics: [...log.topics] }))
      .map((log) => this.alterLog?.(log) ?? log);
    if (logs.length > this.maxLogsPerResponse) throw new RpcError(`${this.label} eth_getLogs returned more than ${this.maxLogsPerResponse} logs`, "size");
    this.served.push(...logs);
    return logs;
  }

  getLogsCalls(): ProviderCall[] {
    return this.calls.filter((call) => call.method === "eth_getLogs");
  }

  getLogsRanges(): [bigint, bigint][] {
    return this.getLogsCalls().map((call) => [call.from ?? -1n, call.to ?? -1n]);
  }

  headerCalls(): bigint[] {
    return this.calls.filter((call) => call.method === "eth_getBlockByNumber").map((call) => call.from ?? -1n);
  }
}

/** Alters the first `times` eth_getLogs responses of a provider for which `mutate` returns a value (null: unchanged). */
export function inject(provider: ScriptedProvider, times: number, mutate: (logs: RawLog[], query: LogQuery) => RawLog[] | null): void {
  const original = provider.getLogs.bind(provider);
  let left = times;
  provider.getLogs = async (query) => {
    const logs = await original(query);
    if (left <= 0) return logs;
    const altered = mutate(logs, query);
    if (altered === null) return logs;
    left -= 1;
    return altered;
  };
}

/** A JSON-RPC endpoint served from a scripted chain (the HTTP provider's request and response formats). */
export function jsonRpcFetch(chain: ScriptedChain, chainId = 100): FetchLike {
  const provider = new ScriptedProvider("served", chain);
  const hex = (value: bigint | number): string => `0x${value.toString(16)}`;
  return async (_input, init) => {
    const body = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    let result: unknown;
    if (body.method === "eth_chainId") result = hex(chainId);
    else if (body.method === "eth_blockNumber") result = hex(chain.finalized + 64n);
    else if (body.method === "eth_getBlockByNumber") {
      const tag = body.params[0] as string;
      const header = chain.header(tag === "finalized" ? chain.finalized : BigInt(tag));
      result = { number: hex(header.number), hash: header.hash, timestamp: hex(header.timestamp), parentHash: `0x${"00".repeat(32)}` };
    } else if (body.method === "eth_getLogs") {
      const filter = body.params[0] as { address: Address[]; topics: (Hex32[] | null)[]; fromBlock: string; toBlock: string };
      const logs = await provider.getLogs({ addresses: filter.address, topics: filter.topics, fromBlock: BigInt(filter.fromBlock), toBlock: BigInt(filter.toBlock) });
      result = logs.map((log) => ({ ...log, blockNumber: hex(log.blockNumber), logIndex: hex(log.logIndex), transactionIndex: "0x0", removed: false, blockTimestamp: "0x1" }));
    } else throw new Error(`unexpected ${body.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
}
