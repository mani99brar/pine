// Must stay the first import: blocks this file until no other PGlite-backed core test file runs.
import "./testing/suite-lock.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuditEntry, GitHubGateway } from "../../contracts/app.js";
import { GitHubGatewayError } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { FakeGitHubGateway, MemoryAuditLog } from "../../contracts/testing.js";
import { createAuditingGitHub } from "./github-audit.js";
import { bodylessCsrfHeaders, cookieValue, createHarness, FakeGitHubAuth, signIn, signWebhook, testAccount, useSharedDatabase, type CoreHarness, type SignedIn } from "./testing/harness.js";

const db = useSharedDatabase({ beforeAll, afterAll, beforeEach });
let h: CoreHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
async function harness(): Promise<CoreHarness> {
  h = await createHarness({ database: db() });
  return h;
}

const alice = testAccount(0xa11ce);
const bob = testAccount(0xb0b);

async function auditRows(harness: CoreHarness, prefix: string): Promise<{ action: string; actor: string | null; details: Record<string, unknown> }[]> {
  return harness.database.sql.query("SELECT action, actor_user_id::text AS actor, details FROM audit_log WHERE action LIKE $1 ORDER BY id", [`${prefix}%`]);
}

async function startLink(harness: CoreHarness, user: SignedIn): Promise<string> {
  const res = await harness.app.inject({ method: "POST", url: "/api/v1/auth/github/start", headers: bodylessCsrfHeaders({ cookie: user.cookie }) });
  expect(res.statusCode).toBe(200);
  return new URL(res.json<{ authorizationUrl: string }>().authorizationUrl).searchParams.get("state") ?? "";
}

function callback(harness: CoreHarness, cookie: string | null, query: string) {
  return harness.app.inject({ method: "GET", url: `/api/v1/auth/github/callback${query}`, headers: cookie ? { cookie } : {} });
}

describe("GitHub linking", () => {
  it("start requires a session and is audited", async () => {
    const hh = await harness();
    const anonymous = await hh.app.inject({ method: "POST", url: "/api/v1/auth/github/start", headers: bodylessCsrfHeaders() });
    expect(anonymous.statusCode).toBe(401);
    const user = await signIn(hh, alice);
    await startLink(hh, user);
    expect((await auditRows(hh, "github.link.started")).map((row) => row.actor)).toEqual([user.userId]);
  });

  it("a successful callback links, rotates the session and redirects 303 to ?github=linked", async () => {
    const hh = await harness();
    const user = await signIn(hh, alice);
    const state = await startLink(hh, user);
    hh.githubAuth.codes.set("code-1", { githubUserId: 101, login: "alice" });
    const res = await callback(hh, user.cookie, `?code=code-1&state=${state}`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("https://app.pine.test/settings?github=linked");
    expect(hh.githubAuth.identities.get(user.userId)).toEqual({ githubUserId: 101, login: "alice" });
    const rotated = cookieValue(res.headers["set-cookie"], "__Host-pine_session");
    expect(rotated).not.toBeNull();
    expect(rotated).not.toBe(user.token);
    expect((await hh.app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: user.cookie } })).statusCode).toBe(401);
    const session = await hh.app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: `__Host-pine_session=${rotated}` } });
    expect(session.json()).toMatchObject({ githubUserId: 101, githubLogin: "alice" });
    expect((await auditRows(hh, "github.link.succeeded"))[0]?.details).toMatchObject({ githubUserId: 101 });
  });

  describe("SEC-GH-03 callback failures link nothing, are audited and redirect to ?github=error", () => {
    const cases: [string, (hh: CoreHarness, user: SignedIn, other: SignedIn) => Promise<{ cookie: string | null; query: string }>, string][] = [
      ["missing state", async (_hh, user) => ({ cookie: user.cookie, query: "?code=code-1" }), "invalid_callback"],
      ["unknown state", async (_hh, user) => ({ cookie: user.cookie, query: "?code=code-1&state=deadbeef" }), "api_bad_request"],
      [
        "expired state",
        async (hh, user) => {
          const state = await startLink(hh, user);
          hh.clock.advance(600_000);
          return { cookie: user.cookie, query: `?code=code-1&state=${state}` };
        },
        "api_bad_request",
      ],
      [
        "state bound to another session",
        async (hh, _user, other) => {
          const state = await startLink(hh, other);
          return { cookie: _user.cookie, query: `?code=code-1&state=${state}` };
        },
        "api_bad_request",
      ],
      [
        "no session at all (SEC-AUTH-18)",
        async (hh, user) => {
          const state = await startLink(hh, user);
          return { cookie: null, query: `?code=code-1&state=${state}` };
        },
        "no_session",
      ],
      [
        "token exchange failure",
        async (hh, user) => {
          hh.githubAuth.completeError = new ApiError("UPSTREAM_UNAVAILABLE", "token exchange failed code=leaked-code-123");
          return { cookie: user.cookie, query: `?code=code-1&state=${await startLink(hh, user)}` };
        },
        "api_upstream_unavailable",
      ],
      [
        "scope rejection",
        async (hh, user) => {
          hh.githubAuth.completeError = new ApiError("FORBIDDEN", "token has scopes");
          return { cookie: user.cookie, query: `?code=code-1&state=${await startLink(hh, user)}` };
        },
        "api_forbidden",
      ],
      [
        "identity conflict (SEC-AUTH-19)",
        async (hh, user, other) => {
          hh.githubAuth.identities.set(other.userId, { githubUserId: 101, login: "alice" });
          return { cookie: user.cookie, query: `?code=code-1&state=${await startLink(hh, user)}` };
        },
        "api_conflict",
      ],
    ];
    for (const [name, setup, reason] of cases) {
      it(`SEC-GH-03 ${name}`, async () => {
        const hh = await harness();
        const user = await signIn(hh, alice);
        const other = await signIn(hh, bob);
        hh.githubAuth.codes.set("code-1", { githubUserId: 101, login: "alice" });
        const { cookie, query } = await setup(hh, user, other);
        const res = await callback(hh, cookie, query);
        expect(res.statusCode).toBe(303);
        expect(res.headers.location).toBe("https://app.pine.test/settings?github=error");
        expect(hh.githubAuth.identities.get(user.userId)).toBeUndefined();
        expect(cookieValue(res.headers["set-cookie"], "__Host-pine_session")).toBeNull();
        const failed = await auditRows(hh, "github.link.failed");
        expect(failed.map((row) => row.details.reason)).toEqual([reason]);
        expect(JSON.stringify(failed)).not.toContain("leaked-code-123");
        if (name === "token exchange failure") {
          // SEC-OPS-03: the failure is logged, redacted (the upstream message echoed the OAuth code).
          const logs = hh.logs.join("\n");
          expect(logs).toContain("github link failed");
          expect(logs).not.toContain("leaked-code-123");
        }
        if (cookie) expect((await hh.app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } })).statusCode).toBe(200);
      });
    }

    it("SEC-GH-03 a reused state links nothing the second time", async () => {
      const hh = await harness();
      const user = await signIn(hh, alice);
      const state = await startLink(hh, user);
      hh.githubAuth.codes.set("code-1", { githubUserId: 101, login: "alice" });
      const first = await callback(hh, user.cookie, `?code=code-1&state=${state}`);
      const rotated = `__Host-pine_session=${cookieValue(first.headers["set-cookie"], "__Host-pine_session")}`;
      await hh.app.inject({ method: "DELETE", url: "/api/v1/auth/github", headers: bodylessCsrfHeaders({ cookie: rotated }) });
      const again = await signIn(hh, alice);
      const res = await callback(hh, again.cookie, `?code=code-1&state=${state}`);
      expect(res.headers.location).toBe("https://app.pine.test/settings?github=error");
      expect(hh.githubAuth.identities.get(user.userId)).toBeUndefined();
    });
  });

  it("unlink deletes the link and the session, and is audited", async () => {
    const hh = await harness();
    const user = await signIn(hh, alice);
    hh.githubAuth.identities.set(user.userId, { githubUserId: 101, login: "alice" });
    const res = await hh.app.inject({ method: "DELETE", url: "/api/v1/auth/github", headers: bodylessCsrfHeaders({ cookie: user.cookie }) });
    expect(res.statusCode).toBe(204);
    expect(hh.githubAuth.identities.has(user.userId)).toBe(false);
    expect((await hh.app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: user.cookie } })).statusCode).toBe(401);
    expect((await auditRows(hh, "github.link.unlinked"))[0]?.details).toEqual({ githubUserId: 101 });
  });
});

describe("auditing GitHub decorator (ctx.github)", () => {
  class RevokingGitHub extends FakeGitHubGateway {
    revoke = true;
    override async getRepoById(userId: string, repoId: number) {
      if (this.revoke) throw new GitHubGatewayError("GITHUB_NOT_LINKED", "token revoked");
      return super.getRepoById(userId, repoId);
    }
  }

  function setup() {
    const auth = new FakeGitHubAuth({ now: () => new Date() });
    const inner = new RevokingGitHub();
    const audit = new MemoryAuditLog();
    const github: GitHubGateway = createAuditingGitHub(inner, auth, audit);
    return { auth, inner, audit, github };
  }

  it("records github.link.revoked when a linked user's call fails with GITHUB_NOT_LINKED, then rethrows", async () => {
    const { auth, audit, github } = setup();
    auth.identities.set("user-1", { githubUserId: 5, login: "u" });
    await expect(github.getRepoById("user-1", 1)).rejects.toMatchObject({ code: "GITHUB_NOT_LINKED" });
    expect(audit.entries).toEqual<AuditEntry[]>([
      { actorUserId: "user-1", action: "github.link.revoked", subjectType: "user", subjectId: "user-1", details: { method: "getRepoById", githubUserId: 5 }, ip: null },
    ]);
  });

  it("a module that catches the error cannot hide the revocation", async () => {
    const { auth, audit, github } = setup();
    auth.identities.set("user-1", { githubUserId: 5, login: "u" });
    await github.getRepoById("user-1", 1).catch(() => null);
    expect(audit.entries.map((entry) => entry.action)).toEqual(["github.link.revoked"]);
  });

  it("a user who never linked GitHub gets the same error and no audit row", async () => {
    const { audit, github } = setup();
    await expect(github.getRepoById("user-2", 1)).rejects.toMatchObject({ code: "GITHUB_NOT_LINKED" });
    await expect(github.listPublicRepos("user-2", 1)).rejects.toMatchObject({ code: "GITHUB_NOT_LINKED" });
    expect(audit.entries).toEqual([]);
  });

  it("other errors and successes are passed through without audit", async () => {
    const { auth, inner, audit, github } = setup();
    auth.identities.set("user-1", { githubUserId: 5, login: "u" });
    inner.linkedUsers.add("user-1");
    inner.revoke = false;
    inner.addRepo({ id: 9, owner: "o", ownerId: 1, name: "r", fullName: "o/r", fork: false, defaultBranch: "main", htmlUrl: "https://github.com/o/r", pushedAt: null });
    await expect(github.getRepoById("user-1", 9)).resolves.toMatchObject({ id: 9 });
    await expect(github.getRepoById("user-1", 10)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(audit.entries).toEqual([]);
  });

  // Real gateway semantics (PRD-02 2.4): the gateway deletes the token and marks the link revoked (identityOf then
  // returns null) BEFORE it throws GITHUB_NOT_LINKED, so the decorator must read the identity before forwarding.
  const METHODS: [keyof GitHubGateway, unknown[]][] = [
    ["listPublicRepos", [2]],
    ["getRepo", ["octo", "repo"]],
    ["getRepoById", [42]],
    ["listPulls", ["octo", "repo", "open", 3]],
    ["getPull", ["octo", "repo", 7]],
    ["listPullCommits", ["octo", "repo", 7]],
    ["getCommit", ["octo", "repo", "a".repeat(40)]],
    ["verifyCommitMembership", ["octo", "repo", "b".repeat(40), { kind: "pull", number: 7 }]],
  ];

  function revokingGateway(auth: FakeGitHubAuth, mode: { revoke: boolean }, calls: { method: string; args: unknown[] }[]): GitHubGateway {
    const handler = (method: string) => async (userId: string, ...args: unknown[]) => {
      calls.push({ method, args: [userId, ...args] });
      if (mode.revoke) {
        auth.identities.delete(userId);
        throw new GitHubGatewayError("GITHUB_NOT_LINKED", "token revoked");
      }
      return { result: method };
    };
    return Object.fromEntries(METHODS.map(([method]) => [method, handler(method)])) as unknown as GitHubGateway;
  }

  for (const [method, args] of METHODS) {
    it(`${method}: forwards arguments and result unchanged, and audits a revocation that removed the identity`, async () => {
      const auth = new FakeGitHubAuth({ now: () => new Date() });
      const audit = new MemoryAuditLog();
      const calls: { method: string; args: unknown[] }[] = [];
      const mode = { revoke: false };
      const github = createAuditingGitHub(revokingGateway(auth, mode, calls), auth, audit);
      const invoke = () => (github[method] as (...a: unknown[]) => Promise<unknown>)("user-1", ...args);
      auth.identities.set("user-1", { githubUserId: 77, login: "u" });
      await expect(invoke()).resolves.toEqual({ result: method });
      expect(calls).toEqual([{ method, args: ["user-1", ...args] }]);
      expect(audit.entries).toEqual([]);
      mode.revoke = true;
      await expect(invoke()).rejects.toMatchObject({ code: "GITHUB_NOT_LINKED" });
      expect(auth.identities.has("user-1")).toBe(false);
      expect(audit.entries).toEqual<AuditEntry[]>([
        { actorUserId: "user-1", action: "github.link.revoked", subjectType: "user", subjectId: "user-1", details: { method, githubUserId: 77 }, ip: null },
      ]);
      // After the revocation the user is no longer linked: the same failure is not audited again.
      await expect(invoke()).rejects.toMatchObject({ code: "GITHUB_NOT_LINKED" });
      expect(audit.entries).toHaveLength(1);
    });
  }

  it("ctx.github audits a revocation whose gateway removed the identity before throwing", async () => {
    const hh = await harness();
    const user = await signIn(hh, alice);
    hh.githubAuth.identities.set(user.userId, { githubUserId: 3, login: "a" });
    hh.github.getRepoById = async (userId: string) => {
      hh.githubAuth.identities.delete(userId);
      throw new GitHubGatewayError("GITHUB_NOT_LINKED", "token revoked");
    };
    await expect(hh.ctx.github.getRepoById(user.userId, 1)).rejects.toMatchObject({ code: "GITHUB_NOT_LINKED" });
    const rows = await auditRows(hh, "github.link.revoked");
    expect(rows.map((row) => [row.actor, row.details])).toEqual([[user.userId, { method: "getRepoById", githubUserId: 3 }]]);
  });

  it("ctx.github in the platform context is the auditing decorator", async () => {
    const hh = await harness();
    const user = await signIn(hh, alice);
    hh.githubAuth.identities.set(user.userId, { githubUserId: 3, login: "a" });
    await expect(hh.ctx.github.listPublicRepos(user.userId, 1)).rejects.toMatchObject({ code: "GITHUB_NOT_LINKED" });
    expect((await auditRows(hh, "github.link.revoked")).map((row) => row.details)).toEqual([{ method: "listPublicRepos", githubUserId: 3 }]);
  });
});

describe("GitHub webhook", () => {
  const jsonBody = Buffer.from('{ "action" : "revoked",\n  "sender": { "login": "ünïcødé", "id": 7 }  }\n', "utf8");
  const formBody = Buffer.from("payload=%7B%22action%22%3A%22revoked%22%7D&x=%C3%BC%20 ü", "utf8");

  for (const [type, body] of [
    ["application/json", jsonBody],
    ["application/x-www-form-urlencoded", formBody],
  ] as const) {
    it(`passes the exact raw bytes (${type}) to the gateway and audits github.webhook.accepted`, async () => {
      const hh = await harness();
      const res = await hh.app.inject({
        method: "POST",
        url: "/api/v1/webhooks/github",
        headers: { "content-type": type, "x-hub-signature-256": signWebhook(body), "x-github-event": "github_app_authorization", "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958" },
        payload: body,
      });
      expect(res.statusCode).toBe(204);
      expect(hh.githubAuth.webhookBodies).toHaveLength(1);
      expect(Buffer.compare(hh.githubAuth.webhookBodies[0] ?? Buffer.alloc(0), body)).toBe(0);
      const rows = await auditRows(hh, "github.webhook");
      expect(rows).toEqual([{ action: "github.webhook.accepted", actor: null, details: { event: "github_app_authorization", delivery: "72d3162e-cc78-11e3-81ab-4c9367dc0958" } }]);
    });
  }

  it("the webhook never reads cookies: a valid session cookie triggers no session lookup or user window", async () => {
    const hh = await harness();
    const user = await signIn(hh, alice);
    await hh.database.sql.exec("DELETE FROM rate_limit_windows");
    hh.githubAuth.calls.length = 0;
    const res = await hh.app.inject({
      method: "POST",
      url: "/api/v1/webhooks/github",
      headers: { "content-type": "application/json", "x-hub-signature-256": signWebhook(jsonBody), cookie: user.cookie },
      payload: jsonBody,
    });
    expect(res.statusCode).toBe(204);
    expect(hh.githubAuth.calls).not.toContain("identityOf");
    expect(await hh.database.sql.query("SELECT key FROM rate_limit_windows")).toEqual([]);
  });

  it("SEC-GH-04 a bad signature gets 401 and a rejected audit (no CSRF headers needed)", async () => {
    const hh = await harness();
    const res = await hh.app.inject({ method: "POST", url: "/api/v1/webhooks/github", headers: { "content-type": "application/json", "x-hub-signature-256": signWebhook("other") }, payload: jsonBody });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
    expect((await auditRows(hh, "github.webhook")).map((row) => row.action)).toEqual(["github.webhook.rejected"]);
  });

  it("SEC-GH-04 a missing signature gets 401 and a rejected audit", async () => {
    const hh = await harness();
    const res = await hh.app.inject({ method: "POST", url: "/api/v1/webhooks/github", headers: { "content-type": "application/json" }, payload: jsonBody });
    expect(res.statusCode).toBe(401);
    expect((await auditRows(hh, "github.webhook")).map((row) => row.action)).toEqual(["github.webhook.rejected"]);
  });

  const rejectFrom = (hh: CoreHarness, remoteAddress: string) =>
    hh.app.inject({ method: "POST", url: "/api/v1/webhooks/github", remoteAddress, headers: { "content-type": "application/json", "x-hub-signature-256": signWebhook("forged") }, payload: jsonBody });
  const rejectedMetric = (hh: CoreHarness) => hh.metrics.counters.get("github_webhook_rejected{}") ?? 0;

  it("SEC-GH-04 rejected webhooks are audited once per client (IPv4, IPv6 /64) per minute and always counted", async () => {
    const hh = await harness();
    for (const ip of ["198.51.100.7", "198.51.100.7", "198.51.100.7", "2001:db8:1:2::1", "2001:db8:1:2:ffff::9", "2001:db8:1:3::1"]) {
      expect((await rejectFrom(hh, ip)).statusCode).toBe(401);
    }
    const ips = async () => (await hh.database.sql.query<{ ip: string }>("SELECT ip FROM audit_log WHERE action = 'github.webhook.rejected' ORDER BY id")).map((row) => row.ip);
    expect(await ips()).toEqual(["198.51.100.7", "2001:db8:1:2::1", "2001:db8:1:3::1"]);
    expect(rejectedMetric(hh)).toBe(6);
    hh.clock.advance(60_000);
    expect((await rejectFrom(hh, "198.51.100.7")).statusCode).toBe(401);
    expect(await ips()).toEqual(["198.51.100.7", "2001:db8:1:2::1", "2001:db8:1:3::1", "198.51.100.7"]);
    expect(rejectedMetric(hh)).toBe(7);
  });

  it("SEC-GH-04 at most 60 rejected-webhook audit rows per minute across all clients", async () => {
    const hh = await harness();
    for (let i = 1; i <= 61; i += 1) expect((await rejectFrom(hh, `10.9.0.${i}`)).statusCode).toBe(401);
    expect(await auditRows(hh, "github.webhook.rejected")).toHaveLength(60);
    expect(rejectedMetric(hh)).toBe(61);
  });

  it("an internal failure gets 500 and a failed audit", async () => {
    const hh = await harness();
    hh.githubAuth.webhookError = new Error("database exploded postgres://u:pw-secret-123@db/x");
    const res = await hh.app.inject({ method: "POST", url: "/api/v1/webhooks/github", headers: { "content-type": "application/json", "x-hub-signature-256": signWebhook(jsonBody) }, payload: jsonBody });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("pw-secret-123");
    expect((await auditRows(hh, "github.webhook")).map((row) => row.action)).toEqual(["github.webhook.failed"]);
    expect(hh.logs.join("\n")).not.toContain("pw-secret-123");
  });

  it("refuses bodies over 64 KiB", async () => {
    const hh = await harness();
    const big = Buffer.alloc(70_000, 0x20);
    const res = await hh.app.inject({ method: "POST", url: "/api/v1/webhooks/github", headers: { "content-type": "application/json", "x-hub-signature-256": signWebhook(big) }, payload: big });
    expect(res.statusCode).toBe(413);
    expect(hh.githubAuth.webhookBodies).toHaveLength(0);
  });
});
