// Test harness of the funding module: a scripted Gnosis chain that answers eth_call by decoding calldata against the
// frozen ABIs, seeded claims whose documents pass the integrity gate, and a test app over the frozen harness.

import { decodeFunctionData, encodeFunctionResult, keccak256, toHex, type Abi, type Hex } from "viem";
import { algebraFactoryAbi, algebraPoolAbi, algebraPositionManagerAbi, algebraQuoterAbi } from "@pine/shared/abi/algebra";
import { erc20Abi } from "@pine/shared/abi/external";
import type { ClaimCreatedEvent } from "@pine/shared/chain-events";
import { encodeClaimDocument, type ClaimDocument } from "@pine/shared/claim-document";
import { renderQuestion } from "@pine/shared/question";
import { exampleClaimDocument } from "@pine/shared/testing/fixtures";
import type { Address, Hex32 } from "@pine/shared/types";
import { planFromWire, verifyPlan, type TxPlan, type WireTxPlan } from "@pine/shared/tx-plan";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createTestContext, insertTestUser, TEST_ADDRESSES, testSession, testSessionHeaders, type TestContext } from "../../../contracts/testing.js";
import type { SessionInfo } from "../../../contracts/app.js";
import { sdaiAbi } from "../chain.js";
import { FUNDING_PLAN_LIMITS, manifestOf, planContextFor } from "../common.js";
import { fundingModule } from "../index.js";
import { buildLaneTestApp, type LogCapture } from "./app.js";

export const SDAI: Address = "0xaf204776c7245bf4147c2612bf6e5972ee483701";
export const FACTORY: Address = "0xa0864cca6e114013ab0e27cbd5b6f4c8947da766";
export const NPM: Address = "0x91fd594c46d8b01e62dbdebed2401dde01817834";
export const QUOTER: Address = "0xcbad9fdf0d2814659eb26f600efdeaf005eda0f7";
export const ROUTER: Address = "0xec9048b59b3467415b1a38f63416407ea0c70fb8";
export const WAD = 10n ** 18n;
/** xDAI per sDAI used by the fake sDAI (1.25, so previewDeposit(100 xDAI) = 80 sDAI exactly). */
export const RATE = 1_250_000_000_000_000_000n;

export const ALICE = testSession();
export const BOB = testSession({ sessionId: "00000000-0000-4000-8000-000000000002", userId: "00000000-0000-4000-8000-0000000000bb", wallet: "0x00000000000000000000000000000000000b0b00" });

export interface PoolState {
  token0: Address;
  token1: Address;
  sqrtPriceX96: bigint;
  tick: number;
  fee: number;
  liquidity: bigint;
  tickSpacing: number;
  cooldown: number;
}

export interface PositionState {
  owner: Address;
  token0: Address;
  token1: Address;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

export interface FakeTx {
  receipt: { status: "0x0" | "0x1"; blockNumber: bigint } | null;
  tx: { to: Address; from: Address; input: Hex; value: bigint };
}

const revert = () => Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });

/** Scriptable chain state; `handle` is installed as the scripted RPC handler. */
export class FakeChain {
  block = 5_000n;
  finalized = 4_990n;
  rate = RATE;
  readonly pools = new Map<string, Address>();
  readonly poolStates = new Map<Address, PoolState>();
  readonly balances = new Map<string, bigint>();
  readonly positions = new Map<bigint, PositionState>();
  readonly transactions = new Map<string, FakeTx>();
  quote: (tokenIn: Address, tokenOut: Address, amountIn: bigint) => { amountOut: bigint; fee: number } | null = () => null;
  failTransport = false;
  readonly calls: { to: Address; functionName: string; block: string | undefined }[] = [];
  rpcCount = 0;

  private pairKey(a: string, b: string): string {
    return [a.toLowerCase(), b.toLowerCase()].sort().join("|");
  }

  addPool(pool: Address, state: PoolState): void {
    this.pools.set(this.pairKey(state.token0, state.token1), pool);
    this.poolStates.set(pool, state);
  }

  setBalance(token: Address, owner: Address, amount: bigint): void {
    this.balances.set(`${token.toLowerCase()}|${owner.toLowerCase()}`, amount);
  }

  ownedTokenIds(owner: Address): bigint[] {
    return [...this.positions.entries()].filter(([, position]) => position.owner.toLowerCase() === owner.toLowerCase()).map(([id]) => id);
  }

  private abiFor(to: Address): Abi {
    if (to === FACTORY) return algebraFactoryAbi;
    if (to === QUOTER) return algebraQuoterAbi;
    if (to === NPM) return algebraPositionManagerAbi;
    if (to === SDAI) return sdaiAbi;
    if (this.poolStates.has(to)) return algebraPoolAbi;
    return erc20Abi;
  }

  private answer(to: Address, functionName: string, args: readonly unknown[]): unknown {
    const pool = this.poolStates.get(to);
    switch (functionName) {
      case "poolByPair":
        return this.pools.get(this.pairKey(String(args[0]), String(args[1]))) ?? "0x0000000000000000000000000000000000000000";
      case "globalState":
        if (!pool) throw revert();
        return [pool.sqrtPriceX96, pool.tick, pool.fee, 0, 100, 100, true];
      case "liquidity":
        if (!pool) throw revert();
        return pool.liquidity;
      case "tickSpacing":
        if (!pool) throw revert();
        return pool.tickSpacing;
      case "liquidityCooldown":
        if (!pool) throw revert();
        return pool.cooldown;
      case "quoteExactInputSingle": {
        const result = this.quote(String(args[0]).toLowerCase() as Address, String(args[1]).toLowerCase() as Address, args[2] as bigint);
        if (result === null) throw revert();
        return [result.amountOut, result.fee];
      }
      case "previewDeposit":
        return ((args[0] as bigint) * WAD) / this.rate;
      case "convertToAssets":
        return ((args[0] as bigint) * this.rate) / WAD;
      case "balanceOf":
        if (to === NPM) return BigInt(this.ownedTokenIds(String(args[0]) as Address).length);
        return this.balances.get(`${to}|${String(args[0]).toLowerCase()}`) ?? 0n;
      case "tokenOfOwnerByIndex": {
        const id = this.ownedTokenIds(String(args[0]) as Address)[Number(args[1] as bigint)];
        if (id === undefined) throw revert();
        return id;
      }
      case "ownerOf": {
        const position = this.positions.get(args[0] as bigint);
        if (!position) throw revert();
        return position.owner;
      }
      case "positions": {
        const position = this.positions.get(args[0] as bigint);
        if (!position) throw revert();
        return [0n, "0x0000000000000000000000000000000000000000", position.token0, position.token1, position.tickLower, position.tickUpper, position.liquidity, 0n, 0n, position.tokensOwed0, position.tokensOwed1];
      }
      default:
        throw new Error(`FakeChain: unscripted ${functionName} on ${to}`);
    }
  }

  readonly handle = async (method: string, params: unknown): Promise<unknown> => {
    this.rpcCount += 1;
    if (this.failTransport) throw new Error("connect ECONNREFUSED https://rpc.example/secret-key");
    const list = Array.isArray(params) ? params : [];
    switch (method) {
      case "eth_blockNumber":
        return toHex(this.block);
      case "eth_getBlockByNumber":
        return { number: toHex(this.finalized) };
      case "eth_call": {
        const request = list[0] as { to: string; data: Hex };
        const to = request.to.toLowerCase() as Address;
        const abi = this.abiFor(to);
        const decoded = decodeFunctionData({ abi, data: request.data });
        this.calls.push({ to, functionName: decoded.functionName, block: typeof list[1] === "string" ? list[1] : undefined });
        const result = this.answer(to, decoded.functionName, (decoded.args ?? []) as readonly unknown[]);
        return encodeFunctionResult({ abi, functionName: decoded.functionName, result } as never);
      }
      case "eth_getTransactionReceipt": {
        const item = this.transactions.get(String(list[0]).toLowerCase());
        if (!item?.receipt) return null;
        return { status: item.receipt.status, blockNumber: toHex(item.receipt.blockNumber), transactionHash: list[0], logs: [] };
      }
      case "eth_getTransactionByHash": {
        const item = this.transactions.get(String(list[0]).toLowerCase());
        if (!item) return null;
        return { hash: list[0], to: item.tx.to, from: item.tx.from, input: item.tx.input, value: toHex(item.tx.value) };
      }
      default:
        throw new Error(`FakeChain: unscripted RPC ${method}`);
    }
  };
}

export interface SeededClaim {
  market: Address;
  yesToken: Address;
  noToken: Address;
  invalidToken: Address;
  claimDocumentSha256: Hex32;
  conditionId: Hex32;
  questionId: Hex32;
  document: ClaimDocument;
}

let seedCounter = 0;

/**
 * Seeds a ClaimCreated event whose document (stored in the content store) passes the integrity gate. `mutateEvent`
 * lets a test introduce a mismatch between the on-chain record and the document.
 */
export function seedClaim(
  ctx: TestContext,
  options: { market: Address; yesToken: Address; noToken: Address; invalidToken: Address; document?: ClaimDocument; storeDocument?: boolean; mutateEvent?: (event: ClaimCreatedEvent) => void },
): SeededClaim {
  const document = options.document ?? exampleClaimDocument();
  const { bytes, sha256 } = encodeClaimDocument(document);
  if (options.storeDocument !== false) void ctx.contentStore.put({ bytes, declaredMediaType: "application/json", maxBytes: 262_144 });
  seedCounter += 1;
  const questionId = keccak256(toHex(`question-${options.market}`)) as Hex32;
  const conditionId = keccak256(toHex(`condition-${options.market}`)) as Hex32;
  const marketName = renderQuestion({
    evidenceRegistry: TEST_ADDRESSES.evidenceRegistry,
    title: document.claim.title,
    evidenceDeadline: document.evidence.evidenceDeadline,
    revealDeadline: document.evidence.revealDeadline,
    repositoryId: document.target.repository.id,
    commit: document.target.commit,
    claimDocumentSha256: sha256,
    policyDocumentSha256: document.policy.sha256,
  });
  const event: ClaimCreatedEvent = {
    kind: "ClaimCreated",
    chainId: 100,
    address: TEST_ADDRESSES.claimRegistry,
    blockNumber: 2_000n + BigInt(seedCounter),
    blockHash: keccak256(toHex(`block-${seedCounter}`)) as Hex32,
    blockTimestamp: 1_790_812_800 - 3_600,
    transactionHash: keccak256(toHex(`tx-${options.market}`)) as Hex32,
    logIndex: 0,
    market: options.market,
    creator: document.creator,
    claimDocumentSha256: sha256,
    policyDocumentSha256: document.policy.sha256,
    repositoryId: document.target.repository.id,
    commit: document.target.commit,
    questionId,
    conditionId,
    evidenceDeadline: document.evidence.evidenceDeadline,
    revealDeadline: document.evidence.revealDeadline,
    minBond: BigInt(document.market.minBondWei),
    title: document.claim.title,
    marketName,
    marketNameHash: keccak256(toHex(marketName)) as Hex32,
    yesToken: options.yesToken,
    noToken: options.noToken,
    invalidToken: options.invalidToken,
  };
  options.mutateEvent?.(event);
  ctx.readModel.apply([event]);
  return { market: options.market, yesToken: options.yesToken, noToken: options.noToken, invalidToken: options.invalidToken, claimDocumentSha256: sha256, conditionId, questionId, document };
}

/** YES sorts below sDAI (YES = token0). */
export const MARKET_A = {
  market: "0x0000000000000000000000000000000000aaaa01",
  yesToken: "0x1000000000000000000000000000000000000001",
  noToken: "0x1000000000000000000000000000000000000002",
  invalidToken: "0x1000000000000000000000000000000000000003",
} as const satisfies Record<string, Address>;

/** YES sorts above sDAI (YES = token1). */
export const MARKET_B = {
  market: "0x0000000000000000000000000000000000bbbb01",
  yesToken: "0xf000000000000000000000000000000000000001",
  noToken: "0xf000000000000000000000000000000000000002",
  invalidToken: "0xf000000000000000000000000000000000000003",
} as const satisfies Record<string, Address>;

export interface Harness {
  ctx: TestContext;
  chain: FakeChain;
  app: FastifyInstance;
  /** Everything the app logged (in-memory stream). */
  logs: LogCapture;
  close(): Promise<void>;
}

/** One context, app and fake chain per test file (PGlite is heavy; operator clarification 1). */
export async function createHarness(): Promise<Harness> {
  const ctx = await createTestContext();
  const chain = new FakeChain();
  ctx.chain.setHandler(chain.handle);
  ctx.readModel.markIndexed(4_990n, Math.floor(ctx.clock.now().getTime() / 1000) - 10);
  await insertTestUser(ctx.database, ALICE);
  await insertTestUser(ctx.database, BOB);
  const { app, logs } = await buildLaneTestApp([fundingModule], ctx);
  return {
    ctx,
    chain,
    app,
    logs,
    async close() {
      await app.close();
      await ctx.close();
    },
  };
}

/** Moves the read model's indexed timestamp to "now" (fresh) after the clock moved. */
export function refreshIndexer(harness: Harness): void {
  harness.ctx.readModel.markIndexed(harness.chain.block, Math.floor(harness.ctx.clock.now().getTime() / 1000) - 5);
}

let keyCounter = 0;
export const freshKey = (): string => `key-${Date.now().toString(36)}-${(keyCounter += 1)}`;

export async function postPlan(harness: Harness, path: string, body: unknown, options: { session?: SessionInfo; key?: string | null } = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...testSessionHeaders(options.session ?? ALICE), "content-type": "application/json" };
  if (options.key !== null) headers["idempotency-key"] = options.key ?? freshKey();
  return harness.app.inject({ method: "POST", url: path, headers, payload: JSON.stringify(body) });
}

/** Decodes a plan from the wire (as a client would) and verifies it against the claim's market. */
export function decodeAndVerify(harness: Harness, wire: unknown, claim: { market: Address; yesToken: Address; noToken: Address; invalidToken: Address; questionId?: Hex32 }): TxPlan {
  const plan = planFromWire(wire as WireTxPlan);
  const manifest = manifestOf(harness.ctx.config);
  const context = planContextFor({ ...claim, questionId: claim.questionId ?? ("0x" + "11".repeat(32)) } as never);
  verifyPlan(plan, manifest, context, FUNDING_PLAN_LIMITS);
  return plan;
}

/** Lowercases every address inside decoded calldata arguments (viem decodes addresses EIP-55 checksummed). */
export function lowerAddresses<T>(value: T): T {
  if (typeof value === "string") return (/^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value) as T;
  if (Array.isArray(value)) return value.map((item) => lowerAddresses(item)) as T;
  if (typeof value === "object" && value !== null && typeof value !== "bigint") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, lowerAddresses(item)])) as T;
  }
  return value;
}
