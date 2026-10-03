// Must stay the first import: serializes the memory-heavy claims test files (see test/lock.ts).
import "./test/lock.js";
import { describe, expect, it } from "vitest";
import { GitHubGatewayError, type GitHubErrorCode } from "../../contracts/app.js";
import { FakeQuotas } from "../../contracts/testing.js";
import { mapGitHubError } from "./github.js";
import { BASE_COMMIT, PULL_NUMBER, REPO, TARGET_COMMIT, useHarness } from "./test/helpers.js";

const harnessOf = useHarness();
const repoUrl = `/api/v1/github/repos/${REPO.owner}/${REPO.name}`;

describe("GitHub browsing", () => {
  it("serves repositories, pulls and commits for a linked user, one quota unit per upstream call", async () => {
    const h = harnessOf();
    h.ctx.github.addPullCommit(REPO.owner, REPO.name, PULL_NUMBER, { sha: TARGET_COMMIT, parents: [BASE_COMMIT], message: "fix", authorLogin: "alice", committedAt: null, htmlUrl: "https://github.com/x" });
    h.ctx.github.addCommit(REPO.owner, REPO.name, { sha: TARGET_COMMIT, parents: [BASE_COMMIT], message: "fix", authorLogin: "alice", committedAt: null, htmlUrl: "https://github.com/x" });
    const urls = [
      "/api/v1/github/repos?page=1",
      repoUrl,
      `${repoUrl}/pulls?state=all&page=1`,
      `${repoUrl}/pulls/${PULL_NUMBER}`,
      `${repoUrl}/pulls/${PULL_NUMBER}/commits`,
      `${repoUrl}/commits/${TARGET_COMMIT}`,
    ];
    for (const url of urls) {
      const response = await h.app.inject({ method: "GET", url, headers: h.headers });
      expect(response.statusCode, url).toBe(200);
    }
    expect(h.ctx.quotas.used.get(`${h.session.userId}:github_calls_per_hour`)).toBe(urls.length);
    const commit = await h.app.inject({ method: "GET", url: `${repoUrl}/commits/${TARGET_COMMIT}`, headers: h.headers });
    // Existence is not membership (SEC-GH-11).
    expect(commit.json()).toMatchObject({ membershipVerified: false });
  });

  it("validates path parameters", async () => {
    const h = harnessOf();
    for (const url of [
      "/api/v1/github/repos/-bad/repo",
      "/api/v1/github/repos/kleros/a%20b",
      `${repoUrl}/pulls/0`,
      `${repoUrl}/pulls/abc`,
      `${repoUrl}/commits/xyz`,
      `${repoUrl}/commits/${"a".repeat(64)}`,
      `${repoUrl}/pulls?state=merged`,
    ]) {
      const response = await h.app.inject({ method: "GET", url, headers: h.headers });
      expect(response.statusCode, url).toBe(400);
    }
    expect(h.ctx.quotas.used.size).toBe(0);
  });

  it("maps gateway errors to client errors", async () => {
    const h = harnessOf();
    const unlinked = await h.user({ linkGitHub: false });
    const notLinked = await h.app.inject({ method: "GET", url: repoUrl, headers: unlinked.headers });
    expect(notLinked.statusCode).toBe(403);
    expect(notLinked.json().error.message).toMatch(/Connect your GitHub/);

    h.ctx.github.addRepo({ id: 5, owner: "acme", ownerId: 9, name: "secret", fullName: "acme/secret", fork: false, defaultBranch: "main", htmlUrl: "https://github.com/acme/secret", pushedAt: null }, { visibility: "private" });
    expect((await h.app.inject({ method: "GET", url: "/api/v1/github/repos/acme/secret", headers: h.headers })).json().error.code).toBe("UNPROCESSABLE");
    expect((await h.app.inject({ method: "GET", url: "/api/v1/github/repos/acme/missing", headers: h.headers })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: `${repoUrl}/commits/${"f".repeat(40)}`, headers: h.headers })).statusCode).toBe(404);

    h.ctx.github.rateLimited = true;
    const limited = await h.app.inject({ method: "GET", url: repoUrl, headers: h.headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");

    const expected: Record<GitHubErrorCode, [string, number]> = {
      GITHUB_NOT_LINKED: ["FORBIDDEN", 403],
      REPO_NOT_PUBLIC: ["UNPROCESSABLE", 422],
      NOT_FOUND: ["NOT_FOUND", 404],
      NOT_A_MEMBER: ["UNPROCESSABLE", 422],
      RATE_LIMITED: ["RATE_LIMITED", 429],
      UPSTREAM: ["UPSTREAM_UNAVAILABLE", 502],
    };
    for (const [code, [apiCode, status]] of Object.entries(expected)) {
      const mapped = mapGitHubError(new GitHubGatewayError(code as GitHubErrorCode, "upstream said https://api.github.com/x?token=ghp_secret")) as { code: string; statusCode: number; message: string };
      expect(mapped.code).toBe(apiCode);
      expect(mapped.statusCode).toBe(status);
      expect(mapped.message).not.toContain("ghp_");
    }
  });

  it("refuses when the hourly GitHub quota is exhausted", async () => {
    const h = harnessOf();
    h.ctx.quotas = new FakeQuotas({ github_calls_per_hour: 0 });
    const response = await h.app.inject({ method: "GET", url: repoUrl, headers: h.headers });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("QUOTA_EXCEEDED");
  });
});
