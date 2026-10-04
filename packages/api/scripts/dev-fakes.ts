// DEVELOPMENT ONLY (scripts/dev-stack): in-memory stand-ins for GitHub and IPFS behind the gateways' injected fetch, used
// by scripts/dev-server.ts. Nothing here opens a socket: every request the gateways make is answered in process, and
// anything unscripted rejects like a network failure (SSRF-safe by construction).
//
// DevGitHub wraps the e2e suite's FakeGitHub (test/e2e/support/github.ts, imported, not copied) and adds what a browsing
// frontend needs on top of it: pull request lists, distinct PR/commit metadata, branches and compare (branch membership),
// and refresh-token rotation (GitHub App user tokens expire after 8 hours; the dev stack may run longer).
// FakeIpfs answers Kubo's block/put + pin/add, the Pinning Service API and gateway reads by CID.

import { createHash, randomBytes } from "node:crypto";
import { rawCidFromBytes } from "@pine/shared/canonical";
import { FakeGitHub, GITHUB_API, GITHUB_WEB, type FakeRepo } from "../test/e2e/support/github.js";

export type DevFetch = (input: string, init: RequestInit) => Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A deterministic, realistic-looking 40-hex commit id. */
export const shaOf = (seed: string): string => createHash("sha1").update(`pine-dev:${seed}`).digest("hex");

// ------------------------------------------------------------------------------------------------ GitHub seed data

export interface SeedCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  parents: string[];
}

export interface SeedPull {
  number: number;
  title: string;
  author: string;
  state: "open" | "closed";
  headRef: string;
  baseRef: string;
  /** Oldest first; the last one is the head. */
  commits: SeedCommit[];
  updatedAt: string;
}

export interface SeedRepo {
  id: number;
  owner: string;
  ownerId: number;
  name: string;
  defaultBranch: string;
  /** Branch name -> history, oldest first (the last commit is the branch head). */
  branches: Map<string, SeedCommit[]>;
  pulls: SeedPull[];
}

function commitChain(prefix: string, start: SeedCommit | null, entries: { message: string; author: string; date: string }[]): SeedCommit[] {
  const out: SeedCommit[] = [];
  let parent = start;
  entries.forEach((entry, index) => {
    const commit: SeedCommit = { sha: shaOf(`${prefix}:${index}`), message: entry.message, author: entry.author, date: entry.date, parents: parent ? [parent.sha] : [] };
    out.push(commit);
    parent = commit;
  });
  return out;
}

/** The seeded public repositories: pine-labs/keeper-bot (two open PRs) and pine-labs/fee-splitter (one open PR). */
export function seedRepos(): SeedRepo[] {
  const keeperMain = commitChain("keeper-bot:main", null, [
    { message: "Initial keeper loop with reporter deposits", author: "alice-dev", date: "2026-09-02T09:14:00Z" },
    { message: "Account reporter deposits per bridging epoch", author: "alice-dev", date: "2026-09-10T16:40:00Z" },
    { message: "Bound operator gas reserve usage", author: "bob-ops", date: "2026-09-21T11:05:00Z" },
  ]);
  const keeperHead = keeperMain.at(-1) ?? null;
  const retry = commitChain("keeper-bot:pr12", keeperHead, [
    { message: "Introduce a retry budget for failed keeper runs", author: "alice-dev", date: "2026-09-27T08:30:00Z" },
    { message: "Persist the retry budget across process restarts", author: "alice-dev", date: "2026-09-29T14:12:00Z" },
  ]);
  const guard = commitChain("keeper-bot:pr15", keeperHead, [
    { message: "Check the gas reserve before every reporter deposit", author: "bob-ops", date: "2026-09-30T10:01:00Z" },
  ]);
  const splitterMain = commitChain("fee-splitter:main", null, [
    { message: "Fee splitter contract and payout script", author: "carol-eng", date: "2026-08-12T13:00:00Z" },
    { message: "Round payouts down to the token's decimals", author: "carol-eng", date: "2026-09-01T09:45:00Z" },
  ]);
  const splitterHead = splitterMain.at(-1) ?? null;
  const dust = commitChain("fee-splitter:pr7", splitterHead, [
    { message: "Sweep payout dust to the treasury", author: "carol-eng", date: "2026-09-25T17:20:00Z" },
  ]);
  return [
    {
      id: 812_734_551,
      owner: "pine-labs",
      ownerId: 190_455_201,
      name: "keeper-bot",
      defaultBranch: "main",
      branches: new Map([
        ["main", keeperMain],
        ["feature/retry-budget", [...keeperMain, ...retry]],
        ["fix/gas-reserve-guard", [...keeperMain, ...guard]],
      ]),
      pulls: [
        { number: 12, title: "Add a retry budget to the keeper loop", author: "alice-dev", state: "open", headRef: "feature/retry-budget", baseRef: "main", commits: retry, updatedAt: "2026-09-29T14:12:00Z" },
        { number: 15, title: "Guard reporter deposits against the operator gas reserve", author: "bob-ops", state: "open", headRef: "fix/gas-reserve-guard", baseRef: "main", commits: guard, updatedAt: "2026-09-30T10:01:00Z" },
      ],
    },
    {
      id: 812_734_877,
      owner: "pine-labs",
      ownerId: 190_455_201,
      name: "fee-splitter",
      defaultBranch: "main",
      branches: new Map([
        ["main", splitterMain],
        ["feature/sweep-dust", [...splitterMain, ...dust]],
      ]),
      pulls: [{ number: 7, title: "Sweep payout dust to the treasury", author: "carol-eng", state: "open", headRef: "feature/sweep-dust", baseRef: "main", commits: dust, updatedAt: "2026-09-25T17:20:00Z" }],
    },
  ];
}

// ------------------------------------------------------------------------------------------------ GitHub

const TOKEN_URL = `${GITHUB_WEB}/login/oauth/access_token`;
const MAX_TRACKED = 1_000;

interface Identity {
  githubUserId: number;
  login: string;
}

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

export class DevGitHub {
  readonly fake = new FakeGitHub();
  readonly repos: SeedRepo[];
  /** Codes issued through authorize() -> identity (to rotate refresh tokens later). */
  private readonly codeIdentity = new Map<string, Identity>();
  /** Live refresh tokens -> identity. */
  private readonly refreshIdentity = new Map<string, Identity>();

  constructor(repos: SeedRepo[] = seedRepos()) {
    this.repos = repos;
    for (const repo of repos) {
      const pulls: FakeRepo["pulls"] = new Map();
      const base = repo.branches.get(repo.defaultBranch)?.at(-1)?.sha ?? shaOf(`${repo.name}:base`);
      for (const pull of repo.pulls) {
        const head = pull.commits.at(-1)?.sha ?? base;
        pulls.set(pull.number, { headSha: head, baseRef: pull.baseRef, baseSha: base, commits: pull.commits.map((commit) => commit.sha) });
      }
      this.fake.addRepo({ id: repo.id, owner: repo.owner, ownerId: repo.ownerId, name: repo.name, defaultBranch: repo.defaultBranch, pulls });
    }
  }

  /** The user approves the app on github.com (dev control endpoint): the code GitHub would append to the callback. */
  authorize(authorizationUrl: string, identity: Identity): { code: string; state: string } {
    const result = this.fake.authorize(authorizationUrl, identity);
    this.remember(this.codeIdentity, result.code, identity);
    return result;
  }

  private remember(map: Map<string, Identity>, key: string, identity: Identity): void {
    map.set(key, identity);
    // Bounded bookkeeping for a long-running dev process; the oldest entries go first.
    while (map.size > MAX_TRACKED) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    // FakeGitHub keeps request and secret logs for test assertions; keep them bounded here.
    if (this.fake.requests.length > MAX_TRACKED) this.fake.requests.splice(0, this.fake.requests.length - MAX_TRACKED);
    if (this.fake.secrets.length > MAX_TRACKED) this.fake.secrets.splice(0, this.fake.secrets.length - MAX_TRACKED);
  }

  private repo(owner: string, name: string): SeedRepo | undefined {
    return this.repos.find((repo) => repo.owner.toLowerCase() === owner.toLowerCase() && repo.name.toLowerCase() === name.toLowerCase());
  }

  private commitBySha(repo: SeedRepo, sha: string): SeedCommit | undefined {
    for (const history of repo.branches.values()) {
      const found = history.find((commit) => commit.sha === sha);
      if (found) return found;
    }
    return undefined;
  }

  private commitJson(repo: SeedRepo, commit: SeedCommit): JsonRecord {
    return {
      sha: commit.sha,
      html_url: `${GITHUB_WEB}/${repo.owner}/${repo.name}/commit/${commit.sha}`,
      parents: commit.parents.map((sha) => ({ sha })),
      author: { login: commit.author },
      commit: { message: commit.message, committer: { date: commit.date } },
    };
  }

  /** Pull request JSON from FakeGitHub, with this seed's title, author, state, head ref and dates. */
  private patchPull(repo: SeedRepo, body: unknown): unknown {
    if (!isRecord(body) || typeof body.number !== "number") return body;
    const seed = repo.pulls.find((pull) => pull.number === body.number);
    if (!seed) return body;
    const head = isRecord(body.head) ? { ...body.head, ref: seed.headRef } : body.head;
    return { ...body, title: seed.title, state: seed.state, user: { login: seed.author }, updated_at: seed.updatedAt, head };
  }

  private async delegateJson(input: string, init: RequestInit): Promise<{ response: Response; body: unknown }> {
    const response = await this.fake.fetch(input, init);
    const text = await response.text();
    return { response, body: text.length > 0 ? (JSON.parse(text) as unknown) : null };
  }

  /** FakeGitHub's own token check: the bearer token must be one it issued. */
  private async authorized(init: RequestInit): Promise<boolean> {
    const response = await this.fake.fetch(`${GITHUB_API}/user`, { method: "GET", headers: init.headers ?? {} });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 200;
  }

  /** Exchanges a code at FakeGitHub's token endpoint and records the refresh token's identity. */
  private async exchange(input: string, init: RequestInit, identity: Identity | undefined): Promise<Response> {
    const { response, body } = await this.delegateJson(input, init);
    if (identity && isRecord(body) && typeof body.refresh_token === "string") this.remember(this.refreshIdentity, body.refresh_token, identity);
    return json(response.status, body);
  }

  /** grant_type=refresh_token: a new token pair for the same identity; the old refresh token is spent (rotation). */
  private async refresh(form: URLSearchParams): Promise<Response> {
    const token = form.get("refresh_token") ?? "";
    const identity = this.refreshIdentity.get(token);
    this.refreshIdentity.delete(token);
    if (!identity) return json(200, { error: "bad_refresh_token" });
    const verifier = randomBytes(32).toString("base64url");
    const authorizeUrl = new URL(`${GITHUB_WEB}/login/oauth/authorize`);
    authorizeUrl.searchParams.set("state", randomBytes(16).toString("base64url"));
    authorizeUrl.searchParams.set("code_challenge", createHash("sha256").update(verifier, "ascii").digest("base64url"));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const { code } = this.fake.authorize(authorizeUrl.toString(), identity);
    const body = new URLSearchParams({ code, code_verifier: verifier }).toString();
    return this.exchange(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, identity);
  }

  private compare(repo: SeedRepo, basehead: string): Response {
    const match = /^([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(basehead);
    if (!match) return json(404, { message: "Not Found" });
    const [, base = "", head = ""] = match;
    if (!this.commitBySha(repo, base) || !this.commitBySha(repo, head)) return json(404, { message: "Not Found" });
    if (base === head) return json(200, { status: "identical", ahead_by: 0, behind_by: 0, total_commits: 0 });
    for (const history of repo.branches.values()) {
      const headIndex = history.findIndex((commit) => commit.sha === head);
      const baseIndex = history.findIndex((commit) => commit.sha === base);
      if (headIndex >= 0 && baseIndex >= 0 && baseIndex < headIndex) return json(200, { status: "ahead", ahead_by: headIndex - baseIndex, behind_by: 0, total_commits: headIndex - baseIndex });
      if (headIndex >= 0 && baseIndex >= 0 && headIndex < baseIndex) return json(200, { status: "behind", ahead_by: 0, behind_by: baseIndex - headIndex, total_commits: 0 });
    }
    return json(200, { status: "diverged", ahead_by: 1, behind_by: 1, total_commits: 1 });
  }

  /** The fetch injected into the gateways for github.com and api.github.com. */
  readonly fetch: DevFetch = async (input, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const url = new URL(input);
    if (init.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
    if (url.origin === GITHUB_WEB && url.pathname === "/login/oauth/access_token" && method === "POST") {
      const form = new URLSearchParams(typeof init.body === "string" ? init.body : "");
      if (form.get("grant_type") === "refresh_token") return this.refresh(form);
      const code = form.get("code") ?? "";
      const identity = this.codeIdentity.get(code);
      this.codeIdentity.delete(code);
      return this.exchange(input, init, identity);
    }
    if (url.origin !== GITHUB_API || method !== "GET") return this.fake.fetch(input, init);
    const parts = url.pathname.split("/").filter((part) => part.length > 0).map((part) => decodeURIComponent(part));
    const repo = parts[0] === "repos" && parts.length >= 4 ? this.repo(parts[1] ?? "", parts[2] ?? "") : undefined;
    if (!repo) return this.fake.fetch(input, init);
    const rest = parts.slice(3);
    const kind = rest[0];
    if (kind !== "pulls" && kind !== "commits" && kind !== "branches" && kind !== "compare") return this.fake.fetch(input, init);
    if (!(await this.authorized(init))) return json(401, { message: "Bad credentials" });

    if (kind === "pulls" && rest.length === 1) {
      const state = url.searchParams.get("state") ?? "open";
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
      const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get("per_page") ?? "30") || 30));
      const selected = repo.pulls.filter((pull) => state === "all" || pull.state === state).slice((page - 1) * perPage, page * perPage);
      const items: unknown[] = [];
      for (const pull of selected) {
        const single = await this.delegateJson(`${GITHUB_API}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`, { method: "GET", headers: init.headers ?? {} });
        if (single.response.status === 200) items.push(this.patchPull(repo, single.body));
      }
      return json(200, items);
    }
    if (kind === "pulls" && rest.length === 2) {
      const { response, body } = await this.delegateJson(input, init);
      return json(response.status, response.status === 200 ? this.patchPull(repo, body) : body);
    }
    if (kind === "pulls" && rest.length === 3 && rest[2] === "commits") {
      const pull = repo.pulls.find((item) => item.number === Number(rest[1]));
      if (!pull) return json(404, { message: "Not Found" });
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
      return json(200, page === 1 ? pull.commits.map((commit) => this.commitJson(repo, commit)) : []);
    }
    if (kind === "commits" && rest.length === 2) {
      const commit = this.commitBySha(repo, (rest[1] ?? "").toLowerCase());
      return commit ? json(200, this.commitJson(repo, commit)) : json(404, { message: "Not Found" });
    }
    if (kind === "branches" && rest.length >= 2) {
      const name = rest.slice(1).join("/");
      const head = repo.branches.get(name)?.at(-1);
      return head ? json(200, { name, commit: { sha: head.sha }, protected: name === repo.defaultBranch }) : json(404, { message: "Branch not found" });
    }
    if (kind === "compare" && rest.length === 2) return this.compare(repo, rest[1] ?? "");
    return json(404, { message: "Not Found" });
  };

  /** Seed data for the dev control endpoint (no secrets). */
  describe(): unknown {
    return this.repos.map((repo) => ({
      id: repo.id,
      owner: repo.owner,
      ownerId: repo.ownerId,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      branches: Object.fromEntries([...repo.branches.entries()].map(([name, history]) => [name, { head: history.at(-1)?.sha ?? null, commits: history.map((commit) => commit.sha) }])),
      pulls: repo.pulls.map((pull) => ({ number: pull.number, title: pull.title, headRef: pull.headRef, headSha: pull.commits.at(-1)?.sha ?? null, commits: pull.commits.map((commit) => commit.sha) })),
    }));
  }
}

// ------------------------------------------------------------------------------------------------ IPFS

/** Reserved `.invalid` hosts (RFC 2606): even outside this process they can never resolve. */
export const FAKE_IPFS = {
  kuboApiUrl: "http://kubo.pine-dev.invalid:5001",
  pinningServiceUrl: "https://pinning.pine-dev.invalid/psa",
  gatewayUrl: "https://ipfs.pine-dev.invalid",
} as const;

const MAX_BLOCK_BYTES = 1024 * 1024;
const MAX_STORE_BYTES = 128 * 1024 * 1024;

/** Kubo (block/put raw + pin/add), Pinning Service API and a trusted gateway, all over one in-memory block store. */
export class FakeIpfs {
  private readonly blocks = new Map<string, Uint8Array>();
  private readonly pins = new Map<string, { requestid: string; created: string }>();
  private storedBytes = 0;

  constructor(private readonly pinningToken: string) {}

  get stats(): { blocks: number; bytes: number; servicePins: number } {
    return { blocks: this.blocks.size, bytes: this.storedBytes, servicePins: this.pins.size };
  }

  private async kubo(url: URL, init: RequestInit, method: string): Promise<Response> {
    if (method !== "POST") return json(405, { Message: "method not allowed", Code: 0, Type: "error" });
    if (url.pathname === "/api/v0/block/put") {
      if (url.searchParams.get("cid-codec") !== "raw" || url.searchParams.get("mhtype") !== "sha2-256") return json(400, { Message: "unsupported codec", Code: 0, Type: "error" });
      const form = init.body;
      if (!(form instanceof FormData)) return json(400, { Message: "multipart body required", Code: 0, Type: "error" });
      const file = form.get("file");
      if (!(file instanceof Blob)) return json(400, { Message: "file part required", Code: 0, Type: "error" });
      if (file.size > MAX_BLOCK_BYTES) return json(400, { Message: "block too large", Code: 0, Type: "error" });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const cid = rawCidFromBytes(bytes);
      if (!this.blocks.has(cid)) {
        if (this.storedBytes + bytes.byteLength > MAX_STORE_BYTES) return json(500, { Message: "dev block store full", Code: 0, Type: "error" });
        this.blocks.set(cid, bytes);
        this.storedBytes += bytes.byteLength;
      }
      return json(200, { Key: cid, Size: bytes.byteLength });
    }
    if (url.pathname === "/api/v0/pin/add") {
      const cid = url.searchParams.get("arg") ?? "";
      if (!this.blocks.has(cid)) return json(500, { Message: "block not found", Code: 0, Type: "error" });
      return json(200, { Pins: [cid] });
    }
    return json(404, { Message: "not found", Code: 0, Type: "error" });
  }

  private pinStatus(cid: string, pin: { requestid: string; created: string }): JsonRecord {
    return { requestid: pin.requestid, status: "pinned", created: pin.created, pin: { cid, name: cid }, delegates: [], info: {} };
  }

  private async pinning(url: URL, init: RequestInit, method: string, base: URL): Promise<Response> {
    const headers = new Headers(init.headers);
    if (headers.get("authorization") !== `Bearer ${this.pinningToken}`) return json(401, { error: { reason: "UNAUTHORIZED" } });
    const path = url.pathname.slice(base.pathname.replace(/\/+$/, "").length);
    if (path !== "/pins") return json(404, { error: { reason: "NOT_FOUND" } });
    if (method === "GET") {
      const wanted = (url.searchParams.get("cid") ?? "").split(",").filter((cid) => cid.length > 0);
      const results = wanted.flatMap((cid) => {
        const pin = this.pins.get(cid);
        return pin ? [this.pinStatus(cid, pin)] : [];
      });
      return json(200, { count: results.length, results });
    }
    if (method === "POST") {
      const body: unknown = JSON.parse(typeof init.body === "string" ? init.body : "{}");
      if (!isRecord(body) || typeof body.cid !== "string") return json(400, { error: { reason: "BAD_REQUEST" } });
      // The fake "fetches" the content from the network: only CIDs it already holds can be pinned.
      if (!this.blocks.has(body.cid)) return json(400, { error: { reason: "CONTENT_NOT_FOUND" } });
      const pin = this.pins.get(body.cid) ?? { requestid: randomBytes(12).toString("hex"), created: new Date().toISOString() };
      this.pins.set(body.cid, pin);
      return json(202, this.pinStatus(body.cid, pin));
    }
    return json(405, { error: { reason: "METHOD_NOT_ALLOWED" } });
  }

  private gateway(url: URL, method: string): Response {
    if (method !== "GET") return json(405, { message: "method not allowed" });
    const match = /^\/ipfs\/([a-z2-7]{20,100})$/.exec(url.pathname);
    const bytes = match ? this.blocks.get(match[1] ?? "") : undefined;
    if (!bytes) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(Buffer.from(bytes), { status: 200, headers: { "content-type": "application/vnd.ipld.raw", "content-length": String(bytes.byteLength) } });
  }

  /** Answers a request to one of the FAKE_IPFS origins, or returns null when the URL is not one of them. */
  async handle(input: string, init: RequestInit): Promise<Response | null> {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    if (init.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
    if (url.origin === new URL(FAKE_IPFS.kuboApiUrl).origin) return this.kubo(url, init, method);
    const pinningBase = new URL(FAKE_IPFS.pinningServiceUrl);
    if (url.origin === pinningBase.origin) return this.pinning(url, init, method, pinningBase);
    if (url.origin === new URL(FAKE_IPFS.gatewayUrl).origin) return this.gateway(url, method);
    return null;
  }
}
