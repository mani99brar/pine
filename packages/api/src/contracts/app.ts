// FROZEN cross-lane contract between the `platform` lane (owns src/platform/**) and the route-module lanes
// (`claims` owns src/modules/claims/**, `markets` owns src/modules/markets/**).
//
// The platform builds the Fastify instance, authenticates requests, enforces CSRF/rate limits/security headers/
// compliance, verifies migrations, runs jobs, and passes an AppContext to every RouteModule. Modules never construct
// infrastructure themselves; they receive it here. Tests build the same shapes with src/contracts/testing.ts.
// Security requirement ids (SEC-*) refer to docs/security/requirements.md.

import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { PublicClient } from "viem";
import type { ReadModel } from "@pine/shared/read-model";
import type { Address, Hex32 } from "@pine/shared/types";
import type { AppConfig } from "./config.js";
import type { Redactor } from "./redact.js";

/** Drizzle database handle. Production: node-postgres (runtime role: data read/write only); tests: PGlite. */
export type Database = PgDatabase<PgQueryResultHKT>;

export interface Clock {
  now(): Date;
}

/**
 * Authenticated session attached to a request by the platform. Never contains the session token itself.
 * Sessions are created only by a SIWE login from an EOA (SEC-AUTH-05); smart-contract wallets cannot log in in v1.
 */
export interface SessionInfo {
  /** Internal session row id (not the cookie value). */
  sessionId: string;
  /** users.id (uuid). */
  userId: string;
  /** Wallet that signed the SIWE message, lowercase. */
  wallet: Address;
  /** Linked GitHub numeric user id (stable identity), or null when GitHub is not connected (SEC-GH-05). */
  githubUserId: number | null;
  /** Display snapshot of the linked GitHub login (mutable on GitHub; never used as identity). */
  githubLogin: string | null;
  /** Re-evaluated from configuration on every request, never stored in the session (SEC-AUTH-21). */
  isAdmin: boolean;
  /** When the wallet signature that created this session was verified. */
  authenticatedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the platform's authentication hook on every request; null when unauthenticated. */
    session: SessionInfo | null;
  }
  interface FastifyInstance {
    /** preHandler: 401 UNAUTHENTICATED unless request.session is set. */
    requireSession: preHandlerAsyncHookHandler;
    /**
     * preHandler: 401 without a session, 403 FORBIDDEN unless session.isAdmin, 401 STEP_UP_REQUIRED unless the session
     * was authenticated within the last 5 minutes (destructive admin actions need a fresh signature).
     */
    requireAdmin: preHandlerAsyncHookHandler;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Infrastructure gateways (implemented by the platform lane; faked in src/contracts/testing.ts)
// ---------------------------------------------------------------------------------------------------------------

export interface StoredContent {
  /** SHA-256 of the exact bytes, 0x-prefixed lowercase hex. The identity of the content (media type is not part of it). */
  sha256: Hex32;
  size: number;
  /** CIDv1 (raw codec, sha2-256) of the bytes; every stored object is a single raw block (<= 256 KiB, SEC-EVID-04). */
  cid: string;
  /** Media type declared by the first uploader. Informational only: never used as the served Content-Type. */
  declaredMediaType: string;
}

/**
 * Content-addressed, immutable blob storage (local disk or object storage, plus an IPFS pinning service for content
 * with a CID). put() is idempotent: storing the same bytes twice returns the same record and never duplicates. The
 * store never interprets, renders, decompresses or executes content. Blocked content (ModerationGateway) is never
 * returned by get(); serving routes return 451 for it.
 */
export interface ContentStore {
  /**
   * Rejects with ApiError PAYLOAD_TOO_LARGE when bytes.length > maxBytes or > RAW_CID_MAX_BYTES (262144). Stores
   * locally first (the source of truth for serving), then pins by CID; a pinning-service CID that differs from the
   * locally computed one is an integrity failure.
   */
  put(input: { bytes: Uint8Array; declaredMediaType: string; maxBytes: number }): Promise<StoredContent>;
  /** Local store only. Null when absent or blocked. */
  get(sha256: Hex32): Promise<{ bytes: Uint8Array; record: StoredContent } | null>;
  has(sha256: Hex32): Promise<boolean>;
  /**
   * Local store first, then the configured trusted IPFS gateways by the raw CID derived from the digest (redirects
   * off, response capped at maxBytes, digest verified); a verified remote copy is stored locally. Null when no source
   * has it or it is blocked. Never fetches any other URL (SEC-EVID-09).
   */
  retrieve(sha256: Hex32, maxBytes: number): Promise<Uint8Array | null>;
}

export type GitHubPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export interface GitHubRepo {
  /** Stable numeric repository id (survives renames and transfers; identity for claims, SEC-GH-12). */
  id: number;
  owner: string;
  /** Numeric id of the owning user or organisation. */
  ownerId: number;
  name: string;
  fullName: string;
  /** Always false: the gateway refuses private and internal repositories with REPO_NOT_PUBLIC. */
  private: false;
  fork: boolean;
  defaultBranch: string;
  htmlUrl: string;
  pushedAt: string | null;
}

export interface GitHubPull {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  headRef: string;
  /** Repository id of the head (a fork for cross-repository PRs). */
  headRepoId: number | null;
  baseSha: string;
  baseRef: string;
  htmlUrl: string;
  authorLogin: string | null;
  updatedAt: string;
}

export interface GitHubCommit {
  /** Full 40-hex SHA-1 object id, lowercase. */
  sha: string;
  parents: string[];
  message: string;
  authorLogin: string | null;
  committedAt: string | null;
  htmlUrl: string;
}

/**
 * Proof that a commit belongs to a repository's history or to one of its pull requests. GitHub serves objects of the
 * whole fork network through any repository in it, so getCommit() succeeding proves NOTHING about membership
 * (SEC-GH-11); only this method does.
 */
export type CommitMembershipRef = { kind: "pull"; number: number } | { kind: "branch"; name: string };

export interface CommitMembership {
  /** pull_head: the PR's current head; pull_commit: listed in the PR's commits; branch_ancestor: compare shows the commit in the branch history. */
  method: "pull_head" | "pull_commit" | "branch_ancestor";
  repoId: number;
  ref: CommitMembershipRef;
  verifiedAt: Date;
}

export type GitHubErrorCode = "GITHUB_NOT_LINKED" | "REPO_NOT_PUBLIC" | "NOT_FOUND" | "NOT_A_MEMBER" | "RATE_LIMITED" | "UPSTREAM";

export class GitHubGatewayError extends Error {
  readonly code: GitHubErrorCode;
  constructor(code: GitHubErrorCode, message: string) {
    super(message);
    this.name = "GitHubGatewayError";
    this.code = code;
  }
}

/**
 * Read-only GitHub access on behalf of a user, using the user's linked token (never exposed to modules).
 * Public repositories only. Every method throws GitHubGatewayError for the listed failure classes.
 */
export interface GitHubGateway {
  /** Public repositories owned by the linked user (and listed public org repos when available). */
  listPublicRepos(userId: string, page: number): Promise<{ items: GitHubRepo[]; hasMore: boolean }>;
  getRepo(userId: string, owner: string, name: string): Promise<GitHubRepo & { viewerPermission: GitHubPermission }>;
  /** Resolves a repository by its stable numeric id (detects renames/transfers/repo-jacking, SEC-GH-12). */
  getRepoById(userId: string, repoId: number): Promise<GitHubRepo>;
  listPulls(userId: string, owner: string, name: string, state: "open" | "closed" | "all", page: number): Promise<{ items: GitHubPull[]; hasMore: boolean }>;
  getPull(userId: string, owner: string, name: string, number: number): Promise<GitHubPull>;
  /** At most 250 commits (GitHub's limit for this endpoint), oldest first. */
  listPullCommits(userId: string, owner: string, name: string, number: number): Promise<GitHubCommit[]>;
  /** Object lookup only (see CommitMembership); null when GitHub has no such object for that repository network. */
  getCommit(userId: string, owner: string, name: string, sha: string): Promise<GitHubCommit | null>;
  /** Throws NOT_A_MEMBER when the commit is not the PR head, not in the PR's commits, or not in the branch history. */
  verifyCommitMembership(userId: string, owner: string, name: string, sha: string, ref: CommitMembershipRef): Promise<CommitMembership>;
}

export interface AuditEntry {
  actorUserId: string | null;
  /** Dotted action name, e.g. "claim.publication.created", "moderation.blocked", "auth.siwe.failed". */
  action: string;
  subjectType: string;
  subjectId: string;
  /** Small JSON object. The audit log redacts every string and caps the size itself (SEC-OPS-07). */
  details: Record<string, unknown>;
  /** Request IP as seen by the platform (trusted-proxy aware); retained per the documented retention policy. */
  ip: string | null;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

export type ModerationSubject = "claim" | "evidence" | "content" | "wallet" | "repository";

export interface ModerationState {
  /** hide: excluded from listings/feeds, still retrievable by exact id with the reason. block: content bytes are never served (451). */
  action: "hide" | "block";
  reason: string;
  at: Date;
}

/**
 * Moderation never alters on-chain data or immutable documents (SEC-OPS-06). "content" subjects are content sha256
 * values; "claim" subjects are market addresses; "evidence" subjects are "<registry>:<submissionId>".
 */
export interface ModerationGateway {
  /** Returns the subset of ids with an active moderation state. Ids are compared case-insensitively. */
  states(subject: ModerationSubject, ids: readonly string[]): Promise<Map<string, ModerationState>>;
}

export type ComplianceAction = "publish_claim" | "fund_market" | "submit_evidence" | "answer_oracle" | "redeem";

/**
 * Compliance hooks (SEC-LEGAL-01..03). Modules MUST call assertAllowed before returning any transaction plan for the
 * action. It fails closed: ApiError UNAVAILABLE_FOR_LEGAL_REASONS for a blocked region or screened wallet,
 * TERMS_REQUIRED when the user has not accepted the current terms/risk disclosure version for the action.
 */
export interface ComplianceGateway {
  assertAllowed(request: FastifyRequest, session: SessionInfo, action: ComplianceAction): Promise<void>;
}

export type QuotaName =
  | "claim_drafts_per_day"
  | "publications_per_day"
  | "plans_per_day"
  | "evidence_uploads_per_day"
  | "evidence_bytes_per_day"
  | "github_calls_per_hour";

export interface QuotaGateway {
  /**
   * Atomically consumes `amount` units of the named per-user quota (fixed window). Throws ApiError QUOTA_EXCEEDED
   * (with retryAfterSeconds) when the limit would be exceeded; consumes nothing in that case.
   */
  consume(userId: string, quota: QuotaName, amount?: number): Promise<void>;
}

export interface ChainGateway {
  /** Asserted against eth_chainId at platform startup. */
  chainId: number;
  /** Read-only client. No wallet client or key exists anywhere in the API (SEC-TX-09). */
  publicClient: PublicClient;
  /** Latest finalized block number (the "finalized" tag), for plan pre-checks that must not trust unfinalized state. */
  finalizedBlock(): Promise<bigint>;
}

export interface Metrics {
  /** Increments a counter `pine_<name>_total` with bounded label values (no ids, no addresses). */
  increment(name: string, labels?: Record<string, string>): void;
  /** Observes a duration in seconds for histogram `pine_<name>_seconds`. */
  observe(name: string, seconds: number, labels?: Record<string, string>): void;
}

export interface AppContext {
  config: AppConfig;
  db: Database;
  clock: Clock;
  redact: Redactor;
  readModel: ReadModel;
  chain: ChainGateway;
  contentStore: ContentStore;
  github: GitHubGateway;
  audit: AuditLog;
  moderation: ModerationGateway;
  compliance: ComplianceGateway;
  quotas: QuotaGateway;
  metrics: Metrics;
}

// ---------------------------------------------------------------------------------------------------------------
// Route modules and jobs
// ---------------------------------------------------------------------------------------------------------------

export interface JobDefinition {
  /** Unique, stable job name, e.g. "claims.reconcile-publications". */
  name: string;
  intervalMs: number;
  /**
   * One execution. The platform guarantees: at most one execution of a given job at a time across all API
   * processes (pg_try_advisory_xact_lock held by a transaction on a dedicated connection for the whole run), no
   * overlap with its own previous execution, the abort signal fires on shutdown, and a thrown error is logged
   * (redacted) and retried at the next interval. Must be idempotent and must not send notifications for data the
   * read model has not reported as indexed.
   */
  run(ctx: AppContext, signal: AbortSignal): Promise<void>;
}

/**
 * Per-route security options, set by modules as `config: { pine: { ... } }` in the route definition and enforced by the
 * platform (fastify `request.routeOptions.config.pine`). Defaults: not public, JSON only, CSRF enforced.
 */
export interface RouteSecurityConfig {
  /** Public, cookie-free route: the platform never reads cookies for it (request.session stays null), adds
   *  `Access-Control-Allow-Origin: *` without credentials, and only GET/HEAD are allowed. */
  public?: boolean;
  /** Accept multipart/form-data (only the evidence upload route); CSRF origin/header rules still apply. */
  multipart?: boolean;
  /** Per-route rate limit override (requests per minute per user, or per IP when unauthenticated). */
  rateLimitPerMinute?: number;
}

declare module "fastify" {
  interface FastifyContextConfig {
    pine?: RouteSecurityConfig;
  }
}

/**
 * Route security model enforced by the platform for every module route (SEC-AUTH-14, SEC-AGENT-04):
 * - CSRF: every unsafe method (POST/PUT/PATCH/DELETE) must carry the platform's custom header and a same-site Origin;
 *   modules do nothing extra. Modules never accept state changes on GET.
 * - Public routes (agent feeds, documents, schemas) must not depend on cookies; responses are identical with or
 *   without a session except where documented.
 * - Session routes use `preHandler: app.requireSession`; admin routes `preHandler: app.requireAdmin`.
 */
export interface RouteModule {
  name: string;
  /**
   * Registers routes under the module's prefix(es) (claims: /api/v1/policies, /api/v1/github, /api/v1/claims,
   * /api/v1/drafts, /api/v1/publications, /api/v1/agents, /.well-known; markets: /api/v1/evidence, /api/v1/content,
   * /api/v1/markets, /api/v1/funding, /api/v1/oracle, /api/v1/accounts). Called inside a Fastify plugin context with
   * the zod type provider already installed.
   */
  register(app: FastifyInstance, ctx: AppContext): Promise<void>;
  jobs?: JobDefinition[];
}
