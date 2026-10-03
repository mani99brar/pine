// Test support for the markets module (tests only; never imported by production code).

import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyRequest, type InjectOptions, type LightMyRequestResponse } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { realityV3Abi } from "@pine/shared/abi/external";
import type { ChainEvent } from "@pine/shared/chain-events";
import { buildDeploymentManifest, type DeploymentManifest } from "@pine/shared/deployment";
import { encodeEvidenceManifest, type EvidenceManifest } from "@pine/shared/evidence";
import type { ClaimRecord } from "@pine/shared/read-model";
import { MemoryReadModel } from "@pine/shared/testing/memory-read-model";
import { claimCreated, EventBuilder, SCENARIO_ADDRESSES } from "@pine/shared/testing/read-model-scenarios";
import { planFromWire, verifyPlan, type TxPlan, type WireTxPlan } from "@pine/shared/tx-plan";
import type { Address, Hex32 } from "@pine/shared/types";
import type { PGlite } from "@electric-sql/pglite";
import type { AppContext, Database, RouteModule, SessionInfo } from "../../../contracts/app.js";
import { ApiError, toErrorResponse } from "../../../contracts/errors.js";
import {
  ADMIN_STEP_UP_SECONDS,
  createScriptedChain,
  createTestContext,
  FakeClock,
  FakeCompliance,
  FakeGitHubGateway,
  FakeModeration,
  FakeQuotas,
  insertTestUser,
  MemoryAuditLog,
  MemoryContentStore,
  MemoryMetrics,
  TEST_SESSION_HEADER,
  testSession,
  testConfig,
  testSessionHeaders,
  type TestContext,
  type TestDatabase,
} from "../../../contracts/testing.js";
import type { SqlExecutor } from "../../../contracts/migrations.js";
import { createRedactor } from "../../../contracts/redact.js";
import { settledAudit } from "../audit.js";
import { MARKETS_PLAN_LIMITS } from "../common.js";
import { createMarketsModule } from "../index.js";
import { waitForMemory } from "./lock.js";

export const REGISTRY = SCENARIO_ADDRESSES.claimRegistry as Address;
export const EVIDENCE_REGISTRY = SCENARIO_ADDRESSES.evidenceRegistry as Address;
export const MANIFEST: DeploymentManifest = buildDeploymentManifest({ claimRegistry: REGISTRY, evidenceRegistry: EVIDENCE_REGISTRY, deploymentBlock: 1_000n });
export const ZERO32 = `0x${"0".repeat(64)}` as Hex32;

// ------------------------------------------------------------------------------------------------ test app

/**
 * Mirrors the frozen buildTestApp (zod compilers, request.session from the test header, requireSession/requireAdmin,
 * shared error mapping) and adds what PRD-04 section 4 requires of lane-local apps: @fastify/multipart registered with
 * exactly the core options of PRD-02 section 2.2, a logger writing to an in-memory stream, and a record of every
 * route's `config.pine`. Every inject waits for the request's audit flush (awaitAuditAfterInject).
 */
export async function buildMarketsTestApp(modules: RouteModule[], ctx: AppContext, logLines: string[], routes: { url: string; method: string; pine: unknown }[]): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: "trace", stream: { write: (line: string) => void logLines.push(line) } } }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(multipart, { limits: { fileSize: ctx.config.evidence.maxUploadBytes, files: 1, fields: 10, parts: 11 } });
  app.addHook("onRoute", (route) => {
    routes.push({ url: route.url, method: String(route.method), pine: (route.config as { pine?: unknown } | undefined)?.pine ?? null });
  });
  app.decorateRequest("session", null);
  app.addHook("onRequest", async (request) => {
    const raw = request.headers[TEST_SESSION_HEADER];
    if (typeof raw !== "string") {
      request.session = null;
      return;
    }
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    request.session = {
      ...(parsed as unknown as SessionInfo),
      authenticatedAt: new Date(String(parsed.authenticatedAt)),
      idleExpiresAt: new Date(String(parsed.idleExpiresAt)),
      absoluteExpiresAt: new Date(String(parsed.absoluteExpiresAt)),
    };
  });
  app.decorate("requireSession", async (request: FastifyRequest) => {
    if (!request.session) throw new ApiError("UNAUTHENTICATED", "Sign in required");
  });
  app.decorate("requireAdmin", async (request: FastifyRequest) => {
    if (!request.session) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    if (!request.session.isAdmin) throw new ApiError("FORBIDDEN", "Administrator access required");
    const age = (ctx.clock.now().getTime() - request.session.authenticatedAt.getTime()) / 1000;
    if (age > ADMIN_STEP_UP_SECONDS) throw new ApiError("STEP_UP_REQUIRED", "Sign in again to continue");
  });
  app.setErrorHandler((error, request, reply) => {
    const response = toErrorResponse(error, String(request.id), ctx.redact);
    if (response.retryAfterSeconds !== undefined) void reply.header("retry-after", String(response.retryAfterSeconds));
    void reply.status(response.statusCode).send(response.body);
  });
  for (const module of modules) {
    await app.register(async (scope) => {
      await module.register(scope, ctx);
    });
  }
  await app.ready();
  awaitAuditAfterInject(app, ctx);
  return app;
}

/** The unwrapped inject of each test app (see awaitAuditAfterInject). */
const rawInjects = new WeakMap<FastifyInstance, FastifyInstance["inject"]>();

/**
 * Test-harness rule (PRD-07 3c, operator decision): handlers start the audit flush without awaiting it, so every
 * inject of a test app waits for the module's in-flight flush after the response (it requests no further drain). The
 * existing exact-match audit tests therefore see the recorded entries right after the response.
 */
function awaitAuditAfterInject(app: FastifyInstance, ctx: AppContext): void {
  const raw = app.inject.bind(app) as FastifyInstance["inject"];
  rawInjects.set(app, raw);
  const wrapped = async (options: InjectOptions | string): Promise<LightMyRequestResponse> => {
    const response = await raw(options);
    await settledAudit(ctx);
    return response;
  };
  app.inject = wrapped as unknown as FastifyInstance["inject"];
}

/** An inject that does not wait for the audit flush its request started (the "slow audit store" tests). */
export function rawInject(app: FastifyInstance, options: InjectOptions): Promise<LightMyRequestResponse> {
  const raw = rawInjects.get(app);
  if (!raw) throw new Error("not a lane test app");
  return raw(options);
}

// ------------------------------------------------------------------------------------------------ scripted chain

export interface FakeTx {
  from: Address;
  to: Address;
  input: Hex;
  value: bigint;
  blockNumber: bigint;
  status: "success" | "reverted";
}

/** Scripted Gnosis RPC: Reality reads, finalized block, receipts and transactions. Unscripted calls throw. */
export class ChainFake {
  readonly reopened = new Map<string, Hex32>();
  readonly historyHashes = new Map<string, Hex32>();
  readonly balances = new Map<string, bigint>();
  readonly timeouts = new Map<string, number>();
  readonly questionParams = new Map<string, { arbitrator: Address; openingTs: number; minBond: bigint }>();
  readonly txs = new Map<string, FakeTx>();
  finalized = 100_000n;
  failCalls = false;
  readonly calls: string[] = [];
  /** While set, every eth_call waits for release() (holds RPC promises open). */
  private held: { promise: Promise<void>; waiting: number } | null = null;

  /** Holds every following eth_call open until release(); waiting() counts the calls currently held. */
  hold(): { waiting(): number; release(): void } {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = { promise, waiting: 0 };
    this.held = held;
    return {
      waiting: () => held.waiting,
      release: () => {
        if (this.held === held) this.held = null;
        release();
      },
    };
  }

  install(ctx: TestContext): void {
    ctx.chain.setHandler(async (method, params) => this.handle(method, params));
  }

  private async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return "0x64";
      case "eth_getBlockByNumber":
        return { number: `0x${this.finalized.toString(16)}` };
      case "eth_call": {
        const held = this.held;
        if (held) {
          held.waiting += 1;
          await held.promise;
          held.waiting -= 1;
        }
        if (this.failCalls) throw new Error("rpc down https://rpc.example/v1/secret-key-123");
        const [call] = params as [{ to: string; data: Hex }];
        if (call.to.toLowerCase() !== MANIFEST.seer.realitio) throw new Error(`unscripted eth_call target ${call.to}`);
        const decoded = decodeFunctionData({ abi: realityV3Abi, data: call.data });
        const arg = String((decoded.args ?? [])[0] ?? "").toLowerCase();
        this.calls.push(`${decoded.functionName}:${arg}`);
        const result = (value: unknown) => encodeFunctionResult({ abi: realityV3Abi, functionName: decoded.functionName as never, result: value as never });
        switch (decoded.functionName) {
          case "reopened_questions":
            return result(this.reopened.get(arg) ?? ZERO32);
          case "getHistoryHash":
            return result(this.historyHashes.get(arg) ?? ZERO32);
          case "balanceOf":
            return result(this.balances.get(arg) ?? 0n);
          case "getTimeout":
            return result(this.timeouts.get(arg) ?? 0);
          case "getArbitrator":
            return result(this.questionParams.get(arg)?.arbitrator ?? "0x0000000000000000000000000000000000000000");
          case "getOpeningTS":
            return result(this.questionParams.get(arg)?.openingTs ?? 0);
          case "getMinBond":
            return result(this.questionParams.get(arg)?.minBond ?? 0n);
          default:
            throw new Error(`unscripted Reality call ${decoded.functionName}`);
        }
      }
      case "eth_getTransactionReceipt": {
        const [hash] = params as [string];
        const tx = this.txs.get(hash.toLowerCase());
        if (!tx) return null;
        const blockHash = `0x${"bb".repeat(32)}`;
        return {
          blockHash,
          blockNumber: `0x${tx.blockNumber.toString(16)}`,
          contractAddress: null,
          cumulativeGasUsed: "0x1",
          effectiveGasPrice: "0x1",
          from: tx.from,
          gasUsed: "0x1",
          logs: [],
          logsBloom: `0x${"00".repeat(256)}`,
          status: tx.status === "success" ? "0x1" : "0x0",
          to: tx.to,
          transactionHash: hash,
          transactionIndex: "0x0",
          type: "0x2",
        };
      }
      case "eth_getTransactionByHash": {
        const [hash] = params as [string];
        const tx = this.txs.get(hash.toLowerCase());
        if (!tx) return null;
        return {
          hash,
          nonce: "0x1",
          blockHash: `0x${"bb".repeat(32)}`,
          blockNumber: `0x${tx.blockNumber.toString(16)}`,
          transactionIndex: "0x0",
          from: tx.from,
          to: tx.to,
          value: `0x${tx.value.toString(16)}`,
          gas: "0x5208",
          maxFeePerGas: "0x1",
          maxPriorityFeePerGas: "0x1",
          input: tx.input,
          type: "0x2",
          accessList: [],
          chainId: "0x64",
          v: "0x0",
          yParity: "0x0",
          r: `0x${"11".repeat(32)}`,
          s: `0x${"22".repeat(32)}`,
        };
      }
      default:
        throw new Error(`Unscripted RPC call: ${method}`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ harness

export interface Harness {
  ctx: TestContext;
  app: FastifyInstance;
  module: RouteModule;
  chain: ChainFake;
  /** Event builder of the current test (block/time strictly increasing). */
  b: EventBuilder;
  session: SessionInfo;
  headers: Record<string, string>;
  logLines: string[];
  routes: { url: string; method: string; pine: unknown }[];
  /** A new signed-in user with a users row. */
  user(): Promise<{ session: SessionInfo; headers: Record<string, string> }>;
  /** Applies events to the read model and marks it fresh at the clock. */
  apply(...events: ChainEvent[]): Promise<void>;
  /** Marks the read model indexed up to the current clock (fresh, not halted). */
  fresh(): Promise<void>;
  /** Sets the clock to unix seconds (the read model is NOT re-marked: call fresh() when needed). */
  at(seconds: number): void;
}

let userCounter = 0;

export function freshSession(): SessionInfo {
  userCounter += 1;
  const suffix = `${process.pid.toString(16)}${userCounter.toString(16)}`.padStart(12, "0").slice(-12);
  return testSession({ sessionId: randomUUID(), userId: `00000000-0000-4000-8000-${suffix}`, wallet: `0x${"a11ce".padStart(28, "0")}${suffix}` as Address });
}

/** A database that fails on any use, for test files whose routes never touch Postgres. */
function noDatabase(): TestDatabase {
  const fail = (): never => {
    throw new Error("this test file runs without a database (useHarness({ database: false }))");
  };
  const handle: unknown = new Proxy({}, { get: () => fail });
  const sqlExecutor: SqlExecutor = { exec: fail, query: fail, transaction: fail };
  return { db: handle as Database, sql: sqlExecutor, client: handle as PGlite, close: async () => {} };
}

/** createTestContext with the same fakes but without PGlite (whose initialisation alone peaks near 1.2 GB RSS). */
function contextWithoutDatabase(): TestContext {
  const config = testConfig();
  const redact = createRedactor(["test-secret-value"]);
  const database = noDatabase();
  return {
    config,
    db: database.db,
    database,
    clock: new FakeClock(),
    redact,
    readModel: new MemoryReadModel({ chainId: config.chainId, questionTimeout: config.seer.questionTimeoutSeconds }),
    chain: createScriptedChain(),
    contentStore: new MemoryContentStore(),
    github: new FakeGitHubGateway(),
    audit: new MemoryAuditLog(redact),
    moderation: new FakeModeration(),
    compliance: new FakeCompliance(),
    quotas: new FakeQuotas(),
    metrics: new MemoryMetrics(),
    close: async () => {},
  };
}

/**
 * One in-memory Postgres per test file (every test file imports ./lock.js first so their databases never initialise
 * concurrently; files whose routes never touch Postgres pass `database: false` and get none). Before each test: tables
 * truncated, fakes, read model and clock reset, and a fresh user signed in. The app is built once per file; it reads
 * ctx.* at call time.
 */
export function useHarness(options: { database?: boolean } = {}): () => Harness {
  const withDatabase = options.database !== false;
  let harness: Harness | null = null;
  let base: TestContext | null = null;

  beforeAll(async () => {
    if (withDatabase) {
      await waitForMemory();
      base = await createTestContext();
    } else {
      base = contextWithoutDatabase();
    }
  }, 30 * 60_000);

  // The suite lock is released when this worker process exits (see ./lock.ts), not here.
  afterAll(async () => {
    await harness?.app.close();
    await base?.close();
  });

  beforeEach(async () => {
    const ctx = base!;
    if (withDatabase) await ctx.database.sql.exec("TRUNCATE markets_plan_txs, markets_plan_steps, markets_plans, markets_uploads, markets_notifications, markets_watch_state, markets_audit_outbox");
    const b = new EventBuilder();
    ctx.clock.set(new Date(b.now() * 1000));
    ctx.readModel = new MemoryReadModel({ chainId: ctx.config.chainId, questionTimeout: ctx.config.seer.questionTimeoutSeconds });
    ctx.readModel.markIndexed(0n, ctx.clock.unix());
    ctx.contentStore = new MemoryContentStore();
    ctx.audit = new MemoryAuditLog(ctx.redact);
    ctx.moderation = new FakeModeration();
    ctx.compliance = new FakeCompliance();
    ctx.quotas = new FakeQuotas();
    ctx.metrics = new MemoryMetrics();
    const chain = new ChainFake();
    chain.install(ctx);
    const session = freshSession();
    if (withDatabase) await insertTestUser(ctx.database, session);
    if (!harness) {
      const logLines: string[] = [];
      const routes: Harness["routes"] = [];
      const module = createMarketsModule();
      const app = await buildMarketsTestApp([module], ctx, logLines, routes);
      harness = {
        ctx,
        app,
        module,
        chain,
        b,
        session,
        headers: testSessionHeaders(session),
        logLines,
        routes,
        async user() {
          const next = freshSession();
          if (withDatabase) await insertTestUser(ctx.database, next);
          return { session: next, headers: testSessionHeaders(next) };
        },
        async apply(...events) {
          ctx.readModel.apply(events);
          await this.fresh();
        },
        async fresh() {
          const status = await ctx.readModel.status();
          ctx.readModel.markIndexed(status.indexedBlock, ctx.clock.unix());
        },
        at(seconds) {
          ctx.clock.set(new Date(seconds * 1000));
        },
      };
    } else {
      harness.chain = chain;
      harness.b = b;
      harness.session = session;
      harness.headers = testSessionHeaders(session);
      harness.logLines.length = 0;
    }
  });

  return () => {
    if (!harness) throw new Error("harness used outside a test");
    return harness;
  };
}

// ------------------------------------------------------------------------------------------------ fixtures

/** Registers a claim (ClaimCreated by the configured registry) and returns its read-model record. */
export async function addClaim(h: Harness, seed: string, overrides: Parameters<typeof claimCreated>[2] = {}): Promise<ClaimRecord> {
  const event = claimCreated(h.b, seed, overrides);
  await h.apply(event);
  const claim = await h.ctx.readModel.getClaim(event.market);
  if (!claim) throw new Error("claim not indexed");
  return claim;
}

export function exampleManifest(claim: ClaimRecord, submitter: Address, overrides: Partial<EvidenceManifest> = {}): EvidenceManifest {
  return {
    schema: "urn:pine:evidence-manifest:v1",
    submitter,
    claim: { chainId: 100, market: claim.market, claimDocumentSha256: claim.claimDocumentSha256, commit: claim.commit },
    title: "Reporter deposit draws from the gas reserve",
    violatedRequirement: "Each reporter-funding deposit's principal is allocated only from eligible funds.",
    summary: "A crash between two persisted steps makes the next run fund the deposit from the operator reserve.",
    expectedBehavior: "The deposit is funded from bridging funds only.",
    actualBehavior: "The deposit draws 3 xDAI from the operator gas reserve.",
    reproduction: { environment: "Node 24 on Linux", setup: "yarn install --immutable", command: "yarn test reporter-crash", initialState: "", notes: "" },
    artifacts: [],
    ...overrides,
  };
}

/** Stores a manifest directly in the content store (as if uploaded) and returns its digest. */
export async function storeManifest(h: Harness, manifest: EvidenceManifest): Promise<Hex32> {
  const { bytes, sha256 } = encodeEvidenceManifest(manifest);
  await h.ctx.contentStore.put({ bytes, declaredMediaType: "application/json", maxBytes: 262_144 });
  return sha256;
}

export function postJson(h: Harness, url: string, payload: unknown, options: { key?: string | null; headers?: Record<string, string> } = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...(options.headers ?? h.headers) };
  if (options.key !== null) headers["idempotency-key"] = options.key ?? `k-${randomUUID()}`;
  return h.app.inject({ method: "POST", url, headers, payload: payload as Record<string, unknown> });
}

/** Decodes a plan response exactly as a client would (planFromWire) and verifies it (verifyPlan). */
export function verifiedPlan(wire: WireTxPlan, claim: ClaimRecord | null, questionIds: Hex32[] = []): TxPlan {
  const plan = planFromWire(wire);
  const markets = new Map<Address, Address[]>();
  if (claim) markets.set(claim.market, [claim.yesToken, claim.noToken, claim.invalidToken]);
  const questions = new Set<Hex32>(claim ? [claim.questionId, ...questionIds] : questionIds);
  verifyPlan(plan, MANIFEST, { markets, questionIds: questions }, MARKETS_PLAN_LIMITS);
  return { ...plan, steps: plan.steps.map((step) => ({ ...step, args: step.args.map(lowerAddresses) })) };
}

/** Decoded calldata carries EIP-55 addresses; tests compare lowercase (other strings are left as they are). */
function lowerAddresses(value: unknown): unknown {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) return value.map(lowerAddresses);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, lowerAddresses(item)]));
  return value;
}

/** Every byte the test can observe outside the response: database dump, audit entries and log lines. */
export async function observableText(h: Harness): Promise<string> {
  const tables = ["markets_plans", "markets_plan_steps", "markets_plan_txs", "markets_uploads", "markets_notifications"];
  const dumps: string[] = [];
  for (const table of tables) dumps.push(JSON.stringify(await h.ctx.database.sql.query(`SELECT * FROM ${table}`)));
  return [...dumps, JSON.stringify(h.ctx.audit.entries), ...h.logLines].join("\n").toLowerCase();
}

export const answerHex = (value: bigint): Hex32 => `0x${value.toString(16).padStart(64, "0")}` as Hex32;

export type FormPart = { name: string; value: string } | { name: string; filename: string; contentType: string; data: Uint8Array };

/** A multipart/form-data body in the given part order. */
export function multipartBody(parts: FormPart[]): { payload: Buffer; contentType: string } {
  const boundary = `----pine${randomUUID().replace(/-/g, "")}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if ("value" in part) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`, "utf8"));
    } else {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType}\r\n\r\n`, "utf8"));
      chunks.push(Buffer.from(part.data));
      chunks.push(Buffer.from("\r\n", "utf8"));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export function upload(h: Harness, parts: FormPart[], headers: Record<string, string> = h.headers): Promise<LightMyRequestResponse> {
  const body = multipartBody(parts);
  return h.app.inject({ method: "POST", url: "/api/v1/evidence/artifacts", headers: { ...headers, "content-type": body.contentType }, payload: body.payload });
}

/**
 * Records (and blocks) every outbound network attempt of the process: global fetch, node:http/https request and get,
 * and raw socket connects (which undici and every HTTP client end in). The test app is driven by inject() and PGlite is
 * in-process, so a correct module makes no attempt at all. Call restore() when done.
 */
export function spyNetwork(): { attempts: string[]; restore(): void } {
  const attempts: string[] = [];
  const blocked = (kind: string) => (...args: unknown[]): never => {
    attempts.push(`${kind} ${String(args[0] instanceof URL ? args[0].href : typeof args[0] === "object" ? JSON.stringify(args[0]) : args[0])}`);
    throw new Error(`network access blocked in tests (${kind})`);
  };
  const spies = [
    vi.spyOn(globalThis, "fetch").mockImplementation(blocked("fetch")),
    vi.spyOn(http, "request").mockImplementation(blocked("http.request")),
    vi.spyOn(http, "get").mockImplementation(blocked("http.get")),
    vi.spyOn(https, "request").mockImplementation(blocked("https.request")),
    vi.spyOn(https, "get").mockImplementation(blocked("https.get")),
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(blocked("net.connect")),
  ];
  return {
    attempts,
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
