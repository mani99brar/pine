// The whole backend of one e2e test file, composed like src/platform/core/server.ts startPlatform does it, with a fake
// clock and fake I/O at the edges only: the environment goes through the real loadConfig; core services, buildApp, every
// route module of src/modules.ts, the real gateways (buildGateways with an injected fake GitHub fetch and fake RPC
// transports), and the read model from src/readmodel.ts over the native index fed by the real applyEvents.
// Every response passes through `record`: every transaction plan in it is decoded with planFromWire and verified with
// verifyPlan, and every response and log line is kept for the secret-leak assertions.

import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { custom } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { buildDeploymentManifest, type DeploymentManifest } from "@pine/shared/deployment";
import { planFromWire, verifyPlan, type PlanContext, type TxPlan } from "@pine/shared/tx-plan";
import type { Address, Hex32 } from "@pine/shared/types";
import type { AppContext, JobDefinition } from "../../../src/contracts/app.js";
import type { AppConfig } from "../../../src/contracts/config.js";
import { loadMigrations, verifyMigrations } from "../../../src/contracts/migrations.js";
import type { Gateways, PlatformSecrets } from "../../../src/contracts/platform.js";
import type { Redactor } from "../../../src/contracts/redact.js";
import { FakeClock, MemoryMetrics, TEST_ADDRESSES } from "../../../src/contracts/testing.js";
import { routeModules } from "../../../src/modules.js";
import { buildApp } from "../../../src/platform/core/app.js";
import { cleanupJob } from "../../../src/platform/core/cleanup.js";
import { createPlatformRedactor, loadConfig, type ServerSettings } from "../../../src/platform/core/config.js";
import { createAppContext, createCoreServices } from "../../../src/platform/core/context.js";
import { SESSION_COOKIE } from "../../../src/platform/core/sessions.js";
import { buildGateways } from "../../../src/platform/gateways/index.js";
import { buildReadModel, type ClosableReadModel } from "../../../src/readmodel.js";
import { ChainSim, FakeRpc } from "./chain.js";
import { openE2eDatabase, type E2eDatabase } from "./database.js";
import { FakeGitHub } from "./github.js";

export const ORIGIN = "https://app.pine.test";
export const USER_CONTENT_ORIGIN = "https://pine-usercontent.test";
export const TERMS_DIGEST = `0x${"7e".repeat(32)}` as Hex32;
export const WAD = 10n ** 18n;
export const XDAI = WAD;

/** Plan limits of the verifying client: its own spending ceiling (10,000 xDAI) and approval sanity bound. */
export const CLIENT_PLAN_LIMITS = { maxTotalValueWei: 10_000n * XDAI, maxApprovalAmount: 10n ** 30n } as const;

export interface RecordedResponse {
  method: string;
  url: string;
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}

export interface VerifiedPlan {
  plan: TxPlan;
  totalValue: bigint;
  url: string;
}

export interface E2eOptions {
  /** Extra environment variables (override the defaults below). */
  env?: Record<string, string | undefined>;
  /** Wallets with admin rights (PINE_ADMIN_WALLETS). */
  adminWallets?: Address[];
  /** Wallets refused by compliance (PINE_BLOCKED_WALLETS). */
  blockedWallets?: Address[];
}

export interface E2e {
  db: E2eDatabase;
  app: FastifyInstance;
  ctx: AppContext;
  config: AppConfig;
  settings: ServerSettings;
  secrets: PlatformSecrets;
  redact: Redactor;
  manifest: DeploymentManifest;
  clock: FakeClock;
  rpc: FakeRpc;
  chain: ChainSim;
  github: FakeGitHub;
  gateways: Gateways;
  readModel: ClosableReadModel;
  jobs: Map<string, JobDefinition>;
  /** Every string the suite treats as a secret (configuration secrets, database URLs, GitHub tokens and codes). */
  secretStrings(): string[];
  /** Captured API, gateway and job log lines. */
  logs: string[];
  responses: RecordedResponse[];
  plans: VerifiedPlan[];
  /** The verifying client's registry lookup (markets and their outcome tokens, question ids). */
  planContext: { markets: Map<Address, readonly Address[]>; questionIds: Set<Hex32> };
  request(options: InjectOptions): Promise<LightMyRequestResponse>;
  runJob(name: string): Promise<void>;
  /** The user-content server listening on a loopback port; returns its base URL. */
  startContentServer(): Promise<string>;
  close(): Promise<void>;
}

const RPC_PRIMARY = "https://rpc-primary.example.org/v2/e2e-primary-api-key-0123456789abcdef";
const RPC_SECONDARY = "https://gnosis.rpc-secondary.example.net/e2e-secondary-api-key-fedcba9876543210";
const GITHUB_CLIENT_SECRET = "e2e-github-client-secret-0123456789abcdef";
const GITHUB_WEBHOOK_SECRET = "e2e-github-webhook-secret-0123456789abcdef";

/**
 * Every candidate transaction plan in a JSON body, found WITHOUT assuming it is well formed (a malformed plan must reach
 * planFromWire and fail there): every non-null value under a `plan` key, every object with `deploymentHash` and a
 * `planId` or `steps`, and every object with a `planId` and call-shaped `steps` (a step with `data`, `to` or `allowlistId`).
 * A bare `deploymentHash` (the manifest digest of /.well-known/pine.json) is not a plan.
 */
export function wirePlansIn(value: unknown, found: Set<unknown> = new Set()): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) wirePlansIn(item, found);
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const callShaped = Array.isArray(record.steps) && record.steps.some((step) => typeof step === "object" && step !== null && ("data" in step || "to" in step || "allowlistId" in step));
    const planLike = "deploymentHash" in record && ("planId" in record || "steps" in record);
    if (planLike || ("planId" in record && callShaped)) found.add(record);
    for (const [key, item] of Object.entries(record)) {
      if (key === "plan" && item !== null && item !== undefined) found.add(item);
      wirePlansIn(item, found);
    }
  }
  return [...found];
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function createE2e(options: E2eOptions = {}): Promise<E2e> {
  const db = await openE2eDatabase();
  const closers: (() => Promise<void>)[] = [() => db.close()];
  // The app's resources close best effort; the database's cleanup (drop) runs last and its failure is reported.
  const closeAll = async () => {
    const [closeDatabase, ...rest] = closers.splice(0);
    for (const close of rest.reverse()) await close().catch(() => undefined);
    await closeDatabase?.();
  };
  try {
    const tokenKey = randomBytes(32).toString("base64");
    const env: Record<string, string | undefined> = {
      PINE_ENVIRONMENT: "test",
      PINE_PUBLIC_ORIGIN: ORIGIN,
      PINE_USER_CONTENT_ORIGIN: USER_CONTENT_ORIGIN,
      PINE_CHAIN_ID: "100",
      PINE_CLAIM_REGISTRY: TEST_ADDRESSES.claimRegistry,
      PINE_EVIDENCE_REGISTRY: TEST_ADDRESSES.evidenceRegistry,
      PINE_DEPLOYMENT_BLOCK: "40000000",
      PINE_ALLOW_DRAFT_POLICIES: "true",
      PINE_ENABLED_POLICY_FAMILIES: "FUNC-001,BOT-001",
      PINE_INDEXER_BACKEND: "native",
      PINE_TRUST_PROXY_HOPS: "1",
      PINE_COMPLIANCE_COUNTRY_HEADER: "CF-IPCountry",
      PINE_BLOCKED_COUNTRIES_PUBLISH_CLAIM: "KP",
      PINE_BLOCKED_COUNTRIES_FUND_MARKET: "KP",
      PINE_BLOCKED_WALLETS: (options.blockedWallets ?? []).join(","),
      PINE_ADMIN_WALLETS: (options.adminWallets ?? []).join(","),
      PINE_TERMS_DIGEST: TERMS_DIGEST,
      PINE_IP_FLOOD_LIMIT_PER_MINUTE: "100000",
      PINE_USER_RATE_LIMIT_PER_MINUTE: "100000",
      PINE_LOG_LEVEL: "info",
      PINE_DATABASE_URL: db.apiUrl,
      PINE_RPC_URL_PRIMARY: RPC_PRIMARY,
      PINE_RPC_URL_SECONDARY: RPC_SECONDARY,
      PINE_GITHUB_KIND: "app",
      PINE_GITHUB_CLIENT_ID: "Iv1.e2epineclient0001",
      PINE_GITHUB_CLIENT_SECRET: GITHUB_CLIENT_SECRET,
      PINE_GITHUB_WEBHOOK_SECRET: GITHUB_WEBHOOK_SECRET,
      PINE_TOKEN_KEY_CURRENT: `k1:${tokenKey}`,
      PINE_READ_MODEL_DATABASE_URL: db.readModelUrl,
      ...options.env,
    };
    const { config, secrets, server: settings } = loadConfig(env);
    const redact = createPlatformRedactor(secrets, env);
    const manifest = buildDeploymentManifest(config.contracts, config.chainId);
    const clock = new FakeClock(new Date("2026-10-01T00:00:00.000Z"));
    const metrics = new MemoryMetrics();
    const logs: string[] = [];
    const rpc = new FakeRpc(manifest);
    const github = new FakeGitHub();

    // Startup checks of startPlatform: migrations verified over the runtime role.
    const files = await loadMigrations();
    await verifyMigrations(db.api.sql, files);
    const services = createCoreServices({ config, db: db.api.db, clock, redact, settings });
    const transport = custom({ request: async ({ method, params }: { method: string; params?: unknown }) => rpc.handle(method, params) });
    const gateways = await buildGateways(
      { config, secrets, db: db.api.db, clock, redact, metrics, moderation: services.moderation },
      { fetch: github.fetch, transports: { primary: transport, secondary: transport }, log: (line) => void logs.push(JSON.stringify(line)) },
    );
    closers.push(() => gateways.close());
    const readModel = await buildReadModel({ config, secrets, redact, clock }, db.readModelIo);
    closers.push(() => readModel.close());
    if (gateways.chain.chainId !== config.chainId || (await gateways.chain.publicClient.getChainId()) !== config.chainId) throw new Error("chain id mismatch");
    if ((await readModel.status()).chainId !== config.chainId) throw new Error("read model chain id mismatch");

    const ctx = createAppContext({ config, db: db.api.db, clock, redact, metrics, readModel, gateways, services, onAuditError: () => void logs.push("audit write failed") });
    const app = await buildApp({
      ctx,
      gateways,
      modules: routeModules,
      settings,
      readiness: { verifyMigrations: () => verifyMigrations(db.api.sql, files), verifiedAtStartup: true },
      logStream: { write: (line: string) => void logs.push(line) },
    });
    closers.push(() => app.close());

    const chain = new ChainSim(db.indexer, clock, rpc, { chainId: config.chainId, questionTimeout: config.seer.questionTimeoutSeconds });
    const jobs = new Map<string, JobDefinition>([...gateways.jobs, cleanupJob, ...routeModules.flatMap((module) => module.jobs ?? [])].map((job) => [job.name, job]));
    const responses: RecordedResponse[] = [];
    const plans: VerifiedPlan[] = [];
    const planContext = { markets: new Map<Address, readonly Address[]>(), questionIds: new Set<Hex32>() };

    const e2e: E2e = {
      db,
      app,
      ctx,
      config,
      settings,
      secrets,
      redact,
      manifest,
      clock,
      rpc,
      chain,
      github,
      gateways,
      readModel,
      jobs,
      logs,
      responses,
      plans,
      planContext,
      secretStrings: () => [
        RPC_PRIMARY,
        RPC_SECONDARY,
        "e2e-primary-api-key-0123456789abcdef",
        "e2e-secondary-api-key-fedcba9876543210",
        GITHUB_CLIENT_SECRET,
        GITHUB_WEBHOOK_SECRET,
        tokenKey,
        Buffer.from(tokenKey, "base64").toString("hex"),
        String(env.PINE_DATABASE_URL),
        ...db.secrets,
        ...github.secrets,
      ],
      async request(injectOptions) {
        const response = await app.inject(injectOptions);
        const url = typeof injectOptions.url === "string" ? injectOptions.url : "";
        responses.push({ method: String(injectOptions.method ?? "GET"), url, statusCode: response.statusCode, headers: { ...response.headers }, body: response.body });
        const type = String(response.headers["content-type"] ?? "");
        if (type.includes("application/json") && response.body.length > 0) {
          for (const wire of wirePlansIn(JSON.parse(response.body) as unknown)) {
            // The client's own copy of @pine/shared: decode from calldata, then verify against its own lookup.
            const plan = planFromWire(wire);
            const context: PlanContext = { markets: planContext.markets, questionIds: planContext.questionIds };
            const totalValue = verifyPlan(plan, manifest, context, CLIENT_PLAN_LIMITS);
            plans.push({ plan, totalValue, url });
          }
        }
        return response;
      },
      async runJob(name) {
        const job = jobs.get(name);
        if (!job) throw new Error(`unknown job ${name}`);
        await job.run(ctx, new AbortController().signal);
      },
      async startContentServer() {
        const port = await freePort();
        const server = gateways.createContentServer();
        await server.listen({ host: "127.0.0.1", port });
        closers.push(() => server.close());
        return `http://127.0.0.1:${port}`;
      },
      close: closeAll,
    };
    return e2e;
  } catch (error) {
    const cleanupError = await closeAll().then(
      () => null,
      (failure: unknown) => failure,
    );
    if (cleanupError !== null) throw new AggregateError([error, cleanupError], "e2e setup failed, and so did its cleanup", { cause: error });
    throw error;
  }
}

// ------------------------------------------------------------------------------------------------ browser

export function cookieFrom(setCookie: unknown, name: string): string | null {
  const list = Array.isArray(setCookie) ? setCookie : typeof setCookie === "string" ? [setCookie] : [];
  for (const line of list as string[]) {
    const [pair] = line.split(";");
    const index = pair?.indexOf("=") ?? -1;
    if (pair && index > 0 && pair.slice(0, index) === name) return pair.slice(index + 1);
  }
  return null;
}

/** A same-origin browser session: cookies, and the CSRF headers the web app sends on unsafe methods. */
export class Browser {
  session: string | null = null;
  presession: string | null = null;
  userId: string | null = null;

  constructor(
    readonly e2e: E2e,
    readonly account: PrivateKeyAccount,
  ) {}

  get wallet(): Address {
    return this.account.address.toLowerCase() as Address;
  }

  cookieHeader(): string {
    return [this.session ? `${SESSION_COOKIE}=${this.session}` : null, this.presession ? `__Host-pine_presession=${this.presession}` : null].filter((item) => item !== null).join("; ");
  }

  async send(
    method: "GET" | "HEAD" | "POST" | "PUT" | "DELETE",
    url: string,
    options: { body?: unknown; raw?: { payload: Buffer; contentType: string }; headers?: Record<string, string>; csrf?: boolean; cookies?: boolean } = {},
  ): Promise<LightMyRequestResponse> {
    const unsafe = method !== "GET" && method !== "HEAD";
    const headers: Record<string, string> = {};
    if (options.cookies !== false) {
      const cookie = this.cookieHeader();
      if (cookie) headers.cookie = cookie;
    }
    if (unsafe && options.csrf !== false) Object.assign(headers, { origin: ORIGIN, "sec-fetch-site": "same-origin", "x-pine-csrf": "1" });
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.raw !== undefined) headers["content-type"] = options.raw.contentType;
    Object.assign(headers, options.headers);
    const payload = options.raw !== undefined ? { payload: options.raw.payload } : options.body !== undefined ? { payload: JSON.stringify(options.body) } : {};
    const response = await this.e2e.request({ method, url, headers, ...payload });
    const rotated = cookieFrom(response.headers["set-cookie"], SESSION_COOKIE);
    if (rotated !== null) this.session = rotated === "" ? null : rotated;
    return response;
  }

  /** SIWE (EIP-4361) sign-in with the EOA's own signature; accepts the current terms digest. */
  async signIn(): Promise<void> {
    const challenge = await this.send("POST", "/api/v1/auth/siwe/challenge", { body: { address: this.account.address } });
    if (challenge.statusCode !== 200) throw new Error(`challenge failed: ${challenge.statusCode} ${challenge.body}`);
    this.presession = cookieFrom(challenge.headers["set-cookie"], "__Host-pine_presession");
    const { message } = challenge.json<{ message: string }>();
    const signature = await this.account.signMessage({ message });
    const verify = await this.send("POST", "/api/v1/auth/siwe/verify", { body: { message, signature } });
    if (verify.statusCode !== 200) throw new Error(`verify failed: ${verify.statusCode} ${verify.body}`);
    this.presession = null;
    const rows = await this.e2e.db.api.sql.query<{ id: string }>("SELECT id::text AS id FROM users WHERE wallet_address = $1", [this.wallet]);
    this.userId = rows[0]?.id ?? null;
  }
}

/** A multipart/form-data body with optional text fields and one file part (the evidence artifact upload). */
export function multipart(fields: Record<string, string>, file: { bytes: Uint8Array; mediaType: string; name: string }): { payload: Buffer; contentType: string } {
  const boundary = `----pine-e2e-${randomBytes(8).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mediaType}\r\n\r\n`));
  parts.push(Buffer.from(file.bytes));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
