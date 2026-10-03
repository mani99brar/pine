// Test support for the claims module (tests only; never imported by production code).

import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  toBytes,
  zeroAddress,
  type AbiEvent,
  type AbiParameter,
} from "viem";
import { claimRegistryAbi } from "@pine/shared/abi/generated";
import { seerMarketFactoryAbi } from "@pine/shared/abi/external";
import { encodeClaimDocument, type ClaimDocument } from "@pine/shared/claim-document";
import type { ClaimCreatedEvent } from "@pine/shared/chain-events";
import { renderQuestion } from "@pine/shared/question";
import { exampleClaimDocument } from "@pine/shared/testing/fixtures";
import type { Address, Hex32 } from "@pine/shared/types";
import type { RouteModule, SessionInfo } from "../../../contracts/app.js";
import type { AppConfig } from "../../../contracts/config.js";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { MemoryReadModel } from "@pine/shared/testing/memory-read-model";
import {
  buildTestApp,
  createTestContext,
  FakeCompliance,
  FakeGitHubGateway,
  FakeModeration,
  FakeQuotas,
  insertTestUser,
  MemoryAuditLog,
  MemoryContentStore,
  MemoryMetrics,
  TEST_ADDRESSES,
  testConfig,
  testSession,
  testSessionHeaders,
  type TestContext,
} from "../../../contracts/testing.js";
import { createClaimsModule, DEFAULT_CATALOG_DIR } from "../index.js";
import { releaseSuiteLock } from "./lock.js";

export const REPO = { id: 427016914, owner: "kleros", name: "kleros-v2" } as const;
export const TARGET_COMMIT = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
export const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const PULL_NUMBER = 2101;
export const FACTORY = "0x83183da839ce8228e31ae41222ead9edbb5cdcf1" as Address;
export const REGISTRY = TEST_ADDRESSES.claimRegistry as Address;
export const EVIDENCE_REGISTRY = TEST_ADDRESSES.evidenceRegistry as Address;
export const BOT_POLICY_SHA = "0x9404b90b7ea23aabc44a78b76b19e7b156e8e8ffaec699bd12b4dabdb2da2cfc" as Hex32;
export const FUNC_POLICY_SHA = "0x95772c253f93d6e36ce863fd1c374e783ee1fd75eec31e552289bac1953be5f7" as Hex32;

export async function copyCatalog(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pine-claims-catalog-"));
  await cp(DEFAULT_CATALOG_DIR, dir, { recursive: true });
  return dir;
}

export function draftBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository: { owner: REPO.owner, name: REPO.name },
    commit: TARGET_COMMIT,
    baseCommit: null,
    membership: { kind: "pull", number: PULL_NUMBER },
    policy: { id: "BOT-001", version: "0.1.0" },
    title: "Reporter deposits never use arbitration funds or the operator gas reserve",
    requirement: "Each reporter-funding deposit's principal is allocated only from eligible bridging/reporter funds in scope.",
    violation: "A reachable sequence in which a positive reporter deposit draws principal from an arbitration allocation.",
    scope: { components: ["bots/gateway-balancer/src/reporter"], outOfScope: ["LI.FI execution"] },
    allowedInputs: "Configurations valid under config/example.json.",
    assumptions: ["Operator reserve may pay reporter transaction gas fees."],
    faultModel: "Process crash between any two persisted steps; RPC timeouts.",
    regressionOnly: false,
    exclusions: ["Gas fees paid from the operator reserve."],
    policyParameters: { sourceRequirement: "spec sections 2.2 and 4.2", startingStates: "Reachable from an empty journal", simulatedAdapters: ["lifi"] },
    environment: {
      runtime: "Node 24.21.0 on Linux x64",
      dependencies: "yarn.lock at the target commit",
      configuration: "config/example.json at the target commit",
      externalState: "Simulated chains; no live RPC",
      reproduction: { setup: "yarn install --immutable", command: "yarn test", notes: "" },
    },
    evidenceWindowSeconds: 7 * 86_400,
    minBondWei: null,
    ...overrides,
  };
}

// ------------------------------------------------------------------------------------------------ scripted chain

export interface RawLog {
  address: Address;
  topics: Hex32[];
  data: `0x${string}`;
}

export interface ChainScript {
  gasPrice: bigint;
  /** "<creator>|<digest>" -> market for ClaimRegistry.marketOf at latest. */
  markets: Map<string, Address>;
  /**
   * tx hash -> receipt (status + logs, mined at `blockNumber`, default 16: below every indexed block of these tests),
   * or "error" / an Error (thrown as is) to simulate an RPC failure.
   */
  receipts: Map<string, { status: "success" | "reverted"; logs: RawLog[]; blockNumber?: bigint } | "error" | Error>;
  failMarketOf: boolean;
  calls: string[];
  /** Transaction hashes passed to eth_getTransactionReceipt, in call order (lower case). */
  receiptLookups: string[];
}

function rawReceipt(hash: string, receipt: { status: "success" | "reverted"; logs: RawLog[]; blockNumber?: bigint }) {
  const blockHash = `0x${"bb".repeat(32)}`;
  const blockNumber = `0x${(receipt.blockNumber ?? 16n).toString(16)}`;
  return {
    blockHash,
    blockNumber,
    contractAddress: null,
    cumulativeGasUsed: "0x1",
    effectiveGasPrice: "0x1",
    from: "0x00000000000000000000000000000000000a11ce",
    gasUsed: "0x1",
    logs: receipt.logs.map((log, index) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      blockHash,
      blockNumber,
      transactionHash: hash,
      transactionIndex: "0x0",
      logIndex: `0x${index.toString(16)}`,
      removed: false,
    })),
    logsBloom: `0x${"00".repeat(256)}`,
    status: receipt.status === "success" ? "0x1" : "0x0",
    to: REGISTRY,
    transactionHash: hash,
    transactionIndex: "0x0",
    type: "0x2",
  };
}

export function scriptChain(ctx: TestContext): ChainScript {
  const script: ChainScript = { gasPrice: 2_000_000_000n, markets: new Map(), receipts: new Map(), failMarketOf: false, calls: [], receiptLookups: [] };
  ctx.chain.setHandler(async (method, params) => {
    script.calls.push(method);
    switch (method) {
      case "eth_chainId":
        return "0x64";
      case "eth_gasPrice":
        return `0x${script.gasPrice.toString(16)}`;
      case "eth_blockNumber":
        return "0x100";
      case "eth_call": {
        if (script.failMarketOf) throw new Error("rpc down https://rpc.example/secret-key");
        const [call] = params as [{ to: string; data: `0x${string}` }];
        const decoded = decodeFunctionData({ abi: claimRegistryAbi, data: call.data });
        if (decoded.functionName !== "marketOf") throw new Error(`unscripted call ${decoded.functionName}`);
        const [creator, digest] = decoded.args as [string, string];
        const market = script.markets.get(`${creator.toLowerCase()}|${digest.toLowerCase()}`) ?? zeroAddress;
        return encodeFunctionResult({ abi: claimRegistryAbi, functionName: "marketOf", result: market });
      }
      case "eth_getTransactionReceipt": {
        const [hash] = params as [string];
        script.receiptLookups.push(hash.toLowerCase());
        const receipt = script.receipts.get(hash.toLowerCase());
        if (receipt === "error") throw new Error("receipt fetch failed");
        if (receipt instanceof Error) throw receipt;
        return receipt ? rawReceipt(hash, receipt) : null;
      }
      default:
        throw new Error(`Unscripted RPC call: ${method}`);
    }
  });
  return script;
}

function nonIndexed(event: AbiEvent): AbiParameter[] {
  return event.inputs.filter((input) => !("indexed" in input && input.indexed));
}

const claimCreatedAbi = claimRegistryAbi.find((item) => item.type === "event" && item.name === "ClaimCreated") as AbiEvent;
const newMarketAbi = seerMarketFactoryAbi.find((item) => item.type === "event" && item.name === "NewMarket") as AbiEvent;

export function claimCreatedLog(event: ClaimCreatedEvent, overrides: { address?: Address; creator?: Address } = {}): RawLog {
  const creator = overrides.creator ?? event.creator;
  const topics = encodeEventTopics({ abi: claimRegistryAbi, eventName: "ClaimCreated", args: { market: event.market, creator, claimDocumentSha256: event.claimDocumentSha256 } }) as Hex32[];
  const claim = {
    creator,
    createdAt: BigInt(event.blockTimestamp),
    evidenceDeadline: BigInt(event.evidenceDeadline),
    revealDeadline: BigInt(event.revealDeadline),
    repositoryId: BigInt(event.repositoryId),
    commit: `0x${event.commit}` as `0x${string}`,
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
  const data = encodeAbiParameters(nonIndexed(claimCreatedAbi), [claim, event.title, event.marketName]);
  return { address: overrides.address ?? event.address, topics, data };
}

export function newMarketLog(
  event: ClaimCreatedEvent,
  overrides: { address?: Address; marketName?: string; market?: Address; conditionId?: Hex32; questionId?: Hex32 } = {},
): RawLog {
  const market = overrides.market ?? event.market;
  const questionId = overrides.questionId ?? event.questionId;
  const topics = encodeEventTopics({ abi: seerMarketFactoryAbi, eventName: "NewMarket", args: { market } }) as Hex32[];
  const data = encodeAbiParameters(nonIndexed(newMarketAbi), [overrides.marketName ?? event.marketName, zeroAddress, overrides.conditionId ?? event.conditionId, questionId, [questionId]]);
  return { address: overrides.address ?? FACTORY, topics, data };
}

// ------------------------------------------------------------------------------------------------ read model claims

let sequence = 0;
const hex = (prefix: string, value: number, bytes: number): `0x${string}` => `0x${prefix}${value.toString(16).padStart(bytes * 2 - prefix.length, "0")}`;

/** A ClaimCreated event consistent with `document` (unless overridden), with a unique market, tx and position. */
export function claimEventFor(document: ClaimDocument, sha256: Hex32, overrides: Partial<ClaimCreatedEvent> = {}): ClaimCreatedEvent {
  sequence += 1;
  const n = sequence;
  const base = {
    evidenceRegistry: EVIDENCE_REGISTRY,
    title: overrides.title ?? document.claim.title,
    evidenceDeadline: overrides.evidenceDeadline ?? document.evidence.evidenceDeadline,
    revealDeadline: overrides.revealDeadline ?? document.evidence.revealDeadline,
    repositoryId: overrides.repositoryId ?? document.target.repository.id,
    commit: overrides.commit ?? document.target.commit,
    claimDocumentSha256: overrides.claimDocumentSha256 ?? sha256,
    policyDocumentSha256: overrides.policyDocumentSha256 ?? document.policy.sha256,
  };
  let marketName: string;
  try {
    marketName = overrides.marketName ?? renderQuestion(base);
  } catch {
    marketName = "unrenderable";
  }
  return {
    kind: "ClaimCreated",
    chainId: 100,
    address: REGISTRY,
    blockNumber: BigInt(2_000 + n),
    blockHash: hex("b", n, 32) as Hex32,
    blockTimestamp: 1_790_000_000 + n,
    transactionHash: hex("7", n, 32) as Hex32,
    logIndex: 1,
    market: hex("3", n, 20) as Address,
    creator: document.creator,
    claimDocumentSha256: base.claimDocumentSha256,
    policyDocumentSha256: base.policyDocumentSha256,
    repositoryId: base.repositoryId,
    commit: base.commit,
    questionId: hex("a", n, 32) as Hex32,
    conditionId: hex("c", n, 32) as Hex32,
    evidenceDeadline: base.evidenceDeadline,
    revealDeadline: base.revealDeadline,
    minBond: BigInt(document.market.minBondWei),
    title: base.title,
    marketName,
    marketNameHash: overrides.marketNameHash ?? keccak256(toBytes(marketName)),
    yesToken: hex("d1", n, 20) as Address,
    noToken: hex("d2", n, 20) as Address,
    invalidToken: hex("d3", n, 20) as Address,
    ...overrides,
  };
}

/** Registers an on-chain claim: read-model event plus a creation receipt with ClaimCreated and NewMarket logs. */
export function addOnChainClaim(
  ctx: TestContext,
  chain: ChainScript,
  document: ClaimDocument,
  sha256: Hex32,
  options: { event?: Partial<ClaimCreatedEvent>; logs?: (event: ClaimCreatedEvent) => RawLog[]; fresh?: boolean } = {},
): ClaimCreatedEvent {
  const event = claimEventFor(document, sha256, options.event);
  ctx.readModel.apply([event]);
  chain.receipts.set(event.transactionHash.toLowerCase(), { status: "success", logs: options.logs ? options.logs(event) : [claimCreatedLog(event), newMarketLog(event)] });
  if (options.fresh !== false) markFresh(ctx, event.blockNumber);
  return event;
}

let indexedBlock = 10_000n;
/** Marks the read model as indexed up to the fake clock (fresh, not halted). */
export function markFresh(ctx: TestContext, atLeast: bigint = 0n): bigint {
  indexedBlock = (indexedBlock > atLeast ? indexedBlock : atLeast) + 1n;
  ctx.readModel.markIndexed(indexedBlock, ctx.clock.unix());
  return indexedBlock;
}

/** Marks the read model as indexed up to chain time `timestamp`, independently of the fake clock (not halted). */
export function markIndexedAt(ctx: TestContext, timestamp: number): void {
  indexedBlock += 1n;
  ctx.readModel.markIndexed(indexedBlock, timestamp);
}

export function documentWith(mutate: (document: ClaimDocument) => void = () => {}): { document: ClaimDocument; bytes: Uint8Array; sha256: Hex32 } {
  const document = structuredClone(exampleClaimDocument());
  mutate(document);
  const { bytes, sha256 } = encodeClaimDocument(document);
  return { document, bytes, sha256 };
}

// ------------------------------------------------------------------------------------------------ app

export interface Harness {
  ctx: TestContext;
  app: FastifyInstance;
  module: RouteModule;
  chain: ChainScript;
  session: SessionInfo;
  headers: Record<string, string>;
  catalogDir: string;
  /** A new, GitHub-linked user (unique per call). */
  user(options?: { linkGitHub?: boolean }): Promise<{ session: SessionInfo; headers: Record<string, string> }>;
  /** The same database and fakes with a different configuration, served by a fresh app (closed after the test). */
  variant(config: Partial<AppConfig>): Promise<{ ctx: TestContext; app: FastifyInstance; module: RouteModule }>;
}

const START = new Date("2026-10-01T00:00:00.000Z");
let userCounter = 0;

function freshSession(): SessionInfo {
  userCounter += 1;
  const suffix = `${process.pid.toString(16)}${userCounter.toString(16)}`.padStart(12, "0").slice(-12);
  return testSession({
    sessionId: randomUUID(),
    userId: `00000000-0000-4000-8000-${suffix}`,
    wallet: `0x${"a11ce".padStart(28, "0")}${suffix}` as Address,
  });
}

function seedGitHub(ctx: TestContext): void {
  ctx.github.addRepo({ id: REPO.id, owner: REPO.owner, ownerId: 1, name: REPO.name, fullName: `${REPO.owner}/${REPO.name}`, fork: false, defaultBranch: "main", htmlUrl: `https://github.com/${REPO.owner}/${REPO.name}`, pushedAt: null });
  ctx.github.addPull(REPO.owner, REPO.name, {
    number: PULL_NUMBER,
    title: "Reporter funding",
    state: "open",
    merged: false,
    headSha: TARGET_COMMIT,
    headRef: "feature",
    headRepoId: REPO.id,
    baseSha: BASE_COMMIT,
    baseRef: "main",
    htmlUrl: `https://github.com/${REPO.owner}/${REPO.name}/pull/${PULL_NUMBER}`,
    authorLogin: "alice",
    updatedAt: "2026-09-30T00:00:00Z",
  });
  ctx.github.addBranchCommit(REPO.owner, REPO.name, "main", BASE_COMMIT);
}

/**
 * One in-memory Postgres per test file (PGlite costs ~400 MB; test files import ./lock.js first so their databases
 * never run concurrently). Before each test: tables truncated, fakes and clock reset, a fresh user signed in.
 */
export function useHarness(): () => Harness {
  let harness: Harness | null = null;
  let base: TestContext | null = null;
  const variants: FastifyInstance[] = [];

  beforeAll(async () => {
    base = await createTestContext();
  }, 30 * 60_000);

  afterAll(async () => {
    try {
      await harness?.app.close();
      await base?.close();
      if (harness) await rm(harness.catalogDir, { recursive: true, force: true });
    } finally {
      await releaseSuiteLock();
    }
  });

  beforeEach(async () => {
    const ctx = base!;
    await ctx.database.sql.exec("TRUNCATE claims_index, claim_publication_txs, claim_publications, claim_previews, claim_drafts");
    ctx.clock.set(START);
    ctx.readModel = new MemoryReadModel({ chainId: ctx.config.chainId, questionTimeout: ctx.config.seer.questionTimeoutSeconds });
    ctx.contentStore = new MemoryContentStore();
    ctx.github = new FakeGitHubGateway();
    ctx.audit = new MemoryAuditLog(ctx.redact);
    ctx.moderation = new FakeModeration();
    ctx.compliance = new FakeCompliance();
    ctx.quotas = new FakeQuotas();
    ctx.metrics = new MemoryMetrics();
    seedGitHub(ctx);
    markFresh(ctx);
    const chain = scriptChain(ctx);
    const session = freshSession();
    await insertTestUser(ctx.database, session);
    ctx.github.linkedUsers.add(session.userId);
    if (!harness) {
      const catalogDir = await copyCatalog();
      const module = createClaimsModule({ catalogDir });
      const app = await buildTestApp([module], ctx);
      harness = {
        ctx,
        app,
        module,
        chain,
        session,
        headers: testSessionHeaders(session),
        catalogDir,
        async user(options = {}) {
          const next = freshSession();
          await insertTestUser(ctx.database, next);
          if (options.linkGitHub !== false) ctx.github.linkedUsers.add(next.userId);
          return { session: next, headers: testSessionHeaders(next) };
        },
        async variant(config) {
          const view = { ...ctx, config: testConfig({ ...config }) } as TestContext;
          // Fakes are read through the shared context so tests can keep scripting them.
          for (const key of ["readModel", "contentStore", "github", "audit", "moderation", "compliance", "quotas", "metrics", "chain", "clock"] as const) {
            Object.defineProperty(view, key, { get: () => ctx[key], enumerable: true });
          }
          const variantModule = createClaimsModule({ catalogDir: harness!.catalogDir });
          const app = await buildTestApp([variantModule], view);
          variants.push(app);
          return { ctx: view, app, module: variantModule };
        },
      };
    } else {
      harness.chain = chain;
      harness.session = session;
      harness.headers = testSessionHeaders(session);
    }
  });

  afterEach(async () => {
    while (variants.length > 0) await variants.pop()!.close();
  });

  return () => {
    if (!harness) throw new Error("harness used outside a test");
    return harness;
  };
}

export async function createDraft(harness: Harness, body: Record<string, unknown> = draftBody(), headers = harness.headers): Promise<{ id: string; revision: number }> {
  const response = await harness.app.inject({ method: "POST", url: "/api/v1/drafts", headers, payload: body });
  if (response.statusCode !== 201) throw new Error(`draft creation failed: ${response.statusCode} ${response.body}`);
  return (response.json() as { draft: { id: string; revision: number } }).draft;
}

export interface PreviewResponse {
  previewId: string;
  documentSha256: Hex32;
  cid: string;
  document: ClaimDocument;
  question: string;
  tokenNames: [string, string];
  planExpiresAt: number;
  timeline: Record<string, unknown>;
  costs: Record<string, unknown>;
  disclosures: { code: string; text: string }[];
}

export async function createPreview(harness: Harness, draftId: string, headers = harness.headers): Promise<PreviewResponse> {
  const response = await harness.app.inject({ method: "POST", url: `/api/v1/drafts/${draftId}/preview`, headers, payload: { attestLiveSystemImpactNone: true } });
  if (response.statusCode !== 201) throw new Error(`preview failed: ${response.statusCode} ${response.body}`);
  return response.json() as PreviewResponse;
}

export async function publish(harness: Harness, preview: { previewId: string; documentSha256: string }, headers = harness.headers): Promise<LightMyRequestResponse> {
  return harness.app.inject({ method: "POST", url: "/api/v1/publications", headers, payload: { previewId: preview.previewId, documentSha256: preview.documentSha256 } });
}
