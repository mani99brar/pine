// Must stay the first import: serializes the memory-heavy (PGlite) gateways test files across vitest workers.
import "./testing/suite-lock.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GitHubGatewayError, type GitHubErrorCode } from "../../contracts/app.js";
import {
  API,
  appGrant,
  commitJson,
  countedResponse,
  createHarness,
  jsonResponse,
  linkUser,
  pullJson,
  rejectionOf,
  repoJson,
  sha,
  USER_A,
  type Harness,
} from "./testing/harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
  await linkUser(h, USER_A, { grant: appGrant(1), githubUserId: 1001, login: "alice" });
  h.fetch.calls.length = 0;
});
afterEach(() => {
  // Every GitHub call goes to api.github.com with redirects refused (the branch lookup takes them manually, never
  // following one) and the documented headers.
  for (const call of h.fetch.calls) {
    expect(new URL(call.url).origin).toBe(API);
    expect(call.redirect).toBe(new URL(call.url).pathname.includes("/branches/") ? "manual" : "error");
    expect(call.headers.get("accept")).toBe("application/vnd.github+json");
    expect(call.headers.get("x-github-api-version")).toBe("2022-11-28");
  }
});

const TOKEN = appGrant(1).access_token;
const REPO = `${API}/repos/kleros/pine`;
const github = () => h.gateways.github;

async function code(promise: Promise<unknown>): Promise<GitHubErrorCode> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(GitHubGatewayError);
  return (error as GitHubGatewayError).code;
}

function publicRepo() {
  h.fetch.json("GET", REPO, 200, repoJson());
}

describe("repositories (SEC-GH-12/13)", () => {
  it("getRepo maps the payload with the viewer permission and sends the user's token", async () => {
    publicRepo();
    const repo = await github().getRepo(USER_A, "kleros", "pine");
    expect(repo).toEqual({
      id: 4242,
      owner: "kleros",
      ownerId: 77,
      name: "pine",
      fullName: "kleros/pine",
      private: false,
      fork: false,
      defaultBranch: "main",
      htmlUrl: "https://github.com/kleros/pine",
      pushedAt: "2026-09-30T12:00:00Z",
      viewerPermission: "write",
    });
    expect(h.fetch.calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("SEC-GH-13 refuses private, internal and visibility-less repositories with REPO_NOT_PUBLIC", async () => {
    for (const overrides of [{ private: true, visibility: "private" }, { private: false, visibility: "internal" }, { visibility: undefined }]) {
      h.fetch.json("GET", REPO, 200, repoJson(overrides));
      expect(await code(github().getRepo(USER_A, "kleros", "pine"))).toBe("REPO_NOT_PUBLIC");
      h.fetch.json("GET", `${API}/repositories/4242`, 200, repoJson(overrides));
      expect(await code(github().getRepoById(USER_A, 4242))).toBe("REPO_NOT_PUBLIC");
    }
  });

  it("SEC-GH-13 a repository flipped to private is refused by every repository-scoped call", async () => {
    h.fetch.json("GET", REPO, 200, repoJson({ private: true, visibility: "private" }));
    expect(await code(github().listPulls(USER_A, "kleros", "pine", "open", 1))).toBe("REPO_NOT_PUBLIC");
    expect(await code(github().getPull(USER_A, "kleros", "pine", 1))).toBe("REPO_NOT_PUBLIC");
    expect(await code(github().listPullCommits(USER_A, "kleros", "pine", 1))).toBe("REPO_NOT_PUBLIC");
    expect(await code(github().getCommit(USER_A, "kleros", "pine", sha(5)))).toBe("REPO_NOT_PUBLIC");
    expect(await code(github().verifyCommitMembership(USER_A, "kleros", "pine", sha(5), { kind: "branch", name: "main" }))).toBe("REPO_NOT_PUBLIC");
    // Only the repository lookup happened each time.
    expect(h.fetch.calls.every((call) => call.url === REPO)).toBe(true);
  });

  it("SEC-GH-12 getRepoById resolves the numeric id and refuses another repository in the answer", async () => {
    h.fetch.json("GET", `${API}/repositories/4242`, 200, repoJson({ name: "pine-renamed", full_name: "kleros/pine-renamed" }));
    expect(await github().getRepoById(USER_A, 4242)).toMatchObject({ id: 4242, fullName: "kleros/pine-renamed" });
    h.fetch.json("GET", `${API}/repositories/4243`, 200, repoJson());
    expect(await code(github().getRepoById(USER_A, 4243))).toBe("UPSTREAM");
    expect(await code(github().getRepoById(USER_A, -1))).toBe("NOT_FOUND");
  });

  it("maps 404 to NOT_FOUND and refuses path-traversing or malformed names without calling GitHub", async () => {
    h.fetch.json("GET", REPO, 404, { message: "Not Found" });
    expect(await code(github().getRepo(USER_A, "kleros", "pine"))).toBe("NOT_FOUND");
    h.fetch.calls.length = 0;
    for (const [owner, name] of [["..", "x"], ["kleros", ".."], ["a/b", "c"], ["kleros", "pine?x=1"], ["kleros", "pi ne"], ["", "x"]] as const) {
      expect(await code(github().getRepo(USER_A, owner, name))).toBe("NOT_FOUND");
    }
    expect(h.fetch.calls).toHaveLength(0);
  });
});

describe("listPublicRepos (SEC-GH-05)", () => {
  it("refreshes the login with GET /user first, then lists only public repositories of that login", async () => {
    h.fetch.json("GET", `${API}/user`, 200, { id: 1001, login: "alice-renamed" });
    h.fetch.json(
      "GET",
      `${API}/users/alice-renamed/repos?type=owner&sort=pushed&per_page=30&page=2`,
      200,
      [repoJson(), repoJson({ id: 5, name: "secret", private: true, visibility: "private" }), repoJson({ id: 6, name: "corp", visibility: "internal" })],
      { link: '<https://api.github.com/user/1001/repos?page=3>; rel="next", <https://api.github.com/user/1001/repos?page=1>; rel="prev"' },
    );
    const result = await github().listPublicRepos(USER_A, 2);
    expect(result.items.map((repo) => repo.id)).toEqual([4242]);
    expect(result.hasMore).toBe(true);
    expect(h.fetch.calls.map((call) => call.url)).toEqual([`${API}/user`, `${API}/users/alice-renamed/repos?type=owner&sort=pushed&per_page=30&page=2`]);
    // The identity stays keyed on the numeric id; only the display login changed.
    expect(await h.gateways.githubAuth.identityOf(USER_A)).toEqual({ githubUserId: 1001, login: "alice-renamed" });
  });

  it("SEC-GH-05 a token answering for another GitHub account revokes the link", async () => {
    h.fetch.json("GET", `${API}/user`, 200, { id: 9999, login: "alice" });
    expect(await code(github().listPublicRepos(USER_A, 1))).toBe("GITHUB_NOT_LINKED");
    expect(await h.gateways.githubAuth.identityOf(USER_A)).toBeNull();
    expect(h.fetch.calls).toHaveLength(1);
    const tokens = await h.database.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM github_tokens");
    expect(tokens[0]?.n).toBe(0);
    expect(h.metrics.counters.get(`github_link_revoked${JSON.stringify({ reason: "unauthorized" })}`)).toBe(1);
  });
});

describe("error mapping", () => {
  it("401 deletes the token, revokes the link and throws GITHUB_NOT_LINKED (never UPSTREAM)", async () => {
    h.fetch.json("GET", REPO, 401, { message: "Bad credentials" });
    expect(await code(github().getRepo(USER_A, "kleros", "pine"))).toBe("GITHUB_NOT_LINKED");
    const rows = await h.database.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM github_tokens");
    expect(rows[0]?.n).toBe(0);
    expect(await h.gateways.githubAuth.identityOf(USER_A)).toBeNull();
    expect(h.metrics.counters.get(`github_link_revoked${JSON.stringify({ reason: "unauthorized" })}`)).toBe(1);
    const lines = h.logs.filter((line) => line.level === "warn" && line.msg.includes("GitHub link revoked"));
    expect(lines.map((line) => line.msg)).toEqual([`GitHub link revoked for user ${USER_A} (reason unauthorized); stored tokens deleted`]);
    // Later calls do not reach GitHub.
    h.fetch.calls.length = 0;
    expect(await code(github().getRepo(USER_A, "kleros", "pine"))).toBe("GITHUB_NOT_LINKED");
    expect(h.fetch.calls).toHaveLength(0);
  });

  it("SEC-GH-14 a primary rate limit (403, remaining 0) is RATE_LIMITED and no call is made until the reset", async () => {
    const reset = h.clock.unix() + 120;
    h.fetch.json("GET", REPO, 403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
    expect(await code(github().getRepo(USER_A, "kleros", "pine"))).toBe("RATE_LIMITED");
    publicRepo();
    h.clock.advance(119_000);
    expect(await code(github().getRepo(USER_A, "kleros", "pine"))).toBe("RATE_LIMITED");
    expect(h.fetch.calls).toHaveLength(1);
    h.clock.advance(1_000);
    await expect(github().getRepo(USER_A, "kleros", "pine")).resolves.toMatchObject({ id: 4242 });
    expect(h.fetch.calls).toHaveLength(2);
  });

  it("SEC-GH-14 a secondary limit with retry-after: 60 makes no upstream call for 60 s", async () => {
    h.fetch.json("GET", REPO, 403, { message: "You have exceeded a secondary rate limit" }, { "retry-after": "60" });
    expect(await code(github().getRepo(USER_A, "kleros", "pine"))).toBe("RATE_LIMITED");
    publicRepo();
    h.clock.advance(59_000);
    expect(await code(github().getRepo(USER_A, "kleros", "pine"))).toBe("RATE_LIMITED");
    expect(h.fetch.calls).toHaveLength(1);
    h.clock.advance(1_000);
    await github().getRepo(USER_A, "kleros", "pine");
    expect(h.fetch.calls).toHaveLength(2);
  });

  it("SEC-GH-14 caps concurrent GitHub calls per user at 5", async () => {
    let inFlight = 0;
    let peak = 0;
    h.fetch.on("GET", REPO, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return jsonResponse(200, repoJson());
    });
    const results = await Promise.all(Array.from({ length: 12 }, () => github().getRepo(USER_A, "kleros", "pine")));
    expect(results).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });

  it("SEC-GH-14 caps concurrent GitHub calls across all users at 90 (< 100)", async () => {
    const users = Array.from({ length: 20 }, (_, index) => `00000000-0000-4000-8000-${String(0x100 + index).padStart(12, "0")}`);
    for (const [index, userId] of users.entries()) await linkUser(h, userId, { grant: appGrant(100 + index), githubUserId: 5000 + index, login: `user${index}` });
    h.fetch.calls.length = 0;
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.fetch.on("GET", REPO, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight -= 1;
      return jsonResponse(200, repoJson());
    });
    // 20 users x 5 requests: the per-user cap alone would allow 100 concurrent calls.
    const all = Promise.all(users.flatMap((userId) => Array.from({ length: 5 }, () => github().getRepo(userId, "kleros", "pine"))));
    // Hold every answer: wait (up to 10 s) for the cap to fill, then give any call beyond it a further 1 s to arrive.
    for (const deadline = Date.now() + 10_000; peak < 90 && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(peak).toBe(90);
    release();
    expect(await all).toHaveLength(100);
    expect(h.fetch.callsTo(REPO)).toHaveLength(100);
  });

  it("a GitHub redirect is refused (UPSTREAM) and its Location is never fetched", async () => {
    h.fetch.on("GET", REPO, () => new Response(null, { status: 301, headers: { location: `${API}/repositories/1` } }));
    h.fetch.json("GET", `${API}/repositories/1`, 200, repoJson({ id: 1 }));
    expect(await code(github().getRepo(USER_A, "kleros", "pine"))).toBe("UPSTREAM");
    expect(h.fetch.calls.map((call) => call.url)).toEqual([REPO]);
  });

  it("429 is RATE_LIMITED; 403 without rate-limit headers and 5xx are UPSTREAM", async () => {
    h.fetch.json("GET", REPO, 429, {});
    expect(await code(github().getRepo(USER_A, "kleros", "pine"))).toBe("RATE_LIMITED");
    h.clock.advance(3_600_000);
    h.fetch.json("GET", REPO, 403, { message: "Resource not accessible" });
    expect(await code(github().getRepo(USER_A, "kleros", "pine"))).toBe("UPSTREAM");
    h.fetch.json("GET", REPO, 502, { message: "Server Error" });
    expect(await code(github().getRepo(USER_A, "kleros", "pine"))).toBe("UPSTREAM");
  });

  it("network failures are UPSTREAM with a message free of tokens and URLs' secrets", async () => {
    h.fetch.on("GET", REPO, () => {
      throw new TypeError(`connect ECONNREFUSED with token ${TOKEN}`);
    });
    const error = await rejectionOf(github().getRepo(USER_A, "kleros", "pine"));
    expect(error).toBeInstanceOf(GitHubGatewayError);
    expect((error as GitHubGatewayError).code).toBe("UPSTREAM");
    expect(error.message).not.toContain(TOKEN);
  });
});

describe("SEC-GH-15 response validation", () => {
  it("a malformed SHA, an oversize title, a wrong type or non-JSON is UPSTREAM", async () => {
    publicRepo();
    h.fetch.json("GET", `${REPO}/pulls/1`, 200, pullJson(1, "XYZ"));
    expect(await code(github().getPull(USER_A, "kleros", "pine", 1))).toBe("UPSTREAM");
    h.fetch.json("GET", `${REPO}/pulls/1`, 200, pullJson(1, sha(9), { title: "x".repeat(5_000) }));
    expect(await code(github().getPull(USER_A, "kleros", "pine", 1))).toBe("UPSTREAM");
    h.fetch.json("GET", `${REPO}/pulls/1`, 200, pullJson(1, sha(9), { number: "1" }));
    expect(await code(github().getPull(USER_A, "kleros", "pine", 1))).toBe("UPSTREAM");
    h.fetch.on("GET", `${REPO}/pulls/1`, () => new Response("<html>oops</html>", { status: 200 }));
    expect(await code(github().getPull(USER_A, "kleros", "pine", 1))).toBe("UPSTREAM");
    h.fetch.json("GET", `${REPO}/commits/${sha(0xabc)}?per_page=1`, 200, commitJson(sha(0xabc).toUpperCase()));
    expect(await code(github().getCommit(USER_A, "kleros", "pine", sha(0xabc)))).toBe("UPSTREAM");
  });

  it("SEC-GH-15 UPSTREAM messages are generic: no upstream body, attacker-controlled text or validation detail reaches them", async () => {
    publicRepo();
    const MARKER = "INJECTED-MARKER";
    const cases: [string, () => void, () => Promise<unknown>][] = [
      ["oversize title", () => h.fetch.json("GET", `${REPO}/pulls/1`, 200, pullJson(1, sha(9), { title: `${MARKER}${"x".repeat(5_000)}` })), () => github().getPull(USER_A, "kleros", "pine", 1)],
      ["5xx body", () => h.fetch.json("GET", `${REPO}/pulls/1`, 502, { message: `internal-detail-xyz ${MARKER}` }), () => github().getPull(USER_A, "kleros", "pine", 1)],
      ["403 body", () => h.fetch.json("GET", `${REPO}/pulls/1`, 403, { message: `Resource not accessible ${MARKER}` }), () => github().getPull(USER_A, "kleros", "pine", 1)],
      ["non-JSON", () => h.fetch.on("GET", `${REPO}/pulls/1`, () => new Response(`<html>${MARKER}</html>`, { status: 200 })), () => github().getPull(USER_A, "kleros", "pine", 1)],
      [
        "malformed SHA",
        () => h.fetch.json("GET", `${REPO}/commits/${sha(0xabc)}?per_page=1`, 200, commitJson(`${MARKER}-not-a-sha`)),
        () => github().getCommit(USER_A, "kleros", "pine", sha(0xabc)),
      ],
    ];
    for (const [label, script, run] of cases) {
      script();
      const error = await rejectionOf(run());
      expect(error, label).toBeInstanceOf(GitHubGatewayError);
      expect((error as GitHubGatewayError).code, label).toBe("UPSTREAM");
      expect(error.message, label).toMatch(/^GitHub (returned|refused) [A-Za-z0-9 ()-]+$/);
      expect(error.message, label).not.toContain(MARKER);
      expect(error.message, label).not.toContain("internal-detail-xyz");
    }
  });

  it("SEC-GH-15 a schema-valid response above 2 MiB is cut off while streaming and is UPSTREAM; the same shape below the cap passes", async () => {
    publicRepo();
    // 100 commits with messages under the schema's 65536-character limit: only the byte cap can refuse this page.
    const page = (messageLength: number) =>
      new TextEncoder().encode(
        JSON.stringify(Array.from({ length: 100 }, (_, index) => commitJson(sha(index + 1), { commit: { message: "m".repeat(messageLength), committer: { date: "2026-09-29T10:00:00Z" } } }))),
      );
    const PAGE_1 = `${REPO}/pulls/7/commits?per_page=100&page=1`;
    const over = page(25_000);
    expect(over.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    // (a) Streamed without Content-Length: reading stops right after the cap, not at the end of the body.
    const streamed = countedResponse(over);
    h.fetch.on("GET", PAGE_1, () => streamed.response, 1);
    expect(await code(github().listPullCommits(USER_A, "kleros", "pine", 7))).toBe("UPSTREAM");
    expect(streamed.pulled()).toBeGreaterThan(2 * 1024 * 1024);
    expect(streamed.pulled()).toBeLessThanOrEqual(2 * 1024 * 1024 + 2 * 65_536);

    // (b) A declared Content-Length above the cap is refused before the body is read (at most the first queued chunk).
    const declared = countedResponse(over, { status: 200, headers: { "content-length": String(over.byteLength) } });
    h.fetch.on("GET", PAGE_1, () => declared.response, 1);
    expect(await code(github().listPullCommits(USER_A, "kleros", "pine", 7))).toBe("UPSTREAM");
    expect(declared.pulled()).toBeLessThanOrEqual(65_536);

    // (c) Just under 2 MiB passes: the failures above are the cap, not the schema.
    const under = page(20_600);
    expect(under.byteLength).toBeLessThan(2 * 1024 * 1024);
    expect(under.byteLength).toBeGreaterThan(2 * 1024 * 1024 - 64 * 1024);
    h.fetch.on("GET", PAGE_1, () => countedResponse(under).response, 1);
    h.fetch.json("GET", `${REPO}/pulls/7/commits?per_page=100&page=2`, 200, []);
    expect(await github().listPullCommits(USER_A, "kleros", "pine", 7)).toHaveLength(100);
  });
});

describe("pulls and commits", () => {
  it("lists pulls of the repository and maps fields", async () => {
    publicRepo();
    h.fetch.json("GET", `${REPO}/pulls?state=all&per_page=30&page=1`, 200, [pullJson(3, sha(3), { merged: undefined, merged_at: "2026-09-01T00:00:00Z", state: "closed" })]);
    const result = await github().listPulls(USER_A, "kleros", "pine", "all", 1);
    expect(result).toEqual({
      items: [
        {
          number: 3,
          title: "Add feature",
          state: "closed",
          merged: true,
          headSha: sha(3),
          headRef: "feature",
          headRepoId: 9999,
          baseSha: sha(2),
          baseRef: "main",
          htmlUrl: "https://github.com/kleros/pine/pull/3",
          authorLogin: "alice",
          updatedAt: "2026-09-30T00:00:00Z",
        },
      ],
      hasMore: false,
    });
  });

  it("listPullCommits pages 100 at a time and stops at 250", async () => {
    publicRepo();
    for (const page of [1, 2, 3]) {
      h.fetch.json("GET", `${REPO}/pulls/7/commits?per_page=100&page=${page}`, 200, Array.from({ length: 100 }, (_, index) => commitJson(sha(page * 1000 + index))));
    }
    const commits = await github().listPullCommits(USER_A, "kleros", "pine", 7);
    expect(commits).toHaveLength(250);
    expect(commits[0]).toEqual({
      sha: sha(1000),
      parents: [sha(1)],
      message: "Fix things",
      authorLogin: "alice",
      committedAt: "2026-09-29T10:00:00Z",
      htmlUrl: `https://github.com/kleros/pine/commit/${sha(1000)}`,
    });
    expect(h.fetch.callsTo(/\/pulls\/7\/commits/)).toHaveLength(3);
  });

  it("getCommit returns null when GitHub has no such object", async () => {
    publicRepo();
    h.fetch.json("GET", `${REPO}/commits/${sha(5)}?per_page=1`, 422, { message: "No commit found for SHA" });
    expect(await github().getCommit(USER_A, "kleros", "pine", sha(5))).toBeNull();
    h.fetch.json("GET", `${REPO}/commits/${sha(5)}?per_page=1`, 404, { message: "Not Found" });
    expect(await github().getCommit(USER_A, "kleros", "pine", sha(5))).toBeNull();
    expect(await code(github().getCommit(USER_A, "kleros", "pine", "not-a-sha"))).toBe("NOT_FOUND");
  });
});

describe("SEC-GH-11 commit membership", () => {
  const target = sha(0xabc);

  it("pull_head when the commit is the PR's head", async () => {
    publicRepo();
    h.fetch.json("GET", `${REPO}/pulls/12`, 200, pullJson(12, target));
    const proof = await github().verifyCommitMembership(USER_A, "kleros", "pine", target.toUpperCase(), { kind: "pull", number: 12 });
    expect(proof).toEqual({ method: "pull_head", repoId: 4242, ref: { kind: "pull", number: 12 }, verifiedAt: h.clock.now() });
  });

  it("pull_commit when the commit is listed in the PR's commits", async () => {
    publicRepo();
    h.fetch.json("GET", `${REPO}/pulls/12`, 200, pullJson(12, sha(1)));
    h.fetch.json("GET", `${REPO}/pulls/12/commits?per_page=100&page=1`, 200, [commitJson(sha(7)), commitJson(target)]);
    expect((await github().verifyCommitMembership(USER_A, "kleros", "pine", target, { kind: "pull", number: 12 })).method).toBe("pull_commit");
  });

  const HEAD = sha(0xbeef);
  /** Scripts GET /repos/kleros/pine/branches/{path} answering the branch's current head. */
  function branch(path: string, name: string, head = HEAD) {
    h.fetch.json("GET", `${REPO}/branches/${path}`, 200, { name, commit: { sha: head, url: `${REPO}/commits/${head}` }, protected: false });
  }
  const compareUrl = (head = HEAD) => `${REPO}/compare/${target}...${head}?per_page=1`;
  const viaBranch = (name: string) => github().verifyCommitMembership(USER_A, "kleros", "pine", target, { kind: "branch", name });

  it("branch_ancestor resolves the branch of this repository and compares against its head SHA, never the name", async () => {
    publicRepo();
    branch("release/v1", "release/v1");
    h.fetch.json("GET", compareUrl(), 200, { status: "ahead", ahead_by: 4, behind_by: 0 });
    const proof = await viaBranch("release/v1");
    expect(proof).toEqual({ method: "branch_ancestor", repoId: 4242, ref: { kind: "branch", name: "release/v1" }, verifiedAt: h.clock.now() });
    branch("main", "main", sha(0xd00d));
    h.fetch.json("GET", compareUrl(sha(0xd00d)), 200, { status: "identical", ahead_by: 0, behind_by: 0 });
    expect((await viaBranch("main")).method).toBe("branch_ancestor");
    // The caller's text reaches only the branches endpoint; compare always carries two SHAs.
    for (const call of h.fetch.callsTo(/\/compare\//)) expect(new URL(call.url).pathname).toMatch(/\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/);
  });

  it("encodes branch names per path segment", async () => {
    publicRepo();
    branch("feat/%C3%A9t%C3%A9%23x", "feat/été#x");
    h.fetch.json("GET", compareUrl(), 200, { status: "ahead", ahead_by: 1, behind_by: 0 });
    expect((await viaBranch("feat/été#x")).method).toBe("branch_ancestor");
    expect(h.fetch.callsTo(`${REPO}/branches/feat/%C3%A9t%C3%A9%23x`)).toHaveLength(1);
  });

  it("SEC-GH-11 a fork-network commit that exists (GET /commits/{sha} is 200) is NOT_A_MEMBER for the PR and the branch", async () => {
    publicRepo();
    // GitHub serves objects of the whole fork network through the upstream repository.
    h.fetch.json("GET", `${REPO}/commits/${target}?per_page=1`, 200, commitJson(target, { html_url: `https://github.com/attacker/pine/commit/${target}` }));
    expect(await github().getCommit(USER_A, "kleros", "pine", target)).toMatchObject({ sha: target });

    h.fetch.json("GET", `${REPO}/pulls/12`, 200, pullJson(12, sha(1)));
    h.fetch.json("GET", `${REPO}/pulls/12/commits?per_page=100&page=1`, 200, [commitJson(sha(1)), commitJson(sha(2))]);
    expect(await code(github().verifyCommitMembership(USER_A, "kleros", "pine", target, { kind: "pull", number: 12 }))).toBe("NOT_A_MEMBER");

    // Compared against the real head of main, the fork-only commit is not in its history.
    branch("main", "main");
    h.fetch.json("GET", compareUrl(), 200, { status: "diverged", ahead_by: 10, behind_by: 1 });
    expect(await code(viaBranch("main"))).toBe("NOT_A_MEMBER");
  });

  it("SEC-GH-11 a SHA-shaped branch name is NOT_A_MEMBER without any branch or compare call (even the fork commit itself)", async () => {
    publicRepo();
    // Were the name passed to compare, `{sha}...{sha}` would be "identical" for any fork-network commit.
    h.fetch.json("GET", /\/compare\//, 200, { status: "identical", ahead_by: 0, behind_by: 0 });
    for (const name of [target, target.toUpperCase(), sha(7), "a".repeat(64)]) expect(await code(viaBranch(name))).toBe("NOT_A_MEMBER");
    expect(h.fetch.callsTo(/\/(branches|compare)\//)).toHaveLength(0);
  });

  it("SEC-GH-11 refs/ names (refs/pull/1/head, refs/heads/main, refs/tags/v1) and HEAD are NOT_A_MEMBER without any call", async () => {
    publicRepo();
    h.fetch.json("GET", /\/compare\//, 200, { status: "ahead", ahead_by: 1, behind_by: 0 });
    for (const name of ["refs/pull/1/head", "refs/heads/main", "REFS/heads/main", "refs/tags/v1", "HEAD", "@"]) {
      expect(await code(viaBranch(name))).toBe("NOT_A_MEMBER");
    }
    expect(h.fetch.callsTo(/\/(branches|compare)\//)).toHaveLength(0);
  });

  it("SEC-GH-11 a tag name is NOT_A_MEMBER: the branches endpoint does not resolve tags", async () => {
    publicRepo();
    h.fetch.json("GET", `${REPO}/branches/v1.0.0`, 404, { message: "Branch not found" });
    h.fetch.json("GET", /\/compare\//, 200, { status: "ahead", ahead_by: 1, behind_by: 0 });
    expect(await code(viaBranch("v1.0.0"))).toBe("NOT_A_MEMBER");
    expect(h.fetch.callsTo(/\/compare\//)).toHaveLength(0);
  });

  it("SEC-GH-11 a branch that does not exist in this repository is NOT_A_MEMBER", async () => {
    publicRepo();
    // e.g. a branch that exists only in the attacker's fork.
    h.fetch.json("GET", `${REPO}/branches/attacker-branch`, 404, { message: "Branch not found" });
    h.fetch.json("GET", /\/compare\//, 200, { status: "ahead", ahead_by: 1, behind_by: 0 });
    expect(await code(viaBranch("attacker-branch"))).toBe("NOT_A_MEMBER");
    expect(h.fetch.callsTo(/\/compare\//)).toHaveLength(0);
  });

  it("SEC-GH-11 a renamed branch (301) is NOT_A_MEMBER and the redirect is not followed", async () => {
    publicRepo();
    h.fetch.on("GET", `${REPO}/branches/master`, () => new Response(null, { status: 301, headers: { location: `${REPO}/branches/main` } }));
    branch("main", "main");
    h.fetch.json("GET", compareUrl(), 200, { status: "ahead", ahead_by: 1, behind_by: 0 });
    expect(await code(viaBranch("master"))).toBe("NOT_A_MEMBER");
    expect(h.fetch.callsTo(`${REPO}/branches/main`)).toHaveLength(0);
    expect(h.fetch.callsTo(/\/compare\//)).toHaveLength(0);
  });

  it("SEC-GH-11 a branch answer naming another branch is NOT_A_MEMBER", async () => {
    publicRepo();
    branch("Main", "main");
    h.fetch.json("GET", compareUrl(), 200, { status: "ahead", ahead_by: 1, behind_by: 0 });
    expect(await code(viaBranch("Main"))).toBe("NOT_A_MEMBER");
    expect(h.fetch.callsTo(/\/compare\//)).toHaveLength(0);
  });

  it("NOT_A_MEMBER when compare reports behind or inconsistent counts", async () => {
    publicRepo();
    branch("main", "main");
    h.fetch.json("GET", compareUrl(), 200, { status: "behind", ahead_by: 0, behind_by: 3 });
    expect(await code(viaBranch("main"))).toBe("NOT_A_MEMBER");
    h.fetch.json("GET", compareUrl(), 200, { status: "ahead", ahead_by: 2, behind_by: 1 });
    expect(await code(viaBranch("main"))).toBe("NOT_A_MEMBER");
  });

  it("compare 404/5xx on an existing branch is UPSTREAM, never a membership verdict; a malformed branch answer is UPSTREAM", async () => {
    publicRepo();
    branch("main", "main");
    h.fetch.json("GET", compareUrl(), 404, { message: "Not Found" });
    expect(await code(viaBranch("main"))).toBe("UPSTREAM");
    h.fetch.json("GET", compareUrl(), 502, { message: "Bad Gateway" });
    expect(await code(viaBranch("main"))).toBe("UPSTREAM");
    h.fetch.json("GET", `${REPO}/branches/main`, 200, { name: "main", commit: { sha: "main" } });
    expect(await code(viaBranch("main"))).toBe("UPSTREAM");
    h.fetch.json("GET", `${REPO}/branches/main`, 500, {});
    expect(await code(viaBranch("main"))).toBe("UPSTREAM");
  });

  it("a PR with more than 250 commits that does not list the commit is NOT_A_MEMBER", async () => {
    publicRepo();
    h.fetch.json("GET", `${REPO}/pulls/12`, 200, pullJson(12, sha(1), { commits: 400 }));
    for (const page of [1, 2, 3]) {
      h.fetch.json("GET", `${REPO}/pulls/12/commits?per_page=100&page=${page}`, 200, Array.from({ length: 100 }, (_, index) => commitJson(sha(page * 1000 + index))));
    }
    expect(await code(github().verifyCommitMembership(USER_A, "kleros", "pine", target, { kind: "pull", number: 12 }))).toBe("NOT_A_MEMBER");
  });

  it("SEC-GH-11 revision syntax and invalid branch names are NOT_A_MEMBER without any call; an invalid SHA is NOT_FOUND", async () => {
    publicRepo();
    for (const name of ["main..x", "main...x", "../main", "main^", "main~1", "main:x", "a b", "-x", "x.lock", "a//b", "a/.b", "a@{1}", "", "x".repeat(256)]) {
      expect(await code(viaBranch(name))).toBe("NOT_A_MEMBER");
    }
    expect(await code(github().verifyCommitMembership(USER_A, "kleros", "pine", "abc", { kind: "branch", name: "main" }))).toBe("NOT_FOUND");
    expect(h.fetch.callsTo(/\/(branches|compare)\//)).toHaveLength(0);
  });

  it("a pull request answer for another repository is refused", async () => {
    publicRepo();
    h.fetch.json("GET", `${REPO}/pulls/12`, 200, pullJson(12, target, { base: { sha: sha(2), ref: "main", repo: repoJson({ id: 1 }) } }));
    expect(await code(github().verifyCommitMembership(USER_A, "kleros", "pine", target, { kind: "pull", number: 12 }))).toBe("UPSTREAM");
  });
});

describe("token handling", () => {
  it("never calls GitHub for an unlinked or malformed user id", async () => {
    expect(await code(github().getRepo("00000000-0000-4000-8000-000000000999", "kleros", "pine"))).toBe("GITHUB_NOT_LINKED");
    expect(await code(github().getRepo("not-a-uuid", "kleros", "pine"))).toBe("GITHUB_NOT_LINKED");
    expect(h.fetch.calls).toHaveLength(0);
  });

  it("each call carries only the requesting user's token", async () => {
    h.fetch.on("GET", REPO, (call) => (call.headers.get("authorization") === `Bearer ${TOKEN}` ? jsonResponse(200, repoJson()) : jsonResponse(401, {})));
    await expect(github().getRepo(USER_A, "kleros", "pine")).resolves.toMatchObject({ id: 4242 });
  });
});
