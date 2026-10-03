// The simulated Gnosis chain of the e2e suite. FakeRpc answers the JSON-RPC calls the real gateways' viem clients send
// (both transports share it: the providers agree), decoding eth_call calldata with the frozen ABIs, so every chain
// read the modules make is exercised for real. ChainSim "mines" decoded ChainEvents into the native index with the real
// `applyEvents` + `advanceCursor` in one transaction as the indexer role, exactly like the poller does.

import { createHash } from "node:crypto";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  toBytes,
  toHex,
  zeroAddress,
  type Abi,
  type AbiEvent,
  type AbiParameter,
  type Hex,
} from "viem";
import { algebraFactoryAbi, algebraPositionManagerAbi } from "@pine/shared/abi/algebra";
import { erc20Abi, realityV3Abi, seerMarketFactoryAbi } from "@pine/shared/abi/external";
import { claimRegistryAbi } from "@pine/shared/abi/generated";
import type { ChainEvent, ClaimCreatedEvent } from "@pine/shared/chain-events";
import type { DeploymentManifest } from "@pine/shared/deployment";
import type { Address, Hex32 } from "@pine/shared/types";
import { advanceCursor, applyEvents, type SqlExecutor } from "@pine/indexer-native";
import { recordHalt, recordObservation } from "@pine/indexer-native/store";
import type { FakeClock } from "../../../src/contracts/testing.js";
import { sdaiAbi } from "../../../src/modules/funding/chain.js";

const lower = <T extends string>(value: T): T => value.toLowerCase() as T;
const hash32 = (seed: string): Hex32 => keccak256(toBytes(seed));
export const addressOf = (seed: string): Address => `0x${hash32(seed).slice(26)}` as Address;

export interface RawLog {
  address: Address;
  topics: Hex32[];
  data: Hex;
}

interface Receipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  from: Address;
  to: Address;
  logs: RawLog[];
}

const revert = () => Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });

/** Scriptable chain state behind eth_call / receipts / blocks. */
export class FakeRpc {
  chainIdHex = "0x64";
  head = 50_000_000n;
  gasPrice = 1_000_000_000n;
  /** xDAI per sDAI share, WAD (1.25 xDAI per share). */
  sdaiRate = 1_250_000_000_000_000_000n;
  readonly markets = new Map<string, Address>();
  readonly receipts = new Map<string, Receipt>();
  readonly reopened = new Map<string, Hex32>();
  readonly historyHashes = new Map<string, Hex32>();
  readonly realityBalances = new Map<string, bigint>();
  readonly balances = new Map<string, bigint>();
  readonly pools = new Map<string, Address>();
  /** When set, every call fails with this message (an RPC outage whose error text embeds the provider URL). */
  failure: string | null = null;
  readonly calls: string[] = [];

  constructor(private readonly manifest: DeploymentManifest) {}

  setBalance(token: Address, owner: Address, amount: bigint): void {
    this.balances.set(`${lower(token)}|${lower(owner)}`, amount);
  }

  private abiFor(to: Address): Abi {
    const m = this.manifest;
    if (to === lower(m.pine.claimRegistry)) return claimRegistryAbi as Abi;
    if (to === lower(m.seer.realitio)) return realityV3Abi;
    if (to === lower(m.amm.factory)) return algebraFactoryAbi;
    if (to === lower(m.amm.positionManager)) return algebraPositionManagerAbi;
    return erc20Abi;
  }

  private callResult(to: Address, data: Hex): Hex {
    const m = this.manifest;
    // sDAI is an ERC-20 and an ERC-4626 vault: try the vault functions first.
    if (to === lower(m.seer.collateralToken)) {
      try {
        const decoded = decodeFunctionData({ abi: sdaiAbi, data });
        const [amount] = decoded.args as readonly [bigint];
        const WAD = 10n ** 18n;
        const result = decoded.functionName === "previewDeposit" ? (amount * WAD) / this.sdaiRate : (amount * this.sdaiRate) / WAD;
        this.calls.push(`eth_call:sDAI.${decoded.functionName}`);
        return encodeFunctionResult({ abi: sdaiAbi, functionName: decoded.functionName, result });
      } catch {
        // Fall through to ERC-20.
      }
    }
    const abi = this.abiFor(to);
    const decoded = decodeFunctionData({ abi, data });
    const args = (decoded.args ?? []) as readonly unknown[];
    this.calls.push(`eth_call:${decoded.functionName}`);
    let result: unknown;
    switch (decoded.functionName) {
      case "marketOf":
        result = this.markets.get(`${lower(String(args[0]))}|${lower(String(args[1]))}`) ?? zeroAddress;
        break;
      case "reopened_questions":
        result = this.reopened.get(lower(String(args[0]))) ?? `0x${"0".repeat(64)}`;
        break;
      case "getHistoryHash":
        result = this.historyHashes.get(lower(String(args[0]))) ?? `0x${"0".repeat(64)}`;
        break;
      case "balanceOf":
        if (to === lower(m.seer.realitio)) result = this.realityBalances.get(lower(String(args[0]))) ?? 0n;
        else if (to === lower(m.amm.positionManager)) result = 0n;
        else result = this.balances.get(`${to}|${lower(String(args[0]))}`) ?? 0n;
        break;
      case "poolByPair": {
        const key = [lower(String(args[0])), lower(String(args[1]))].sort().join("|");
        result = this.pools.get(key) ?? zeroAddress;
        break;
      }
      default:
        throw revert();
    }
    return encodeFunctionResult({ abi, functionName: decoded.functionName, result } as never);
  }

  private block(number: bigint) {
    return {
      number: toHex(number),
      hash: hash32(`block:${number}`),
      parentHash: hash32(`block:${number - 1n}`),
      timestamp: toHex(1_800_000_000n + number),
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      totalDifficulty: "0x0",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      miner: zeroAddress,
      extraData: "0x",
      baseFeePerGas: "0x7",
      logsBloom: `0x${"00".repeat(256)}`,
      transactionsRoot: hash32("tx-root"),
      stateRoot: hash32("state-root"),
      receiptsRoot: hash32("receipts-root"),
      sha3Uncles: hash32("uncles"),
      mixHash: hash32("mix"),
      size: "0x200",
      transactions: [],
      uncles: [],
    };
  }

  private receipt(hash: string, receipt: Receipt) {
    const blockHash = hash32(`block:${receipt.blockNumber}`);
    return {
      blockHash,
      blockNumber: toHex(receipt.blockNumber),
      contractAddress: null,
      cumulativeGasUsed: "0x5208",
      effectiveGasPrice: toHex(this.gasPrice),
      from: receipt.from,
      gasUsed: "0x5208",
      logs: receipt.logs.map((log, index) => ({
        ...log,
        blockHash,
        blockNumber: toHex(receipt.blockNumber),
        transactionHash: hash,
        transactionIndex: "0x0",
        logIndex: toHex(index),
        removed: false,
      })),
      logsBloom: `0x${"00".repeat(256)}`,
      status: receipt.status === "success" ? "0x1" : "0x0",
      to: receipt.to,
      transactionHash: hash,
      transactionIndex: "0x0",
      type: "0x2",
    };
  }

  readonly handle = async (method: string, params: unknown): Promise<unknown> => {
    if (this.failure !== null) throw new Error(this.failure);
    const list = Array.isArray(params) ? (params as unknown[]) : [];
    if (method !== "eth_call") this.calls.push(method);
    switch (method) {
      case "eth_chainId":
        return this.chainIdHex;
      case "eth_blockNumber":
        return toHex(this.head);
      case "eth_gasPrice":
        return toHex(this.gasPrice);
      case "eth_getBlockByNumber": {
        const tag = list[0];
        const number = tag === "finalized" ? this.head - 64n : tag === "latest" || typeof tag !== "string" ? this.head : BigInt(tag);
        return this.block(number);
      }
      case "eth_call": {
        const request = list[0] as { to?: string; data?: Hex };
        if (!request.to || !request.data) throw revert();
        return this.callResult(lower(request.to) as Address, request.data);
      }
      case "eth_getTransactionReceipt": {
        const hash = lower(String(list[0]));
        const receipt = this.receipts.get(hash);
        return receipt ? this.receipt(hash, receipt) : null;
      }
      default:
        throw new Error(`FakeRpc: unscripted ${method}`);
    }
  };
}

// ------------------------------------------------------------------------------------------------ event logs

function nonIndexed(event: AbiEvent): AbiParameter[] {
  return event.inputs.filter((input) => !("indexed" in input && input.indexed));
}

const claimCreatedAbi = (claimRegistryAbi as Abi).find((item) => item.type === "event" && item.name === "ClaimCreated") as AbiEvent;
const newMarketAbi = seerMarketFactoryAbi.find((item) => item.type === "event" && item.name === "NewMarket") as AbiEvent;

/** The ClaimRegistry's ClaimCreated log for an event, as the contract emits it. */
export function claimCreatedLog(event: ClaimCreatedEvent): RawLog {
  const topics = encodeEventTopics({ abi: claimRegistryAbi, eventName: "ClaimCreated", args: { market: event.market, creator: event.creator, claimDocumentSha256: event.claimDocumentSha256 } }) as Hex32[];
  const claim = {
    creator: event.creator,
    createdAt: BigInt(event.blockTimestamp),
    evidenceDeadline: BigInt(event.evidenceDeadline),
    revealDeadline: BigInt(event.revealDeadline),
    repositoryId: BigInt(event.repositoryId),
    commit: `0x${event.commit}` as Hex,
    claimDocumentSha256: event.claimDocumentSha256,
    policyDocumentSha256: event.policyDocumentSha256,
    questionId: event.questionId,
    conditionId: event.conditionId,
    marketNameHash: event.marketNameHash,
    minBond: event.minBond,
    yesToken: event.yesToken,
    noToken: event.noToken,
    invalidToken: event.invalidToken,
  };
  return { address: event.address, topics, data: encodeAbiParameters(nonIndexed(claimCreatedAbi), [claim, event.title, event.marketName]) };
}

/** Seer's NewMarket log for the same market, from the factory. */
export function newMarketLog(event: ClaimCreatedEvent, factory: Address): RawLog {
  const topics = encodeEventTopics({ abi: seerMarketFactoryAbi, eventName: "NewMarket", args: { market: event.market } }) as Hex32[];
  const data = encodeAbiParameters(nonIndexed(newMarketAbi), [event.marketName, zeroAddress, event.conditionId, event.questionId, [event.questionId]]);
  return { address: factory, topics, data };
}

// ------------------------------------------------------------------------------------------------ mining

type Body<T> = T extends ChainEvent ? Omit<T, "chainId" | "blockNumber" | "blockHash" | "blockTimestamp" | "transactionHash" | "logIndex"> : never;
export type EventBody = Body<ChainEvent>;

/**
 * Blocks with strictly increasing numbers stamped with the fake clock. Every mined block is applied to the native index
 * and advances its cursor (finalized-only indexer: what the API sees is exactly what was applied).
 */
export class ChainSim {
  private block = 40_000_000n;

  constructor(
    private readonly indexer: SqlExecutor,
    private readonly clock: FakeClock,
    private readonly rpc: FakeRpc,
    private readonly options: { chainId: number; questionTimeout: number },
  ) {}

  get blockNumber(): bigint {
    return this.block;
  }

  /** Mines one block holding `bodies` (in order) at the current fake time; returns the full events. `txHash`: every
   *  log of the block comes from that one transaction (a user's reported hash). */
  async mine(bodies: readonly EventBody[], options: { txHash?: Hex32 } = {}): Promise<ChainEvent[]> {
    this.block += 1n;
    const number = this.block;
    const blockHash = hash32(`block:${number}`);
    const timestamp = this.clock.unix();
    const events = bodies.map(
      (body, logIndex) =>
        ({
          ...body,
          chainId: this.options.chainId,
          blockNumber: number,
          blockHash,
          blockTimestamp: timestamp,
          transactionHash: options.txHash ?? hash32(`tx:${number}:${logIndex}`),
          logIndex,
        }) as ChainEvent,
    );
    await this.indexer.transaction(async (tx) => {
      await applyEvents(tx, events, this.options);
      await advanceCursor(tx, { chainId: this.options.chainId, block: number, blockHash, blockTimestamp: timestamp });
    });
    await recordObservation(this.indexer, this.options.chainId, number, number + 2n);
    this.rpc.head = number + 2n;
    return events;
  }

  /** An empty finalized block: keeps the read model fresh after the clock moved. */
  async tick(): Promise<void> {
    await this.mine([]);
  }

  /** An integrity halt, written by the indexer role as the poller does on a provider disagreement. */
  async halt(): Promise<void> {
    await recordHalt(this.indexer, this.options.chainId, "log_disagreement", "e2e: providers disagree", this.block);
  }

  async clearHalts(): Promise<void> {
    await this.indexer.query("DELETE FROM pine_index.halts WHERE chain_id = $1 RETURNING id", [this.options.chainId]);
  }
}

/** Deterministic transaction hash of a simulated user transaction. */
export const txHashOf = (seed: string): Hex32 => `0x${createHash("sha256").update(seed).digest("hex")}` as Hex32;
