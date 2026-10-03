// Must stay the first import: blocks this file until no other PGlite-backed core test file runs.
import "./testing/suite-lock.js";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RouteModule } from "../../contracts/app.js";
import { GitHubGatewayError } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { buildApp } from "./app.js";
import { checkCsrf, mediaType } from "./csrf.js";
import { cookieValue, createHarness, csrfHeaders, ORIGIN, signIn, TEST_SECRET, testAccount, useSharedDatabase, type CoreHarness } from "./testing/harness.js";

const SESSION_TOKEN_IN_ERROR = `pine_s1_${"A".repeat(43)}`;

const probeModule: RouteModule = {
  name: "probe",
  async register(app: FastifyInstance) {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get("/api/v1/probe/public", { config: { pine: { public: true } } }, async (request) => ({ hasSession: request.session !== null }));
    typed.get("/api/v1/probe/private", { preHandler: app.requireSession }, async (request) => ({ wallet: request.session?.wallet ?? null }));
    typed.post("/api/v1/probe/echo", { schema: { body: z.object({ value: z.string() }).strict() } }, async (request) => ({ value: request.body.value }));
    typed.delete("/api/v1/probe/item", async () => ({ deleted: true }));
    typed.put("/api/v1/probe/put", { schema: { body: z.object({ value: z.string() }).strict() } }, async (request) => ({ value: request.body.value }));
    typed.patch("/api/v1/probe/patch", { schema: { body: z.object({ value: z.string() }).strict() } }, async (request) => ({ value: request.body.value }));
    typed.post("/api/v1/probe/upload", { config: { pine: { multipart: true } } }, async (request) => {
      const file = await request.file();
      if (!file) throw new ApiError("BAD_REQUEST", "file required");
      const bytes = await file.toBuffer();
      return { size: bytes.length };
    });
    typed.get("/api/v1/probe/secret-error", async () => {
      throw new Error(`connect failed postgres://pine:${TEST_SECRET}@db/pine token ${SESSION_TOKEN_IN_ERROR}`);
    });
    typed.get("/api/v1/probe/secret-api-error", async () => {
      throw new ApiError("BAD_REQUEST", `bad ${TEST_SECRET} ${SESSION_TOKEN_IN_ERROR}`);
    });
    typed.get("/api/v1/probe/github/:code", async (request) => {
      const code = (request.params as { code: GitHubGatewayError["code"] }).code;
      throw new GitHubGatewayError(code, "github said no");
    });
  },
};

const db = useSharedDatabase({ beforeAll, afterAll, beforeEach });
let h: CoreHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function current(): CoreHarness {
  if (!h) throw new Error("harness not created");
  return h;
}

async function harness(options: Parameters<typeof createHarness>[0] = {}): Promise<CoreHarness> {
  const created = await createHarness({ modules: [probeModule], database: db(), ...options });
  h = created;
  return created;
}

describe("CSRF (SEC-AUTH-14)", () => {
  it("accepts a same-origin JSON request with the custom header", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "POST", url: "/api/v1/probe/echo", headers: csrfHeaders(), payload: { value: "x" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ value: "x" });
  });

  it("accepts application/json with a charset parameter", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "POST", url: "/api/v1/probe/echo", headers: csrfHeaders({ "content-type": "application/json; charset=utf-8" }), payload: JSON.stringify({ value: "x" }) });
    expect(res.statusCode).toBe(200);
  });

  const rejected: [string, Record<string, string | undefined>][] = [
    ["SEC-AUTH-14 rejects a missing Origin", { origin: undefined }],
    ["SEC-AUTH-14 rejects a foreign Origin", { origin: "https://evil-pine.app" }],
    ["SEC-AUTH-14 rejects a suffix-matching Origin", { origin: "https://app.pine.test.evil.example" }],
    ["SEC-AUTH-14 rejects the user-content Origin", { origin: "https://pine-usercontent.test" }],
    ["SEC-AUTH-14 rejects Origin null", { origin: "null" }],
    ["SEC-AUTH-14 rejects Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
    ["SEC-AUTH-14 rejects a missing x-pine-csrf header", { "x-pine-csrf": undefined }],
    ["SEC-AUTH-14 rejects a wrong x-pine-csrf value", { "x-pine-csrf": "true" }],
    ["SEC-AUTH-14 rejects a text/plain body (forged fetch)", { "content-type": "text/plain" }],
    ["SEC-AUTH-14 rejects a form post", { "content-type": "application/x-www-form-urlencoded" }],
    ["SEC-AUTH-14 rejects multipart on a JSON-only route", { "content-type": "multipart/form-data; boundary=x" }],
  ];
  for (const [name, overrides] of rejected) {
    it(name, async () => {
      const { app } = await harness();
      const headers = Object.fromEntries(Object.entries({ ...csrfHeaders(), ...overrides }).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const res = await app.inject({ method: "POST", url: "/api/v1/probe/echo", headers, payload: overrides["content-type"]?.startsWith("application/json") === false ? "value=x" : JSON.stringify({ value: "x" }) });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("CSRF_REJECTED");
    });
  }

  for (const [method, url] of [
    ["PUT", "/api/v1/probe/put"],
    ["PATCH", "/api/v1/probe/patch"],
  ] as const) {
    it(`SEC-AUTH-14 applies to ${method}: every CSRF rule is enforced and a valid request passes`, async () => {
      const { app } = await harness();
      const cases: Record<string, string | undefined>[] = [
        { origin: undefined },
        { origin: "https://evil-pine.app" },
        { "sec-fetch-site": "cross-site" },
        { "x-pine-csrf": undefined },
        { "content-type": "text/plain" },
      ];
      for (const overrides of cases) {
        const headers = Object.fromEntries(Object.entries({ ...csrfHeaders(), ...overrides }).filter((entry): entry is [string, string] => entry[1] !== undefined));
        const res = await app.inject({ method, url, headers, payload: JSON.stringify({ value: "x" }) });
        expect([res.statusCode, res.json().error.code], JSON.stringify(overrides)).toEqual([403, "CSRF_REJECTED"]);
      }
      const ok = await app.inject({ method, url, headers: csrfHeaders(), payload: { value: "x" } });
      expect(ok.statusCode).toBe(200);
    });
  }

  it("SEC-AUTH-14 every unsafe platform route enforces CSRF and has no side effect when refused", async () => {
    const hh = await harness({ settings: { adminWallets: new Set([testAccount(1).address.toLowerCase()]) } });
    const user = await signIn(hh, testAccount(1));
    // A pending challenge whose verify would succeed if CSRF were skipped.
    const challenge = await hh.app.inject({ method: "POST", url: "/api/v1/auth/siwe/challenge", headers: csrfHeaders(), payload: { address: testAccount(2).address } });
    const presession = cookieValue(challenge.headers["set-cookie"], "__Host-pine_presession") ?? "";
    const { message } = challenge.json<{ message: string }>();
    const signature = await testAccount(2).signMessage({ message });
    expect(
      (
        await hh.app.inject({
          method: "POST",
          url: "/api/v1/admin/moderation",
          headers: csrfHeaders({ cookie: user.cookie }),
          payload: { subject: "content", id: `0x${"ab".repeat(32)}`, action: "block", reason: "x" },
        })
      ).statusCode,
    ).toBe(200);
    hh.githubAuth.identities.set(user.userId, { githubUserId: 9, login: "u" });
    const snapshot = async () => ({
      sessions: (await hh.database.sql.query("SELECT id FROM sessions ORDER BY id")).length,
      nonces: (await hh.database.sql.query("SELECT nonce FROM siwe_nonces")).length,
      presessions: (await hh.database.sql.query("SELECT id FROM siwe_presessions")).length,
      moderation: await hh.database.sql.query("SELECT subject, subject_id, action FROM moderation_states ORDER BY subject_id"),
      audit: (await hh.database.sql.query("SELECT id FROM audit_log")).length,
    });
    const before = await snapshot();
    hh.githubAuth.calls.length = 0;
    const forged = { origin: "https://attacker.example", "content-type": "application/json", cookie: `${user.cookie}; __Host-pine_presession=${presession}` };
    const routes: [string, string, unknown][] = [
      ["POST", "/api/v1/auth/siwe/challenge", { address: testAccount(3).address }],
      ["POST", "/api/v1/auth/siwe/verify", { message, signature }],
      ["POST", "/api/v1/auth/logout", {}],
      ["POST", "/api/v1/auth/github/start", {}],
      ["DELETE", "/api/v1/auth/github", {}],
      ["POST", "/api/v1/admin/moderation", { subject: "content", id: `0x${"cd".repeat(32)}`, action: "block", reason: "x" }],
      ["DELETE", "/api/v1/admin/moderation", { subject: "content", id: `0x${"ab".repeat(32)}`, reason: "x" }],
    ];
    for (const [method, url, payload] of routes) {
      const res = await hh.app.inject({ method: method as "POST" | "DELETE", url, headers: forged, payload: JSON.stringify(payload) });
      expect([res.statusCode, res.json().error.code], `${method} ${url}`).toEqual([403, "CSRF_REJECTED"]);
    }
    expect(await snapshot()).toEqual(before);
    expect(hh.githubAuth.calls.filter((call) => call !== "identityOf")).toEqual([]);
    expect(hh.githubAuth.identities.get(user.userId)).toEqual({ githubUserId: 9, login: "u" });
    // The session is still valid (logout did not run).
    expect((await hh.app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: user.cookie } })).statusCode).toBe(200);
  });

  for (const flag of ["csrfExempt", "noSession"] as const) {
    it(`SEC-AUTH-14 refuses to start when any route other than the GitHub webhook sets pineCore.${flag}`, async () => {
      const bad: RouteModule = {
        name: "bad",
        async register(app) {
          app.post("/api/v1/exempt", { config: { pineCore: { [flag]: true } } }, async () => ({}));
        },
      };
      await expect(createHarness({ modules: [bad], database: db() })).rejects.toThrow(/must not be exempt/);
    });
  }

  it("SEC-AUTH-14 applies to DELETE without a body (custom header and Origin still required)", async () => {
    const { app } = await harness();
    const missing = await app.inject({ method: "DELETE", url: "/api/v1/probe/item", headers: { origin: ORIGIN } });
    expect(missing.json().error.code).toBe("CSRF_REJECTED");
    const ok = await app.inject({ method: "DELETE", url: "/api/v1/probe/item", headers: { origin: ORIGIN, "x-pine-csrf": "1" } });
    expect(ok.statusCode).toBe(200);
  });

  it("SEC-AUTH-14 applies to unsafe requests on unmatched routes", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "POST", url: "/api/v1/nope", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(res.json().error.code).toBe("CSRF_REJECTED");
  });

  it("accepts multipart only on a flagged route (SEC-AUTH-14)", async () => {
    const { app } = await harness();
    const boundary = "----pineboundary";
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`;
    const ok = await app.inject({ method: "POST", url: "/api/v1/probe/upload", headers: csrfHeaders({ "content-type": `multipart/form-data; boundary=${boundary}` }), payload: body });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ size: 5 });
    const json = await app.inject({ method: "POST", url: "/api/v1/probe/upload", headers: csrfHeaders(), payload: "{}" });
    expect(json.json().error.code).toBe("CSRF_REJECTED");
    const crossSite = await app.inject({ method: "POST", url: "/api/v1/probe/upload", headers: csrfHeaders({ "content-type": `multipart/form-data; boundary=${boundary}`, "sec-fetch-site": "cross-site" }), payload: body });
    expect(crossSite.json().error.code).toBe("CSRF_REJECTED");
  });

  it("unit: media type parsing and body detection", () => {
    expect(mediaType("Application/JSON ; charset=UTF-8")).toBe("application/json");
    expect(checkCsrf({ origin: ORIGIN, "x-pine-csrf": "1", "content-length": "0" }, { publicOrigin: ORIGIN, multipart: false })).toBeNull();
    expect(checkCsrf({ origin: ORIGIN, "x-pine-csrf": "1", "transfer-encoding": "chunked" }, { publicOrigin: ORIGIN, multipart: false })).toBe("content_type");
  });
});

describe("security headers (SEC-OPS-08)", () => {
  it("sets CSP, nosniff, referrer policy, COOP and no-store; no X-Powered-By; no HSTS outside production", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/v1/probe/private" });
    expect(res.headers["content-security-policy"]).toBe("default-src 'none';frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  it("sends HSTS in production", async () => {
    const { app } = await harness({ config: { environment: "production" } });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  });
});

describe("public routes and CORS (SEC-AUTH-16)", () => {
  it("public routes ignore cookies, get ACAO * and never credentials", async () => {
    const { app } = await harness();
    const user = await signIn(current(), testAccount(1));
    const res = await app.inject({ method: "GET", url: "/api/v1/probe/public", headers: { cookie: user.cookie, origin: "https://attacker.example" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hasSession: false });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("public routes never read cookies: no session lookup or identityOf call happens", async () => {
    const { app, githubAuth } = await harness();
    const user = await signIn(current(), testAccount(1));
    githubAuth.calls.length = 0;
    await app.inject({ method: "GET", url: "/api/v1/probe/public", headers: { cookie: user.cookie } });
    expect(githubAuth.calls).toEqual([]);
  });

  it("SEC-AUTH-16 credentialed routes never carry CORS headers, even for an attacker Origin", async () => {
    const { app } = await harness();
    const user = await signIn(current(), testAccount(1));
    const res = await app.inject({ method: "GET", url: "/api/v1/probe/private", headers: { cookie: user.cookie, origin: "https://attacker.example" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("SEC-AUTH-16 OPTIONS is not routed and never yields Access-Control-Allow-Credentials", async () => {
    const { app } = await harness();
    for (const url of ["/api/v1/probe/public", "/api/v1/probe/private", "/api/v1/probe/echo"]) {
      const res = await app.inject({ method: "OPTIONS", url, headers: { origin: "https://attacker.example", "access-control-request-method": "POST" } });
      expect(res.statusCode).toBe(404);
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("refuses to start when a module declares a public non-GET route", async () => {
    const bad: RouteModule = {
      name: "bad",
      async register(app) {
        app.post("/api/v1/bad", { config: { pine: { public: true } } }, async () => ({}));
      },
    };
    await expect(createHarness({ modules: [bad], database: db() })).rejects.toThrow(/GET\/HEAD only/);
  });

  it("refuses to start when a module sets config.rateLimit", async () => {
    const bad: RouteModule = {
      name: "bad",
      async register(app) {
        app.get("/api/v1/bad", { config: { rateLimit: { max: 1 } } }, async () => ({}));
      },
    };
    await expect(createHarness({ modules: [bad], database: db() })).rejects.toThrow(/config.rateLimit/);
  });
});

describe("errors (SEC-OPS-03)", () => {
  it("never returns secrets from an internal error and logs it redacted", async () => {
    const { app, logs } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/v1/probe/secret-error" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatchObject({ code: "INTERNAL", message: "Internal error" });
    expect(res.body).not.toContain(TEST_SECRET);
    expect(res.body).not.toContain(SESSION_TOKEN_IN_ERROR);
    const joined = logs.join("\n");
    expect(joined).toContain("request failed");
    expect(joined).not.toContain(TEST_SECRET);
    expect(joined).not.toContain(SESSION_TOKEN_IN_ERROR);
  });

  it("redacts secrets inside ApiError messages", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/v1/probe/secret-api-error" });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(TEST_SECRET);
    expect(res.body).not.toContain(SESSION_TOKEN_IN_ERROR);
  });

  it("maps GitHub gateway errors to client codes, never 500", async () => {
    const { app } = await harness();
    const expected: Record<string, [number, string]> = {
      GITHUB_NOT_LINKED: [403, "FORBIDDEN"],
      REPO_NOT_PUBLIC: [422, "UNPROCESSABLE"],
      NOT_A_MEMBER: [422, "UNPROCESSABLE"],
      NOT_FOUND: [404, "NOT_FOUND"],
      RATE_LIMITED: [429, "RATE_LIMITED"],
      UPSTREAM: [502, "UPSTREAM_UNAVAILABLE"],
    };
    for (const [code, [status, apiCode]] of Object.entries(expected)) {
      const res = await app.inject({ method: "GET", url: `/api/v1/probe/github/${code}` });
      expect(res.statusCode, code).toBe(status);
      expect(res.json().error.code).toBe(apiCode);
    }
  });

  it("uses server-generated request ids, never a client header", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/v1/probe/secret-error", headers: { "request-id": "attacker-id", "x-request-id": "attacker-id" } });
    expect(res.json().error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("SEC-OPS-09 rejects a __proto__ payload with 400", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "POST", url: "/api/v1/probe/echo", headers: csrfHeaders(), payload: '{"value":"x","__proto__":{"admin":true}}' });
    expect(res.statusCode).toBe(400);
  });

  it("SEC-OPS-09 rejects JSON bodies over 64 KiB", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "POST", url: "/api/v1/probe/echo", headers: csrfHeaders(), payload: JSON.stringify({ value: "x".repeat(70_000) }) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("answers unknown routes with the error body", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/v1/unknown" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});

describe("logging (SEC-OPS-03)", () => {
  it("log lines contain no query strings, cookies, CSRF header values or OAuth codes", async () => {
    const { app, logs } = await harness();
    const user = await signIn(current(), testAccount(1));
    await app.inject({ method: "GET", url: "/api/v1/auth/github/callback?code=oauth-code-secret-123&state=oauth-state-secret-456", headers: { cookie: user.cookie } });
    await app.inject({ method: "GET", url: "/api/v1/probe/private?token=query-secret-789", headers: { cookie: user.cookie, authorization: "Bearer bearer-secret-abcdef" } });
    const joined = logs.join("\n");
    expect(joined).toContain("request completed");
    expect(joined).toContain('"path":"/api/v1/probe/private"');
    for (const needle of ["oauth-code-secret-123", "oauth-state-secret-456", "query-secret-789", "bearer-secret-abcdef", user.token, "pine_s1_", "?"]) {
      expect(joined, needle).not.toContain(needle);
    }
  });
});

describe("per-IP flood guard (first onRequest hook)", () => {
  it("limits per IP before CSRF and the session lookup, including unmatched routes", async () => {
    const { app, githubAuth, database } = await harness({ settings: { ipFloodLimitPerMinute: 3 } });
    // A VALID session (signed in from another IP): a session lookup would call identityOf and touch the user window.
    const user = await signIn(current(), testAccount(1));
    await database.sql.exec("DELETE FROM rate_limit_windows");
    githubAuth.calls.length = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await app.inject({ method: "GET", url: "/api/v1/unknown", remoteAddress: "10.0.0.1" })).statusCode);
    const limited = await app.inject({ method: "POST", url: "/api/v1/probe/echo", remoteAddress: "10.0.0.1", headers: { cookie: user.cookie } });
    expect(statuses).toEqual([404, 404, 404]);
    // 429, not CSRF_REJECTED: the flood guard runs before CSRF.
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // ...and before the session lookup and the Postgres windows.
    expect(githubAuth.calls).toEqual([]);
    expect(await database.sql.query("SELECT key FROM rate_limit_windows")).toEqual([]);
    const other = await app.inject({ method: "GET", url: "/healthz", remoteAddress: "10.0.0.2" });
    expect(other.statusCode).toBe(200);
  });

  it("SEC-OPS-04 a spoofed X-Forwarded-For from a non-proxy peer does not change the bucket", async () => {
    const { app } = await harness({ settings: { ipFloodLimitPerMinute: 2 } });
    for (let i = 0; i < 2; i += 1) await app.inject({ method: "GET", url: "/healthz", remoteAddress: "10.0.0.9", headers: { "x-forwarded-for": `192.0.2.${i}` } });
    const res = await app.inject({ method: "GET", url: "/healthz", remoteAddress: "10.0.0.9", headers: { "x-forwarded-for": "192.0.2.77" } });
    expect(res.statusCode).toBe(429);
  });
});

describe("metrics stay off the public app (PRD-02 2.4)", () => {
  it("GET /metrics and /api/metrics on the main app are 404 without metric text", async () => {
    const { app, ctx } = await harness();
    ctx.metrics.increment("http_errors", { code: "X" });
    for (const url of ["/metrics", "/api/metrics", "/api/v1/metrics"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toMatch(/# (HELP|TYPE)|pine_/);
    }
  });
});

describe("openapi", () => {
  it("serves /api/openapi.json publicly", async () => {
    const { app } = await harness();
    const res = await app.inject({ method: "GET", url: "/api/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(res.json().openapi).toMatch(/^3\./);
    expect(res.json().paths["/api/v1/auth/siwe/challenge"]).toBeDefined();
  });
});

it("buildApp is importable without starting a listener", () => {
  expect(typeof buildApp).toBe("function");
});
