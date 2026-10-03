// Read-only GitHub REST gateway on behalf of a linked user (SEC-GH-05/11..15). Public repositories only (checked on
// every call), numeric identities, zod-validated bounded responses, commit membership proven (never inferred from a
// commit lookup, which succeeds for any object of the fork network), rate limits honoured without retrying.

import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  GitHubGatewayError,
  type Clock,
  type CommitMembership,
  type CommitMembershipRef,
  type Database,
  type GitHubCommit,
  type GitHubGateway,
  type GitHubPermission,
  type GitHubPull,
  type GitHubRepo,
} from "../../contracts/app.js";
import { execute, int8Text, queryRows } from "./db.js";
import { isUuid } from "./github-auth.js";
import { GitHubUpstreamError, type GitHubApiResponse, type GitHubClient } from "./github-client.js";
import {
  githubBranchSchema,
  githubCommitSchema,
  githubCompareSchema,
  githubPullSchema,
  githubRepoSchema,
  githubUserSchema,
  SHA_PATTERN,
  type GitHubCommitPayload,
  type GitHubPullPayload,
  type GitHubRepoPayload,
} from "./github-schemas.js";
import type { TokenStore } from "./github-tokens.js";

const PAGE_SIZE = 30;
const MAX_PAGE = 1000;
const PULL_COMMITS_LIMIT = 250;
/** SEC-GH-14: at most this many concurrent GitHub calls per user and in total. */
const PER_USER_CONCURRENCY = 5;
const GLOBAL_CONCURRENCY = 90;
const DEFAULT_RATE_LIMIT_BACKOFF_SECONDS = 60;

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

const upstream = (message: string) => new GitHubGatewayError("UPSTREAM", message);
const notFound = (what: string) => new GitHubGatewayError("NOT_FOUND", `${what} not found`);

function nameSegment(value: string, what: string): string {
  if (!NAME_PATTERN.test(value) || value === "." || value === "..") throw notFound(what);
  return encodeURIComponent(value);
}

const notMember = (message: string) => new GitHubGatewayError("NOT_A_MEMBER", message);

/**
 * SEC-GH-11: the URL path of a plain branch name (git check-ref-format rules), encoded segment by segment, or null when
 * the name is not a plain branch name. Anything GitHub could resolve as another commit-ish is refused: 40/64-hex SHA-shaped
 * names, `refs/...` (e.g. refs/pull/1/head), `HEAD`, revision syntax (`..`, `^`, `~`, `:`, `@{`). Tags are not refused
 * here; they fail the branch lookup (404).
 */
function branchPath(name: string): string | null {
  const invalid =
    name.length === 0 ||
    name.length > 255 ||
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(name) ||
    /^refs\//i.test(name) ||
    name === "HEAD" ||
    name === "@" ||
    /[\p{Cc}\s~^:?*[\\]/u.test(name) ||
    name.includes("..") ||
    name.includes("@{") ||
    name.startsWith("/") ||
    name.startsWith("-") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.split("/").some((segment) => segment.length === 0 || segment.startsWith("."));
  if (invalid) return null;
  return name.split("/").map(encodeURIComponent).join("/");
}

function normalizeSha(value: string): string {
  const sha = value.toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw notFound("Commit");
  return sha;
}

function toRepo(payload: GitHubRepoPayload): GitHubRepo {
  // SEC-GH-13: private and internal repositories are refused on every call.
  if (payload.private !== false || payload.visibility !== "public") {
    throw new GitHubGatewayError("REPO_NOT_PUBLIC", "Only public repositories are supported");
  }
  return {
    id: payload.id,
    owner: payload.owner.login,
    ownerId: payload.owner.id,
    name: payload.name,
    fullName: payload.full_name,
    private: false,
    fork: payload.fork,
    defaultBranch: payload.default_branch,
    htmlUrl: payload.html_url,
    pushedAt: payload.pushed_at ?? null,
  };
}

function viewerPermission(payload: GitHubRepoPayload): GitHubPermission {
  const permissions = payload.permissions;
  if (!permissions) return "none";
  if (permissions.admin) return "admin";
  if (permissions.maintain) return "maintain";
  if (permissions.push) return "write";
  if (permissions.triage) return "triage";
  if (permissions.pull) return "read";
  return "none";
}

function toPull(payload: GitHubPullPayload): GitHubPull {
  toRepo(payload.base.repo);
  return {
    number: payload.number,
    title: payload.title,
    state: payload.state,
    merged: payload.merged ?? (payload.merged_at !== null && payload.merged_at !== undefined),
    headSha: payload.head.sha,
    headRef: payload.head.ref,
    headRepoId: payload.head.repo?.id ?? null,
    baseSha: payload.base.sha,
    baseRef: payload.base.ref,
    htmlUrl: payload.html_url,
    authorLogin: payload.user?.login ?? null,
    updatedAt: payload.updated_at,
  };
}

function toCommit(payload: GitHubCommitPayload): GitHubCommit {
  return {
    sha: payload.sha,
    parents: payload.parents.map((parent) => parent.sha),
    message: payload.commit.message,
    authorLogin: payload.author?.login ?? null,
    committedAt: payload.commit.committer?.date ?? null,
    htmlUrl: payload.html_url,
  };
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw upstream(`GitHub returned an unexpected ${what}`);
  return result.data;
}

/** Counting semaphore; a released slot passes directly to the next waiter, so `active` is always exact. */
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  get idle(): boolean {
    return this.active === 0 && this.waiting.length === 0;
  }
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) this.active += 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

export function createGitHubGateway(deps: { db: Database; clock: Clock; client: GitHubClient; tokens: TokenStore }): GitHubGateway {
  const { db, clock, client, tokens } = deps;
  const limitedUntil = new Map<string, number>();
  const perUser = new Map<string, Semaphore>();
  const global = new Semaphore(GLOBAL_CONCURRENCY);

  function rateLimited(userId: string, response: GitHubApiResponse): GitHubGatewayError | null {
    const retryAfter = Number(response.headers.get("retry-after") ?? "NaN");
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = Number(response.headers.get("x-ratelimit-reset") ?? "NaN");
    const limited = response.status === 429 || Number.isFinite(retryAfter) || remaining === "0";
    if (!limited) return null;
    const nowMs = clock.now().getTime();
    let seconds = DEFAULT_RATE_LIMIT_BACKOFF_SECONDS;
    if (Number.isFinite(retryAfter) && retryAfter > 0) seconds = retryAfter;
    else if (remaining === "0" && Number.isFinite(reset)) seconds = Math.max(1, Math.ceil(reset - nowMs / 1000));
    seconds = Math.min(Math.ceil(seconds), 3_600);
    limitedUntil.set(userId, Math.max(limitedUntil.get(userId) ?? 0, nowMs + seconds * 1000));
    return new GitHubGatewayError("RATE_LIMITED", `GitHub rate limit reached; retry after ${seconds} seconds`);
  }

  /** One authenticated GET. Maps 401 (revocation), rate limits and transport failures; other statuses go to the caller. */
  async function call(userId: string, path: string, options: { redirect?: "error" | "manual" } = {}): Promise<GitHubApiResponse> {
    if (!isUuid(userId)) throw new GitHubGatewayError("GITHUB_NOT_LINKED", "GitHub account is not connected");
    const until = limitedUntil.get(userId);
    if (until !== undefined) {
      const left = Math.ceil((until - clock.now().getTime()) / 1000);
      // SEC-GH-14: no upstream call at all while limited.
      if (left > 0) throw new GitHubGatewayError("RATE_LIMITED", `GitHub rate limit reached; retry after ${left} seconds`);
      limitedUntil.delete(userId);
    }
    let semaphore = perUser.get(userId);
    if (!semaphore) {
      semaphore = new Semaphore(PER_USER_CONCURRENCY);
      perUser.set(userId, semaphore);
    }
    const releaseUser = await semaphore.acquire();
    const releaseGlobal = await global.acquire();
    try {
      const token = await tokens.accessToken(userId);
      let response: GitHubApiResponse;
      try {
        response = await client.get(token, path, options);
      } catch (error) {
        if (error instanceof GitHubUpstreamError) throw upstream(error.message);
        throw error;
      }
      if (response.status === 401) return await tokens.revokeAndThrow(userId, "unauthorized");
      if (response.status === 403 || response.status === 429) {
        const limited = rateLimited(userId, response);
        if (limited) throw limited;
        throw upstream(`GitHub refused the request (status ${response.status})`);
      }
      return response;
    } finally {
      releaseGlobal();
      releaseUser();
      if (semaphore.idle) perUser.delete(userId);
    }
  }

  function unexpected(response: GitHubApiResponse): GitHubGatewayError {
    return upstream(`GitHub returned status ${response.status}`);
  }

  async function fetchRepo(userId: string, owner: string, name: string): Promise<GitHubRepoPayload & { mapped: GitHubRepo }> {
    const response = await call(userId, `/repos/${nameSegment(owner, "Repository")}/${nameSegment(name, "Repository")}`);
    if (response.status === 404 || response.status === 451) throw notFound("Repository");
    if (response.status !== 200) throw unexpected(response);
    const payload = parse(githubRepoSchema, response.json, "repository");
    return { ...payload, mapped: toRepo(payload) };
  }

  function repoPath(repo: GitHubRepo): string {
    return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  }

  async function fetchPull(userId: string, repo: GitHubRepo, number: number): Promise<GitHubPullPayload> {
    if (!Number.isSafeInteger(number) || number < 1) throw notFound("Pull request");
    const response = await call(userId, `${repoPath(repo)}/pulls/${number}`);
    if (response.status === 404) throw notFound("Pull request");
    if (response.status !== 200) throw unexpected(response);
    const payload = parse(githubPullSchema, response.json, "pull request");
    if (payload.base.repo.id !== repo.id) throw upstream("GitHub returned a pull request of another repository");
    return payload;
  }

  async function fetchPullCommits(userId: string, repo: GitHubRepo, number: number): Promise<GitHubCommit[]> {
    if (!Number.isSafeInteger(number) || number < 1) throw notFound("Pull request");
    const commits: GitHubCommit[] = [];
    for (let page = 1; commits.length < PULL_COMMITS_LIMIT; page += 1) {
      const response = await call(userId, `${repoPath(repo)}/pulls/${number}/commits?per_page=100&page=${page}`);
      if (response.status === 404) throw notFound("Pull request");
      if (response.status !== 200) throw unexpected(response);
      const items = parse(z.array(githubCommitSchema).max(100), response.json, "commit list");
      commits.push(...items.map(toCommit));
      if (items.length < 100) break;
    }
    return commits.slice(0, PULL_COMMITS_LIMIT);
  }

  const validPage = (page: number) => Number.isSafeInteger(page) && page >= 1 && page <= MAX_PAGE;
  const hasNext = (response: GitHubApiResponse) => /<[^>]*>;\s*rel="next"/.test(response.headers.get("link") ?? "");

  return {
    async listPublicRepos(userId, page) {
      if (!validPage(page)) return { items: [], hasMore: false };
      // SEC-GH-05: refresh the login first; the stored login is never used as a lookup key.
      const me = await call(userId, "/user");
      if (me.status !== 200) throw unexpected(me);
      const user = parse(githubUserSchema, me.json, "user");
      const linked = await queryRows(
        db,
        sql`SELECT github_user_id::text AS github_user_id FROM github_links WHERE user_id = ${userId} AND status = 'active'`,
        z.object({ github_user_id: int8Text }),
      );
      const link = linked[0];
      if (!link) throw new GitHubGatewayError("GITHUB_NOT_LINKED", "GitHub account is not connected");
      // A token that answers for another account than the linked one is unusable.
      if (link.github_user_id !== user.id) return tokens.revokeAndThrow(userId, "unauthorized");
      await execute(
        db,
        sql`UPDATE github_links SET login = ${user.login}, login_fetched_at = ${clock.now()} WHERE user_id = ${userId} AND status = 'active'`,
      );
      const response = await call(userId, `/users/${encodeURIComponent(user.login)}/repos?type=owner&sort=pushed&per_page=${PAGE_SIZE}&page=${page}`);
      if (response.status === 404) throw notFound("User");
      if (response.status !== 200) throw unexpected(response);
      const items = parse(z.array(githubRepoSchema).max(100), response.json, "repository list");
      return {
        items: items.filter((item) => item.private === false && item.visibility === "public").map(toRepo),
        hasMore: hasNext(response),
      };
    },

    async getRepo(userId, owner, name) {
      const repo = await fetchRepo(userId, owner, name);
      return { ...repo.mapped, viewerPermission: viewerPermission(repo) };
    },

    async getRepoById(userId, repoId) {
      if (!Number.isSafeInteger(repoId) || repoId < 1) throw notFound("Repository");
      const response = await call(userId, `/repositories/${repoId}`);
      if (response.status === 404 || response.status === 451) throw notFound("Repository");
      if (response.status !== 200) throw unexpected(response);
      const payload = parse(githubRepoSchema, response.json, "repository");
      if (payload.id !== repoId) throw upstream("GitHub returned another repository");
      return toRepo(payload);
    },

    async listPulls(userId, owner, name, state, page) {
      const repo = (await fetchRepo(userId, owner, name)).mapped;
      if (!validPage(page)) return { items: [], hasMore: false };
      if (state !== "open" && state !== "closed" && state !== "all") throw notFound("Pull request state");
      const response = await call(userId, `${repoPath(repo)}/pulls?state=${state}&per_page=${PAGE_SIZE}&page=${page}`);
      if (response.status === 404) throw notFound("Repository");
      if (response.status !== 200) throw unexpected(response);
      const items = parse(z.array(githubPullSchema).max(100), response.json, "pull request list");
      if (items.some((item) => item.base.repo.id !== repo.id)) throw upstream("GitHub returned a pull request of another repository");
      return { items: items.map(toPull), hasMore: hasNext(response) };
    },

    async getPull(userId, owner, name, number) {
      const repo = (await fetchRepo(userId, owner, name)).mapped;
      return toPull(await fetchPull(userId, repo, number));
    },

    async listPullCommits(userId, owner, name, number) {
      const repo = (await fetchRepo(userId, owner, name)).mapped;
      return fetchPullCommits(userId, repo, number);
    },

    async getCommit(userId, owner, name, sha) {
      const repo = (await fetchRepo(userId, owner, name)).mapped;
      const target = normalizeSha(sha);
      // per_page=1 bounds the embedded file list; only the commit object is read.
      const response = await call(userId, `${repoPath(repo)}/commits/${target}?per_page=1`);
      if (response.status === 404 || response.status === 422 || response.status === 409) return null;
      if (response.status !== 200) throw unexpected(response);
      const commit = toCommit(parse(githubCommitSchema, response.json, "commit"));
      if (commit.sha !== target) throw upstream("GitHub returned another commit");
      return commit;
    },

    async verifyCommitMembership(userId, owner, name, sha, ref: CommitMembershipRef): Promise<CommitMembership> {
      const repo = (await fetchRepo(userId, owner, name)).mapped;
      const target = normalizeSha(sha);
      const proof = (method: CommitMembership["method"]): CommitMembership => ({ method, repoId: repo.id, ref, verifiedAt: clock.now() });
      if (ref.kind === "pull") {
        const pull = await fetchPull(userId, repo, ref.number);
        if (pull.head.sha === target) return proof("pull_head");
        const commits = await fetchPullCommits(userId, repo, ref.number);
        if (commits.some((commit) => commit.sha === target)) return proof("pull_commit");
        throw new GitHubGatewayError("NOT_A_MEMBER", "Commit is not part of the pull request");
      }
      if (ref.kind === "branch") {
        // SEC-GH-11: GitHub's compare resolves any commit-ish of the whole fork network, so the caller's text never
        // reaches it. The name must resolve to a real branch of THIS repository; compare runs against its head SHA.
        const branch = branchPath(ref.name);
        if (branch === null) throw notMember("Reference is not a branch name");
        // Manual redirects: a renamed branch answers 301 to its new name, which is not the requested branch.
        const resolved = await call(userId, `${repoPath(repo)}/branches/${branch}`, { redirect: "manual" });
        if (resolved.status === 404 || (resolved.status >= 300 && resolved.status < 400)) throw notMember("Branch not found in this repository");
        if (resolved.status !== 200) throw unexpected(resolved);
        const head = parse(githubBranchSchema, resolved.json, "branch");
        if (head.name !== ref.name) throw notMember("Branch not found in this repository");
        const response = await call(userId, `${repoPath(repo)}/compare/${target}...${head.commit.sha}?per_page=1`);
        // The branch exists: any non-200 is an upstream failure, never a membership verdict.
        if (response.status !== 200) throw unexpected(response);
        const compare = parse(githubCompareSchema, response.json, "comparison");
        if ((compare.status === "ahead" || compare.status === "identical") && compare.behind_by === 0) return proof("branch_ancestor");
        throw notMember("Commit is not in the branch history");
      }
      throw new GitHubGatewayError("NOT_A_MEMBER", "Unsupported membership reference");
    },
  };
}
