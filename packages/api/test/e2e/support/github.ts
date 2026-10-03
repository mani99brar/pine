// A fake GitHub behind the real gateways' injected fetch: the OAuth token endpoint (code bound to the PKCE challenge the
// user "approved"), the REST endpoints the gateway reads, and grant revocation. Tokens it issues are secrets the suite
// checks never reach a response or a log line. Anything unscripted rejects like a network failure.

import { createHash } from "node:crypto";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";

export interface FakeRepo {
  id: number;
  owner: string;
  ownerId: number;
  name: string;
  defaultBranch: string;
  /** PR number -> head commit and base branch/commit. */
  pulls: Map<number, { headSha: string; baseRef: string; baseSha: string; commits: string[] }>;
}

interface Authorization {
  challenge: string;
  githubUserId: number;
  login: string;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export class FakeGitHub {
  readonly repos: FakeRepo[] = [];
  /** Issued codes -> the authorization they stand for (single use). */
  private readonly codes = new Map<string, Authorization>();
  /** Live access tokens -> GitHub identity. */
  private readonly tokens = new Map<string, { githubUserId: number; login: string }>();
  private counter = 0;
  readonly requests: { method: string; url: string }[] = [];
  /** Every token and code issued: secrets for the leak checks. */
  readonly secrets: string[] = [];

  addRepo(repo: FakeRepo): void {
    this.repos.push(repo);
  }

  /** The user approves the app on github.com: returns the code GitHub would append to the callback URL. */
  authorize(authorizationUrl: string, identity: { githubUserId: number; login: string }): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    if (url.origin !== GITHUB_WEB || url.pathname !== "/login/oauth/authorize") throw new Error("not a GitHub authorization URL");
    if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 is required");
    const state = url.searchParams.get("state");
    const challenge = url.searchParams.get("code_challenge");
    if (!state || !challenge) throw new Error("authorization URL without state or challenge");
    this.counter += 1;
    const code = `e2ecode${this.counter.toString().padStart(14, "0")}`;
    this.codes.set(code, { challenge, ...identity });
    this.secrets.push(code);
    return { code, state };
  }

  private repoByPath(owner: string, name: string): FakeRepo | undefined {
    return this.repos.find((repo) => repo.owner.toLowerCase() === owner.toLowerCase() && repo.name.toLowerCase() === name.toLowerCase());
  }

  private repoJson(repo: FakeRepo) {
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: repo.ownerId },
      private: false,
      visibility: "public",
      fork: false,
      default_branch: repo.defaultBranch,
      html_url: `${GITHUB_WEB}/${repo.owner}/${repo.name}`,
      pushed_at: "2026-09-30T12:00:00Z",
      permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
    };
  }

  private commitJson(repo: FakeRepo, sha: string, parent: string) {
    return {
      sha,
      html_url: `${GITHUB_WEB}/${repo.owner}/${repo.name}/commit/${sha}`,
      parents: [{ sha: parent }],
      author: { login: "maintainer" },
      commit: { message: "Reporter funding", committer: { date: "2026-09-29T10:00:00Z" } },
    };
  }

  private pullJson(repo: FakeRepo, number: number) {
    const pull = repo.pulls.get(number);
    if (!pull) return null;
    return {
      number,
      title: "Reporter funding",
      state: "open",
      merged: false,
      merged_at: null,
      html_url: `${GITHUB_WEB}/${repo.owner}/${repo.name}/pull/${number}`,
      updated_at: "2026-09-30T00:00:00Z",
      user: { login: "maintainer" },
      head: { sha: pull.headSha, ref: "feature", repo: { id: repo.id } },
      base: { sha: pull.baseSha, ref: pull.baseRef, repo: this.repoJson(repo) },
      commits: pull.commits.length,
    };
  }

  private tokenEndpoint(body: string): Response {
    const form = new URLSearchParams(body);
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const authorization = this.codes.get(code);
    this.codes.delete(code);
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    if (!authorization || authorization.challenge !== challenge) return json(200, { error: "bad_verification_code" });
    this.counter += 1;
    const accessToken = `ghu_${"E2E".padEnd(32, "A")}${this.counter.toString().padStart(4, "0")}`;
    const refreshToken = `ghr_${"E2E".padEnd(72, "B")}${this.counter.toString().padStart(4, "0")}`;
    this.tokens.set(accessToken, { githubUserId: authorization.githubUserId, login: authorization.login });
    this.secrets.push(accessToken, refreshToken);
    return json(200, { access_token: accessToken, token_type: "bearer", scope: "", expires_in: 28_800, refresh_token: refreshToken, refresh_token_expires_in: 15_811_200 });
  }

  private api(method: string, url: URL, authorization: string | null): Response {
    if (method === "DELETE" && url.pathname.startsWith("/applications/")) return json(204, null);
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    const identity = token === null ? undefined : this.tokens.get(token);
    if (!identity) return json(401, { message: "Bad credentials" });
    const parts = url.pathname.split("/").filter((part) => part.length > 0);
    if (method !== "GET") return json(404, { message: "Not Found" });
    if (parts.length === 1 && parts[0] === "user") return json(200, { id: identity.githubUserId, login: identity.login });
    if (parts[0] === "users" && parts[2] === "repos") return json(200, this.repos.filter((repo) => repo.owner === parts[1]).map((repo) => this.repoJson(repo)));
    if (parts[0] === "repositories" && parts.length === 2) {
      const repo = this.repos.find((item) => String(item.id) === parts[1]);
      return repo ? json(200, this.repoJson(repo)) : json(404, { message: "Not Found" });
    }
    if (parts[0] !== "repos" || parts.length < 3) return json(404, { message: "Not Found" });
    const repo = this.repoByPath(parts[1] ?? "", parts[2] ?? "");
    if (!repo) return json(404, { message: "Not Found" });
    const rest = parts.slice(3);
    if (rest.length === 0) return json(200, this.repoJson(repo));
    if (rest[0] === "pulls" && rest.length === 2) {
      const pull = this.pullJson(repo, Number(rest[1]));
      return pull ? json(200, pull) : json(404, { message: "Not Found" });
    }
    if (rest[0] === "pulls" && rest[2] === "commits") {
      const pull = repo.pulls.get(Number(rest[1]));
      if (!pull) return json(404, { message: "Not Found" });
      return json(200, pull.commits.map((sha) => this.commitJson(repo, sha, pull.baseSha)));
    }
    if (rest[0] === "commits" && rest.length === 2) {
      const sha = rest[1] ?? "";
      const known = [...repo.pulls.values()].some((pull) => pull.commits.includes(sha) || pull.baseSha === sha);
      return known ? json(200, this.commitJson(repo, sha, `${"0".repeat(39)}1`)) : json(404, { message: "Not Found" });
    }
    return json(404, { message: "Not Found" });
  }

  /** The fetch injected into the gateways (only github.com and api.github.com are ever configured for it). */
  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    const url = new URL(input);
    this.requests.push({ method, url: `${url.origin}${url.pathname}` });
    if (init.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
    if (url.origin === GITHUB_WEB && url.pathname === "/login/oauth/access_token" && method === "POST") return this.tokenEndpoint(typeof init.body === "string" ? init.body : "");
    if (url.origin === GITHUB_API) {
      const headers = new Headers(init.headers);
      return this.api(method, url, headers.get("authorization"));
    }
    throw new TypeError(`fetch failed: unscripted ${method} ${url.origin}${url.pathname}`);
  };
}
