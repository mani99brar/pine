// FROZEN cross-lane test harness. Module lanes test against these fakes; the platform lane's real implementations
// must honour the same interface semantics (documented in app.ts). Never import this file from production code.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { createPublicClient, custom, type PublicClient } from "viem";
import { gnosis } from "viem/chains";
import { identify } from "@pine/shared/canonical";
import { MemoryReadModel } from "@pine/shared/testing/memory-read-model";
import type { Address, Hex32 } from "@pine/shared/types";
import type {
  AppContext,
  AuditEntry,
  AuditLog,
  ChainGateway,
  Clock,
  CommitMembership,
  CommitMembershipRef,
  ComplianceAction,
  ComplianceGateway,
  ContentStore,
  Database,
  GitHubCommit,
  GitHubGateway,
  GitHubPermission,
  GitHubPull,
  GitHubRepo,
  Metrics,
  ModerationGateway,
  ModerationState,
  ModerationSubject,
  QuotaGateway,
  QuotaName,
  RouteModule,
  SessionInfo,
  StoredContent,
} from "./app.js";
import { GitHubGatewayError } from "./app.js";
import type { AppConfig } from "./config.js";
import { ApiError, toErrorResponse } from "./errors.js";
import { loadMigrations, runMigrations, type SqlExecutor } from "./migrations.js";
import { createRedactor, redactDeep, type Redactor } from "./redact.js";

// ------------------------------------------------------------------------------------------------ database

export interface TestDatabase {
  db: Database;
  sql: SqlExecutor;
  client: PGlite;
  close(): Promise<void>;
}

function pgliteExecutor(client: PGlite | Transaction): SqlExecutor {
  return {
    async exec(sql) {
      await client.exec(sql);
    },
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const result = await client.query<T>(sql, params);
      return result.rows;
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      if ("transaction" in client && typeof client.transaction === "function") {
        return (client as PGlite).transaction(async (tx) => fn(pgliteExecutor(tx)));
      }
      return fn(pgliteExecutor(client));
    },
  };
}

/**
 * In-memory Postgres (PGlite) with every migration group applied, exactly as the migrate command applies them.
 * `applyMigrations: false` gives an empty database (for migration-runner tests).
 */
export async function createTestDatabase(options: { applyMigrations?: boolean } = {}): Promise<TestDatabase> {
  const client = new PGlite();
  const sql = pgliteExecutor(client);
  if (options.applyMigrations !== false) await runMigrations(sql, await loadMigrations());
  const db = drizzle(client) as unknown as Database;
  return { db, sql, client, close: () => client.close() };
}

// ------------------------------------------------------------------------------------------------ config

export const TEST_ADDRESSES = {
  claimRegistry: "0x00000000000000000000000000000000000c1a10",
  evidenceRegistry: "0x00000000000000000000000000000000000e01de",
} as const satisfies Record<string, Address>;

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    environment: "test",
    publicOrigin: "https://app.pine.test",
    apiOrigin: "https://api.pine.test",
    userContentOrigin: "https://usercontent.pine.test",
    chainId: 100,
    contracts: { claimRegistry: TEST_ADDRESSES.claimRegistry, evidenceRegistry: TEST_ADDRESSES.evidenceRegistry, deploymentBlock: 1_000n },
    seer: {
      marketFactory: "0x83183da839ce8228e31ae41222ead9edbb5cdcf1",
      realityProxy: "0xc260adfac11f97c001dc143d2a4f45b98e0f2d6c",
      gnosisRouter: "0xec9048b59b3467415b1a38f63416407ea0c70fb8",
      conditionalTokens: "0xceafdd6bc0bef976fdcd1112955828e00543c0ce",
      wrapped1155Factory: "0xd194319d1804c1051dd21ba1dc931ca72410b79f",
      collateralToken: "0xaf204776c7245bf4147c2612bf6e5972ee483701",
      realitio: "0xe78996a233895be74a66f451f1019ca9734205cc",
      arbitrator: "0x68154ea682f95bf582b80dd6453fa401737491dc",
      questionTimeoutSeconds: 302_400,
      klerosForeignProxy: "0xfe0eb5fc686f929eb26d541d75bb59f816c0aa68",
      klerosForeignChainId: 1,
    },
    amm: {
      factory: "0xa0864cca6e114013ab0e27cbd5b6f4c8947da766",
      positionManager: "0x91fd594c46d8b01e62dbdebed2401dde01817834",
      swapRouter: "0x0000000000000000000000000000000000005a9e",
      quoter: "0x0000000000000000000000000000000000000a07",
    },
    claims: {
      minEvidenceWindowSeconds: 72 * 3_600,
      maxEvidenceWindowSeconds: 90 * 86_400,
      defaultEvidenceWindowSeconds: 7 * 86_400,
      revealWindowSeconds: 48 * 3_600,
      defaultMinBondWei: 10n * 10n ** 18n,
      enabledPolicyFamilies: ["FUNC-001", "BOT-001"],
      allowDraftPolicies: true,
      questionCategory: "misc",
      questionLanguage: "en_US",
    },
    evidence: {
      maxUploadBytes: 25 * 1024 * 1024,
      allowedArtifactMediaTypes: ["application/json", "text/plain", "application/gzip", "application/zip", "application/x-tar", "image/png", "image/jpeg"],
    },
    indexerBackend: "native",
    maxIndexerLagSeconds: 900,
    ...overrides,
  };
}

// ------------------------------------------------------------------------------------------------ fakes

export class FakeClock implements Clock {
  constructor(private current: Date = new Date("2026-10-01T00:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(date: Date): void {
    this.current = new Date(date.getTime());
  }
  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
  /** Unix seconds of the current fake time. */
  unix(): number {
    return Math.floor(this.current.getTime() / 1000);
  }
}

export class MemoryContentStore implements ContentStore {
  readonly items = new Map<Hex32, { bytes: Uint8Array; record: StoredContent }>();
  async put(input: { bytes: Uint8Array; declaredMediaType: string; maxBytes: number }): Promise<StoredContent> {
    if (input.bytes.byteLength > input.maxBytes) throw new ApiError("PAYLOAD_TOO_LARGE", "Content exceeds the size limit");
    const id = identify(input.bytes);
    const existing = this.items.get(id.sha256);
    if (existing) return { ...existing.record };
    const record: StoredContent = { sha256: id.sha256, cid: id.cid, size: id.size, declaredMediaType: input.declaredMediaType };
    this.items.set(id.sha256, { bytes: new Uint8Array(input.bytes), record });
    return { ...record };
  }
  async get(sha256: Hex32): Promise<{ bytes: Uint8Array; record: StoredContent } | null> {
    const item = this.items.get(sha256.toLowerCase() as Hex32);
    return item ? { bytes: new Uint8Array(item.bytes), record: { ...item.record } } : null;
  }
  async has(sha256: Hex32): Promise<boolean> {
    return this.items.has(sha256.toLowerCase() as Hex32);
  }
}

/** Scriptable GitHub: register repos/pulls/commits per owner/name; users without a link get GITHUB_NOT_LINKED. */
export class FakeGitHubGateway implements GitHubGateway {
  readonly linkedUsers = new Set<string>();
  readonly repos = new Map<string, GitHubRepo & { visibility: "public" | "private"; viewerPermission: GitHubPermission }>();
  readonly pulls = new Map<string, GitHubPull[]>();
  readonly commits = new Map<string, GitHubCommit[]>();
  rateLimited = false;

  private key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }
  private guard(userId: string): void {
    if (!this.linkedUsers.has(userId)) throw new GitHubGatewayError("GITHUB_NOT_LINKED", "GitHub account is not connected");
    if (this.rateLimited) throw new GitHubGatewayError("RATE_LIMITED", "GitHub rate limit reached");
  }
  private repo(owner: string, name: string) {
    const repo = this.repos.get(this.key(owner, name));
    if (!repo) throw new GitHubGatewayError("NOT_FOUND", "Repository not found");
    if (repo.visibility !== "public") throw new GitHubGatewayError("REPO_NOT_PUBLIC", "Only public repositories are supported");
    return repo;
  }
  addRepo(repo: Omit<GitHubRepo, "private">, options: { visibility?: "public" | "private"; viewerPermission?: GitHubPermission } = {}): void {
    this.repos.set(this.key(repo.owner, repo.name), { ...repo, private: false, visibility: options.visibility ?? "public", viewerPermission: options.viewerPermission ?? "read" });
  }
  /** Commits reachable from each branch, for verifyCommitMembership(kind: "branch"). */
  readonly branchHistory = new Map<string, Set<string>>();
  addBranchCommit(owner: string, name: string, branch: string, sha: string): void {
    const key = `${this.key(owner, name)}#${branch}`;
    const set = this.branchHistory.get(key) ?? new Set<string>();
    set.add(sha.toLowerCase());
    this.branchHistory.set(key, set);
  }
  addPull(owner: string, name: string, pull: GitHubPull): void {
    const list = this.pulls.get(this.key(owner, name)) ?? [];
    list.push(pull);
    this.pulls.set(this.key(owner, name), list);
  }
  addCommit(owner: string, name: string, commit: GitHubCommit): void {
    const list = this.commits.get(this.key(owner, name)) ?? [];
    list.push(commit);
    this.commits.set(this.key(owner, name), list);
  }
  async listPublicRepos(userId: string, page: number) {
    this.guard(userId);
    const all = [...this.repos.values()].filter((repo) => repo.visibility === "public");
    const size = 30;
    const items = all.slice((page - 1) * size, page * size).map(({ visibility: _v, viewerPermission: _p, ...repo }) => repo);
    return { items, hasMore: all.length > page * size };
  }
  async getRepo(userId: string, owner: string, name: string) {
    this.guard(userId);
    const { visibility: _v, ...repo } = this.repo(owner, name);
    return repo;
  }
  async listPulls(userId: string, owner: string, name: string, state: "open" | "closed" | "all", page: number) {
    this.guard(userId);
    this.repo(owner, name);
    const all = (this.pulls.get(this.key(owner, name)) ?? []).filter((pull) => state === "all" || pull.state === state);
    const size = 30;
    return { items: all.slice((page - 1) * size, page * size), hasMore: all.length > page * size };
  }
  async getPull(userId: string, owner: string, name: string, number: number) {
    this.guard(userId);
    this.repo(owner, name);
    const pull = (this.pulls.get(this.key(owner, name)) ?? []).find((item) => item.number === number);
    if (!pull) throw new GitHubGatewayError("NOT_FOUND", "Pull request not found");
    return pull;
  }
  async getRepoById(userId: string, repoId: number) {
    this.guard(userId);
    const repo = [...this.repos.values()].find((item) => item.id === repoId);
    if (!repo) throw new GitHubGatewayError("NOT_FOUND", "Repository not found");
    if (repo.visibility !== "public") throw new GitHubGatewayError("REPO_NOT_PUBLIC", "Only public repositories are supported");
    const { visibility: _v, viewerPermission: _p, ...rest } = repo;
    return rest;
  }
  /** Commits listed for a PR, keyed "<owner>/<name>#<number>". */
  readonly pullCommits = new Map<string, GitHubCommit[]>();
  addPullCommit(owner: string, name: string, number: number, commit: GitHubCommit): void {
    const key = `${this.key(owner, name)}#${number}`;
    const list = this.pullCommits.get(key) ?? [];
    list.push(commit);
    this.pullCommits.set(key, list);
  }
  async listPullCommits(userId: string, owner: string, name: string, number: number) {
    this.guard(userId);
    this.repo(owner, name);
    return [...(this.pullCommits.get(`${this.key(owner, name)}#${number}`) ?? [])].slice(0, 250);
  }
  async getCommit(userId: string, owner: string, name: string, sha: string) {
    this.guard(userId);
    this.repo(owner, name);
    return (this.commits.get(this.key(owner, name)) ?? []).find((commit) => commit.sha === sha.toLowerCase()) ?? null;
  }
  async verifyCommitMembership(userId: string, owner: string, name: string, sha: string, ref: CommitMembershipRef): Promise<CommitMembership> {
    this.guard(userId);
    const repo = this.repo(owner, name);
    const target = sha.toLowerCase();
    const base = { repoId: repo.id, ref, verifiedAt: new Date("2026-10-01T00:00:00Z") };
    if (ref.kind === "pull") {
      const pull = (this.pulls.get(this.key(owner, name)) ?? []).find((item) => item.number === ref.number);
      if (!pull) throw new GitHubGatewayError("NOT_FOUND", "Pull request not found");
      if (pull.headSha === target) return { method: "pull_head", ...base };
      if ((this.pullCommits.get(`${this.key(owner, name)}#${ref.number}`) ?? []).some((commit) => commit.sha === target)) return { method: "pull_commit", ...base };
      throw new GitHubGatewayError("NOT_A_MEMBER", "Commit is not part of the pull request");
    }
    if (this.branchHistory.get(`${this.key(owner, name)}#${ref.name}`)?.has(target)) return { method: "branch_ancestor", ...base };
    throw new GitHubGatewayError("NOT_A_MEMBER", "Commit is not in the branch history");
  }
}

export class MemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];
  constructor(private readonly redact: Redactor = createRedactor()) {}
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push({ ...structuredClone(entry), details: redactDeep(entry.details, this.redact) as Record<string, unknown> });
  }
}

export class FakeModeration implements ModerationGateway {
  readonly items = new Map<string, ModerationState>();
  set(subject: ModerationSubject, id: string, action: ModerationState["action"], reason: string, at = new Date("2026-10-01T00:00:00Z")): void {
    this.items.set(`${subject}:${id.toLowerCase()}`, { action, reason, at });
  }
  async states(subject: ModerationSubject, ids: readonly string[]) {
    const result = new Map<string, ModerationState>();
    for (const id of ids) {
      const item = this.items.get(`${subject}:${id.toLowerCase()}`);
      if (item) result.set(id, { ...item });
    }
    return result;
  }
}

/** Compliance fake: everything allowed unless a wallet/action is listed as blocked or terms are not accepted. */
export class FakeCompliance implements ComplianceGateway {
  readonly blockedWallets = new Set<string>();
  readonly blockedActions = new Set<ComplianceAction>();
  readonly termsMissing = new Set<string>();
  readonly calls: { wallet: string; action: ComplianceAction }[] = [];
  async assertAllowed(_request: FastifyRequest, session: SessionInfo, action: ComplianceAction): Promise<void> {
    this.calls.push({ wallet: session.wallet, action });
    if (this.blockedWallets.has(session.wallet.toLowerCase()) || this.blockedActions.has(action)) {
      throw new ApiError("UNAVAILABLE_FOR_LEGAL_REASONS", "This action is not available");
    }
    if (this.termsMissing.has(session.userId)) throw new ApiError("TERMS_REQUIRED", "Accept the current terms and risk disclosure first");
  }
}

export class FakeQuotas implements QuotaGateway {
  readonly used = new Map<string, number>();
  constructor(readonly limits: Partial<Record<QuotaName, number>> = {}) {}
  async consume(userId: string, quota: QuotaName, amount = 1): Promise<void> {
    const key = `${userId}:${quota}`;
    const used = this.used.get(key) ?? 0;
    const limit = this.limits[quota] ?? Number.POSITIVE_INFINITY;
    if (used + amount > limit) throw new ApiError("QUOTA_EXCEEDED", `Quota ${quota} exceeded`, { retryAfterSeconds: 3_600 });
    this.used.set(key, used + amount);
  }
}

export class MemoryMetrics implements Metrics {
  readonly counters = new Map<string, number>();
  readonly observations: { name: string; seconds: number; labels: Record<string, string> }[] = [];
  increment(name: string, labels: Record<string, string> = {}): void {
    const key = `${name}${JSON.stringify(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }
  observe(name: string, seconds: number, labels: Record<string, string> = {}): void {
    this.observations.push({ name, seconds, labels });
  }
}

export type RpcHandler = (method: string, params: unknown) => Promise<unknown>;

/**
 * A viem PublicClient over a scripted transport. Unhandled methods throw, so tests notice any chain access they
 * did not script. Tests can also replace `handler` with one built from recorded mainnet responses.
 */
export function createScriptedChain(handler: RpcHandler = async (method) => {
  throw new Error(`Unscripted RPC call: ${method}`);
}): ChainGateway & { setHandler(next: RpcHandler): void } {
  let current = handler;
  const publicClient = createPublicClient({
    chain: gnosis,
    transport: custom({ request: async ({ method, params }: { method: string; params?: unknown }) => current(method, params) }),
  }) as unknown as PublicClient;
  return {
    chainId: 100,
    publicClient,
    setHandler(next: RpcHandler) {
      current = next;
    },
  };
}

// ------------------------------------------------------------------------------------------------ context

export interface TestContext extends AppContext {
  clock: FakeClock;
  readModel: MemoryReadModel;
  contentStore: MemoryContentStore;
  github: FakeGitHubGateway;
  audit: MemoryAuditLog;
  moderation: FakeModeration;
  compliance: FakeCompliance;
  quotas: FakeQuotas;
  metrics: MemoryMetrics;
  chain: ReturnType<typeof createScriptedChain>;
  database: TestDatabase;
  close(): Promise<void>;
}

export async function createTestContext(options: { config?: Partial<AppConfig>; quotas?: Partial<Record<QuotaName, number>> } = {}): Promise<TestContext> {
  const database = await createTestDatabase();
  const config = testConfig(options.config);
  const redact = createRedactor(["test-secret-value"]);
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
    quotas: new FakeQuotas(options.quotas),
    metrics: new MemoryMetrics(),
    close: () => database.close(),
  };
}

// ------------------------------------------------------------------------------------------------ app

export const TEST_SESSION_HEADER = "x-test-session";

/** Header value that authenticates a test request as `session` (only in the test app). */
export function testSessionHeaders(session: SessionInfo): Record<string, string> {
  return { [TEST_SESSION_HEADER]: Buffer.from(JSON.stringify(session), "utf8").toString("base64url") };
}

/** A session authenticated at the FakeClock's default time (2026-10-01T00:00:00Z). */
export function testSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-0000000000aa",
    wallet: "0x00000000000000000000000000000000000a11ce",
    githubUserId: 1001,
    githubLogin: "alice",
    isAdmin: false,
    authenticatedAt: new Date("2026-10-01T00:00:00Z"),
    idleExpiresAt: new Date("2026-10-02T00:00:00Z"),
    absoluteExpiresAt: new Date("2026-10-08T00:00:00Z"),
    ...overrides,
  };
}

function readTestSession(request: FastifyRequest): SessionInfo | null {
  const raw = request.headers[TEST_SESSION_HEADER];
  if (typeof raw !== "string") return null;
  const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
  return {
    ...(parsed as unknown as SessionInfo),
    authenticatedAt: new Date(String(parsed.authenticatedAt)),
    idleExpiresAt: new Date(String(parsed.idleExpiresAt)),
    absoluteExpiresAt: new Date(String(parsed.absoluteExpiresAt)),
  };
}

/** Admin step-up window: destructive admin actions need a signature at most this old (seconds). */
export const ADMIN_STEP_UP_SECONDS = 300;

/**
 * A Fastify instance with the same request contract the platform provides to modules: zod type provider,
 * `request.session`, `app.requireSession` / `app.requireAdmin`, and the shared error mapping. It does not
 * reproduce CSRF, rate limiting, CORS or security headers (platform concerns, tested by the platform lane).
 * Remember to insert a users row for session.userId when a module writes rows referencing users.
 */
export async function buildTestApp(modules: RouteModule[], ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest("session", null);
  app.addHook("onRequest", async (request) => {
    request.session = readTestSession(request);
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
  return app;
}

/** Inserts a users row (FK target for module tables) for a session's userId. */
export async function insertTestUser(database: TestDatabase, session: SessionInfo): Promise<void> {
  await database.sql.query("INSERT INTO users (id, wallet_address) VALUES ($1, $2) ON CONFLICT DO NOTHING", [session.userId, session.wallet.toLowerCase()]);
}
