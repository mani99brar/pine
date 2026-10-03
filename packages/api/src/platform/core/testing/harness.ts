// Test-only harness for platform-core (never imported by production code). Builds the real buildApp over PGlite with
// the real core services and fakes of the gateways side (the gateways lane's tables are never touched).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { MemoryReadModel } from "@pine/shared/testing/memory-read-model";
import type { Address, Hex32 } from "@pine/shared/types";
import type { AppContext, RouteModule, SessionInfo } from "../../../contracts/app.js";
import type { AppConfig } from "../../../contracts/config.js";
import { ApiError } from "../../../contracts/errors.js";
import { loadMigrations, verifyMigrations } from "../../../contracts/migrations.js";
import type { GitHubAuthFlow, GitHubIdentity } from "../../../contracts/platform.js";
import { createRedactor } from "../../../contracts/redact.js";
import {
  createScriptedChain,
  createTestDatabase,
  FakeClock,
  FakeGitHubGateway,
  MemoryContentStore,
  MemoryMetrics,
  testConfig,
  type TestDatabase,
} from "../../../contracts/testing.js";
import { buildApp, type BuildAppOptions } from "../app.js";
import { DEFAULT_QUOTA_LIMITS, type ServerSettings } from "../config.js";
import { createAppContext, createCoreServices, type CoreServices } from "../context.js";
import { SESSION_COOKIE } from "../sessions.js";
import { acquireDirLock, releaseDirLock } from "./dir-lock.js";

export const TEST_TERMS_DIGEST = `0x${"7e".repeat(32)}` as Hex32;
export const TEST_SECRET = "super-secret-database-password-42";
export const WEBHOOK_SECRET = "webhook-secret-for-tests-0123456789";

export function testSettings(overrides: Partial<ServerSettings> = {}): ServerSettings {
  const empty = () => new Set<string>();
  return {
    host: "127.0.0.1",
    port: 0,
    metricsHost: "127.0.0.1",
    metricsPort: 0,
    userContentHost: "127.0.0.1",
    userContentPort: 0,
    trustProxyHops: 0,
    ipFloodLimitPerMinute: 10_000,
    userRateLimitPerMinute: 1_000,
    adminWallets: new Set<string>(),
    termsDigest: TEST_TERMS_DIGEST,
    compliance: {
      countryHeader: null,
      blockedCountries: { publish_claim: empty(), fund_market: empty(), submit_evidence: empty(), answer_oracle: empty(), redeem: empty() },
      countryRequiredActions: new Set(["publish_claim", "fund_market"]),
    },
    sanctions: { mode: "off", blockedWallets: new Set<string>() },
    quotas: {
      claim_drafts_per_day: { limit: DEFAULT_QUOTA_LIMITS.claim_drafts_per_day, windowSeconds: 86_400 },
      publications_per_day: { limit: DEFAULT_QUOTA_LIMITS.publications_per_day, windowSeconds: 86_400 },
      plans_per_day: { limit: DEFAULT_QUOTA_LIMITS.plans_per_day, windowSeconds: 86_400 },
      evidence_uploads_per_day: { limit: DEFAULT_QUOTA_LIMITS.evidence_uploads_per_day, windowSeconds: 86_400 },
      evidence_bytes_per_day: { limit: DEFAULT_QUOTA_LIMITS.evidence_bytes_per_day, windowSeconds: 86_400 },
      github_calls_per_hour: { limit: DEFAULT_QUOTA_LIMITS.github_calls_per_hour, windowSeconds: 3_600 },
    },
    logLevel: "info",
    databasePoolMax: 1,
    ...overrides,
  };
}

/** Scriptable GitHubAuthFlow with the frozen semantics (state single-use, bound to the session, 10 minutes). */
export class FakeGitHubAuth implements GitHubAuthFlow {
  readonly identities = new Map<string, GitHubIdentity>();
  readonly states = new Map<string, { sessionId: string; userId: string; expiresAt: number }>();
  readonly webhookBodies: Buffer[] = [];
  readonly calls: string[] = [];
  /** Identity GitHub returns for a code. */
  readonly codes = new Map<string, GitHubIdentity>();
  completeError: Error | null = null;
  webhookError: Error | null = null;
  constructor(private readonly clock: { now(): Date }) {}

  async start(session: SessionInfo) {
    this.calls.push("start");
    const state = randomBytes(16).toString("hex");
    this.states.set(state, { sessionId: session.sessionId, userId: session.userId, expiresAt: this.clock.now().getTime() + 600_000 });
    return { authorizationUrl: `https://github.com/login/oauth/authorize?client_id=Iv1.test&state=${state}&code_challenge=x&code_challenge_method=S256` };
  }
  async complete(session: SessionInfo, input: { code: string; state: string }): Promise<GitHubIdentity> {
    this.calls.push("complete");
    const stored = this.states.get(input.state);
    this.states.delete(input.state);
    if (!stored || stored.sessionId !== session.sessionId || stored.expiresAt <= this.clock.now().getTime()) throw new ApiError("BAD_REQUEST", "Invalid or expired state");
    if (this.completeError) throw this.completeError;
    const identity = this.codes.get(input.code);
    if (!identity) throw new ApiError("BAD_REQUEST", "Invalid code");
    for (const [userId, existing] of this.identities) {
      if (existing.githubUserId === identity.githubUserId && userId !== session.userId) throw new ApiError("CONFLICT", "GitHub account linked to another wallet");
    }
    this.identities.set(session.userId, identity);
    return identity;
  }
  async unlink(userId: string): Promise<void> {
    this.calls.push("unlink");
    this.identities.delete(userId);
  }
  async identityOf(userId: string): Promise<GitHubIdentity | null> {
    this.calls.push("identityOf");
    return this.identities.get(userId) ?? null;
  }
  async handleWebhook(rawBody: Buffer, signatureHeader: string | undefined): Promise<void> {
    this.webhookBodies.push(Buffer.from(rawBody));
    const expected = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex")}`;
    if (signatureHeader === undefined || signatureHeader.length !== expected.length || !timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected))) {
      throw new ApiError("UNAUTHENTICATED", "Invalid signature");
    }
    if (this.webhookError) throw this.webhookError;
  }
}

export function signWebhook(body: Buffer | string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

export interface CoreHarness {
  app: FastifyInstance;
  ctx: AppContext;
  clock: FakeClock;
  database: TestDatabase;
  services: CoreServices;
  githubAuth: FakeGitHubAuth;
  github: FakeGitHubGateway;
  readModel: MemoryReadModel;
  metrics: MemoryMetrics;
  settings: ServerSettings;
  logs: string[];
  close(): Promise<void>;
}

export async function createHarness(
  options: {
    config?: Partial<AppConfig>;
    settings?: Partial<ServerSettings>;
    modules?: RouteModule[];
    readiness?: BuildAppOptions["readiness"];
    database?: TestDatabase;
  } = {},
): Promise<CoreHarness> {
  const ownsDatabase = options.database === undefined;
  const database = options.database ?? (await lockedTestDatabase());
  const config = testConfig(options.config);
  const clock = new FakeClock();
  const redact = createRedactor([TEST_SECRET, WEBHOOK_SECRET]);
  const settings = testSettings(options.settings);
  const services = createCoreServices({ config, db: database.db, clock, redact, settings });
  const githubAuth = new FakeGitHubAuth(clock);
  const github = new FakeGitHubGateway();
  const readModel = new MemoryReadModel({ chainId: config.chainId, questionTimeout: config.seer.questionTimeoutSeconds });
  readModel.markIndexed(1n, clock.unix());
  const metrics = new MemoryMetrics();
  const ctx = createAppContext({
    config,
    db: database.db,
    clock,
    redact,
    metrics,
    readModel,
    gateways: { github, githubAuth, contentStore: new MemoryContentStore(), chain: createScriptedChain() },
    services,
  });
  const logs: string[] = [];
  const files = await loadMigrations();
  const app = await buildApp({
    ctx,
    gateways: { githubAuth },
    modules: options.modules ?? [],
    settings,
    readiness: options.readiness ?? { verifyMigrations: () => verifyMigrations(database.sql, files) },
    logStream: { write: (line: string) => void logs.push(line) },
  });
  return {
    app,
    ctx,
    clock,
    database,
    services,
    githubAuth,
    github,
    readModel,
    metrics,
    settings,
    logs,
    close: async () => {
      await app.close();
      if (ownsDatabase) await database.close();
    },
  };
}

const PLATFORM_TABLES = [
  "users",
  "sessions",
  "siwe_presessions",
  "siwe_nonces",
  "terms_acceptances",
  "rate_limit_windows",
  "quota_usage",
  "audit_log",
  "moderation_states",
  "job_leases",
];

/** One PGlite per test file (memory): empties the platform tables between tests. */
export async function resetDatabase(database: TestDatabase): Promise<void> {
  await database.sql.exec("RESET ROLE");
  await database.sql.exec(`TRUNCATE ${PLATFORM_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

// One PGlite instance needs ~0.7 GB resident and ~1.1 GB while initialising. Vitest runs test files in parallel
// worker processes, so DB-backed files take a cross-process lock for their whole lifetime: at most one PGlite exists at
// a time across the run (DB-free tests still run in parallel). A lock whose holder process is gone is taken over.
const LOCK_DIR = path.join(tmpdir(), "pine-platform-core-pglite.lock");
const LOCK_WAIT_MS = 25 * 60_000;

async function acquireDatabaseLock(): Promise<void> {
  await acquireDirLock(LOCK_DIR, { timeoutMs: LOCK_WAIT_MS, pollMs: 100, ownPid: "throw", name: "PGlite test database" });
}

function releaseDatabaseLock(): void {
  releaseDirLock(LOCK_DIR);
}

/** Creates a PGlite test database (frozen harness) while holding the cross-process lock. */
export async function lockedTestDatabase(options: { applyMigrations?: boolean } = {}): Promise<TestDatabase> {
  await acquireDatabaseLock();
  try {
    const database = await createTestDatabase(options);
    return {
      ...database,
      close: async () => {
        try {
          await database.close();
        } finally {
          releaseDatabaseLock();
        }
      },
    };
  } catch (error) {
    releaseDatabaseLock();
    throw error;
  }
}

/** Shared-database lifecycle for a test file (one PGlite per file, emptied before every test). */
export function useSharedDatabase(hooks: {
  beforeAll(fn: () => Promise<void>, timeout?: number): void;
  afterAll(fn: () => Promise<void>, timeout?: number): void;
  beforeEach(fn: () => Promise<void>): void;
}): () => TestDatabase {
  let database: TestDatabase | null = null;
  hooks.beforeAll(async () => {
    database = await lockedTestDatabase();
  }, LOCK_WAIT_MS + 120_000);
  hooks.afterAll(async () => {
    await database?.close();
  }, 60_000);
  hooks.beforeEach(async () => {
    if (database) await resetDatabase(database);
  });
  return () => {
    if (!database) throw new Error("shared database not ready");
    return database;
  };
}

export const ORIGIN = "https://app.pine.test";

/** Headers that pass CSRF for a request without a body. */
export function bodylessCsrfHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { origin: ORIGIN, "x-pine-csrf": "1", "sec-fetch-site": "same-origin", ...extra };
}

/** Headers that pass CSRF for a JSON request. */
export function csrfHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { origin: ORIGIN, "x-pine-csrf": "1", "content-type": "application/json", "sec-fetch-site": "same-origin", ...extra };
}

export function testAccount(seed: number): PrivateKeyAccount {
  return privateKeyToAccount(`0x${seed.toString(16).padStart(64, "0")}` as `0x${string}`);
}

export function cookieValue(setCookie: string | string[] | undefined, name: string): string | null {
  const list = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  for (const line of list) {
    const [pair] = line.split(";");
    const index = pair?.indexOf("=") ?? -1;
    if (pair && index > 0 && pair.slice(0, index) === name) return pair.slice(index + 1);
  }
  return null;
}

export interface SignedIn {
  cookie: string;
  token: string;
  address: Address;
  userId: string;
}

/** Full SIWE flow through the HTTP API; returns the session cookie header. */
export async function signIn(h: Pick<CoreHarness, "app" | "database">, account: PrivateKeyAccount, headers: Record<string, string> = {}): Promise<SignedIn> {
  const { app } = h;
  const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/siwe/challenge", headers: csrfHeaders(headers), payload: { address: account.address } });
  if (challenge.statusCode !== 200) throw new Error(`challenge failed: ${challenge.statusCode} ${challenge.body}`);
  const presession = cookieValue(challenge.headers["set-cookie"], "__Host-pine_presession");
  const { message } = challenge.json<{ message: string }>();
  const signature = await account.signMessage({ message });
  const verify = await app.inject({
    method: "POST",
    url: "/api/v1/auth/siwe/verify",
    headers: csrfHeaders({ ...headers, cookie: `__Host-pine_presession=${presession ?? ""}` }),
    payload: { message, signature },
  });
  if (verify.statusCode !== 200) throw new Error(`verify failed: ${verify.statusCode} ${verify.body}`);
  const token = cookieValue(verify.headers["set-cookie"], SESSION_COOKIE);
  if (!token) throw new Error("no session cookie");
  const address = account.address.toLowerCase() as Address;
  const rows = await h.database.sql.query<{ id: string }>("SELECT id::text AS id FROM users WHERE wallet_address = $1", [address]);
  return { cookie: `${SESSION_COOKIE}=${token}`, token, address, userId: rows[0]?.id ?? "" };
}
