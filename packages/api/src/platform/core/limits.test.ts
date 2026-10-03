// Must stay the first import: blocks this file until no other PGlite-backed core test file runs.
import "./testing/suite-lock.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RouteModule } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { FakeClock } from "../../contracts/testing.js";
import { consumeRateLimits, ipBucket, PostgresQuotas, secondsUntilWindowEnd } from "./limits.js";
import { createHarness, csrfHeaders, signIn, testAccount, testSettings, useSharedDatabase, type CoreHarness } from "./testing/harness.js";

const db = useSharedDatabase({ beforeAll, afterAll, beforeEach });
let h: CoreHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const limitedModule: RouteModule = {
  name: "limited",
  async register(app) {
    app.get("/api/v1/limited", { config: { pine: { rateLimitPerMinute: 2 } } }, async () => ({ ok: true }));
    app.get("/api/v1/open", async () => ({ ok: true }));
    app.get("/api/v1/feed", { config: { pine: { public: true, rateLimitPerMinute: 3 } } }, async () => ({ ok: true }));
  },
};

async function harness(options: Parameters<typeof createHarness>[0] = {}): Promise<CoreHarness> {
  h = await createHarness({ database: db(), modules: [limitedModule], ...options });
  return h;
}

async function keys(hh: CoreHarness): Promise<Record<string, number>> {
  const rows = await hh.database.sql.query<{ key: string; count: number }>("SELECT key, count FROM rate_limit_windows ORDER BY key");
  return Object.fromEntries(rows.map((row) => [row.key, row.count]));
}

describe("quotas", () => {
  async function user(hh: CoreHarness, seed: number): Promise<string> {
    return (await signIn(hh, testAccount(seed))).userId;
  }

  it("consumes atomically up to the limit, then QUOTA_EXCEEDED with Retry-After and nothing consumed", async () => {
    const hh = await harness();
    const userId = await user(hh, 1);
    const quotas = new PostgresQuotas(hh.database.db, hh.clock, { ...testSettings().quotas, publications_per_day: { limit: 3, windowSeconds: 86_400 } });
    await quotas.consume(userId, "publications_per_day");
    await quotas.consume(userId, "publications_per_day", 2);
    const error = await quotas.consume(userId, "publications_per_day").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "QUOTA_EXCEEDED", retryAfterSeconds: 86_400 });
    const rows = await hh.database.sql.query<{ used: string }>("SELECT used::text AS used FROM quota_usage");
    expect(rows).toEqual([{ used: "3" }]);
  });

  it("refuses an amount larger than the limit without writing, and separates users and quota names", async () => {
    const hh = await harness();
    const a = await user(hh, 1);
    const b = await user(hh, 2);
    const quotas = new PostgresQuotas(hh.database.db, hh.clock, { ...testSettings().quotas, evidence_bytes_per_day: { limit: 100, windowSeconds: 86_400 } });
    await expect(quotas.consume(a, "evidence_bytes_per_day", 101)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(await hh.database.sql.query("SELECT * FROM quota_usage")).toEqual([]);
    await quotas.consume(a, "evidence_bytes_per_day", 100);
    await quotas.consume(b, "evidence_bytes_per_day", 100);
    await quotas.consume(a, "plans_per_day", 1);
    await expect(quotas.consume(a, "evidence_bytes_per_day", 1)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("a new fixed window starts after the window ends", async () => {
    const hh = await harness();
    const a = await user(hh, 1);
    const quotas = new PostgresQuotas(hh.database.db, hh.clock, { ...testSettings().quotas, github_calls_per_hour: { limit: 1, windowSeconds: 3_600 } });
    await quotas.consume(a, "github_calls_per_hour");
    hh.clock.advance(30 * 60_000);
    await expect(quotas.consume(a, "github_calls_per_hour")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", retryAfterSeconds: 1_800 });
    hh.clock.advance(30 * 60_000);
    await expect(quotas.consume(a, "github_calls_per_hour")).resolves.toBeUndefined();
  });

  it("rejects invalid amounts", async () => {
    const hh = await harness();
    const quotas = new PostgresQuotas(hh.database.db, hh.clock, testSettings().quotas);
    await expect(quotas.consume("00000000-0000-4000-8000-000000000001", "plans_per_day", 0)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(quotas.consume("00000000-0000-4000-8000-000000000001", "plans_per_day", 1.5)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("computes Retry-After to the end of the window", () => {
    const clock = new FakeClock(new Date("2026-10-01T00:59:30Z"));
    expect(secondsUntilWindowEnd(clock.now(), 3_600)).toBe(30);
  });
});

describe("rate-limit keys", () => {
  it("an authenticated request is keyed by user id (plus the route key when the route sets a limit)", async () => {
    const hh = await harness();
    const user = await signIn(hh, testAccount(1));
    await hh.database.sql.exec("DELETE FROM rate_limit_windows");
    await hh.app.inject({ method: "GET", url: "/api/v1/open", headers: { cookie: user.cookie }, remoteAddress: "10.1.1.1" });
    await hh.app.inject({ method: "GET", url: "/api/v1/limited", headers: { cookie: user.cookie }, remoteAddress: "10.1.1.1" });
    expect(await keys(hh)).toEqual({ [`user:${user.userId}`]: 2, [`user:${user.userId}:GET /api/v1/limited`]: 1 });
  });

  it("anonymous requests write nothing without a route limit and use ip:<ip>:<route> with one", async () => {
    const hh = await harness();
    await hh.app.inject({ method: "GET", url: "/api/v1/open", remoteAddress: "10.1.1.1" });
    expect(await keys(hh)).toEqual({});
    await hh.app.inject({ method: "GET", url: "/api/v1/limited", remoteAddress: "10.1.1.1" });
    await hh.app.inject({ method: "GET", url: "/api/v1/feed", remoteAddress: "10.1.1.1" });
    expect(await keys(hh)).toEqual({ "ip:10.1.1.1:GET /api/v1/limited": 1, "ip:10.1.1.1:GET /api/v1/feed": 1 });
  });

  it("enforces the per-route limit per user, and the per-user limit across routes", async () => {
    const hh = await harness({ settings: { userRateLimitPerMinute: 4 } });
    const user = await signIn(hh, testAccount(1));
    await hh.database.sql.exec("DELETE FROM rate_limit_windows");
    const get = (url: string) => hh.app.inject({ method: "GET", url, headers: { cookie: user.cookie } });
    expect((await get("/api/v1/limited")).statusCode).toBe(200);
    expect((await get("/api/v1/limited")).statusCode).toBe(200);
    const third = await get("/api/v1/limited");
    expect(third.statusCode).toBe(429);
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
    // The refused request consumed nothing (all-or-nothing), so two of the four per-user requests remain.
    expect(await keys(hh)).toEqual({ [`user:${user.userId}`]: 2, [`user:${user.userId}:GET /api/v1/limited`]: 2 });
    expect((await get("/api/v1/open")).statusCode).toBe(200);
    expect((await get("/api/v1/open")).statusCode).toBe(200);
    expect((await get("/api/v1/open")).statusCode).toBe(429);
    hh.clock.advance(60_000);
    expect((await get("/api/v1/open")).statusCode).toBe(200);
  });

  it("is all-or-nothing: a refused statement increments none of its keys", async () => {
    const hh = await harness();
    const now = hh.clock.now();
    await consumeRateLimits(hh.database.db, now, [
      { key: "a", limit: 1 },
      { key: "b", limit: 5 },
    ]);
    const refused = await consumeRateLimits(hh.database.db, now, [
      { key: "a", limit: 1 },
      { key: "b", limit: 5 },
      { key: "c", limit: 5 },
    ]).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "RATE_LIMITED" });
    expect(await keys(hh)).toEqual({ a: 1, b: 1 });
    await consumeRateLimits(hh.database.db, now, [
      { key: "b", limit: 5 },
      { key: "c", limit: 5 },
    ]);
    expect(await keys(hh)).toEqual({ a: 1, b: 2, c: 1 });
  });

  it("a request refused by the per-user window does not consume its per-route window", async () => {
    const hh = await harness({ settings: { userRateLimitPerMinute: 2 } });
    const user = await signIn(hh, testAccount(1));
    await hh.database.sql.exec("DELETE FROM rate_limit_windows");
    const get = (url: string) => hh.app.inject({ method: "GET", url, headers: { cookie: user.cookie } });
    expect((await get("/api/v1/open")).statusCode).toBe(200);
    expect((await get("/api/v1/open")).statusCode).toBe(200);
    expect((await get("/api/v1/limited")).statusCode).toBe(429);
    expect(await keys(hh)).toEqual({ [`user:${user.userId}`]: 2 });
  });

  it("SEC-OPS-04 with one trusted proxy hop the client IP comes from X-Forwarded-For", async () => {
    const hh = await harness({ settings: { trustProxyHops: 1 } });
    await hh.app.inject({ method: "GET", url: "/api/v1/limited", remoteAddress: "10.0.0.1", headers: { "x-forwarded-for": "203.0.113.5" } });
    expect(Object.keys(await keys(hh))).toEqual(["ip:203.0.113.5:GET /api/v1/limited"]);
  });
});

describe("SEC-OPS-04 client IP from exactly the configured proxy hops", () => {
  it("SEC-OPS-04 with one hop, client-supplied leftmost X-Forwarded-For entries are ignored", async () => {
    const hh = await harness({ settings: { trustProxyHops: 1 } });
    await hh.app.inject({ method: "GET", url: "/api/v1/limited", remoteAddress: "10.0.0.1", headers: { "x-forwarded-for": "192.0.2.66, 203.0.113.5" } });
    expect(Object.keys(await keys(hh))).toEqual(["ip:203.0.113.5:GET /api/v1/limited"]);
  });

  it("SEC-OPS-04 with two hops the client is the entry the second proxy appended", async () => {
    const hh = await harness({ settings: { trustProxyHops: 2 } });
    await hh.app.inject({ method: "GET", url: "/api/v1/limited", remoteAddress: "10.0.0.1", headers: { "x-forwarded-for": "192.0.2.66, 198.51.100.4, 10.0.0.2" } });
    expect(Object.keys(await keys(hh))).toEqual(["ip:198.51.100.4:GET /api/v1/limited"]);
  });

  it("SEC-OPS-04 the flood-guard bucket does not change when only spoofed leftmost entries vary", async () => {
    const hh = await harness({ settings: { trustProxyHops: 1, ipFloodLimitPerMinute: 2 } });
    const get = (xff: string) => hh.app.inject({ method: "GET", url: "/healthz", remoteAddress: "10.0.0.1", headers: { "x-forwarded-for": xff } });
    expect((await get("192.0.2.1, 203.0.113.5")).statusCode).toBe(200);
    expect((await get("192.0.2.2, 203.0.113.5")).statusCode).toBe(200);
    expect((await get("192.0.2.3, 203.0.113.5")).statusCode).toBe(429);
    expect((await get("192.0.2.3, 203.0.113.6")).statusCode).toBe(200);
  });

  it("SEC-OPS-04 a sign-in behind one hop records the proxied client IP in the audit log", async () => {
    const hh = await harness({ settings: { trustProxyHops: 1 } });
    await signIn(hh, testAccount(3), { "x-forwarded-for": "192.0.2.66, 203.0.113.9" });
    const rows = await hh.database.sql.query<{ ip: string | null }>("SELECT ip FROM audit_log WHERE action = 'auth.siwe.succeeded'");
    expect(rows).toEqual([{ ip: "203.0.113.9" }]);
  });
});

describe("SEC-AUTH-08 SIWE rate limits", () => {
  const address = (i: number) => `0x${(i + 1).toString(16).padStart(40, "0")}`;
  const challenge = (hh: CoreHarness, addr: string, ip: string) =>
    hh.app.inject({ method: "POST", url: "/api/v1/auth/siwe/challenge", headers: csrfHeaders(), payload: { address: addr }, remoteAddress: ip });
  const verify = (hh: CoreHarness, ip: string, message = "garbage") =>
    hh.app.inject({ method: "POST", url: "/api/v1/auth/siwe/verify", headers: csrfHeaders(), payload: { message, signature: "0x00" }, remoteAddress: ip });

  it("SEC-AUTH-08 the 21st challenge from one IP in a minute gets 429; another IP and another route are unaffected", async () => {
    const hh = await harness();
    for (let i = 0; i < 20; i += 1) expect((await challenge(hh, address(i), "198.51.100.1")).statusCode).toBe(200);
    const limited = await challenge(hh, address(20), "198.51.100.1");
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await challenge(hh, address(21), "198.51.100.2")).statusCode).toBe(200);
    expect((await verify(hh, "198.51.100.1")).statusCode).toBe(401);
    hh.clock.advance(60_000);
    expect((await challenge(hh, address(22), "198.51.100.1")).statusCode).toBe(200);
  });

  it("SEC-AUTH-08 the per-address challenge limit applies across IPs", async () => {
    const hh = await harness();
    const target = address(99);
    for (let i = 0; i < 20; i += 1) expect((await challenge(hh, target, `198.51.100.${i + 10}`)).statusCode).toBe(200);
    const limited = await challenge(hh, target, "198.51.100.200");
    expect(limited.statusCode).toBe(429);
    expect((await challenge(hh, address(98), "198.51.100.200")).statusCode).toBe(200);
  });

  it("SEC-AUTH-08 a challenge refused by the per-address window does not consume the IP window, and vice versa", async () => {
    const hh = await harness();
    const target = address(77);
    for (let i = 0; i < 20; i += 1) expect((await challenge(hh, target, `198.51.100.${i + 10}`)).statusCode).toBe(200);
    const rowCount = async (table: string) => (await hh.database.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0]?.n;
    const presessions = await rowCount("siwe_presessions");
    const nonces = await rowCount("siwe_nonces");
    expect((await challenge(hh, target, "198.51.100.250")).statusCode).toBe(429);
    const route = "POST /api/v1/auth/siwe/challenge";
    expect((await keys(hh))[`ip:198.51.100.250:${route}`]).toBeUndefined();
    // The refused challenge wrote no pre-session and no nonce.
    expect(await rowCount("siwe_presessions")).toBe(presessions);
    expect(await rowCount("siwe_nonces")).toBe(nonces);
    // The refused request left that IP's whole budget: 20 more challenges for other addresses succeed.
    for (let i = 0; i < 20; i += 1) expect((await challenge(hh, address(200 + i), "198.51.100.250")).statusCode).toBe(200);
    for (let i = 0; i < 20; i += 1) expect((await challenge(hh, address(100 + i), "198.51.100.251")).statusCode).toBe(200);
    expect((await challenge(hh, address(150), "198.51.100.251")).statusCode).toBe(429);
    const after = await keys(hh);
    expect(after[`siwe:${address(150)}`]).toBeUndefined();
    expect(after[`ip:198.51.100.251:${route}`]).toBe(20);
  });

  it("SEC-AUTH-08 verify is limited per IP the same way", async () => {
    const hh = await harness();
    for (let i = 0; i < 20; i += 1) expect((await verify(hh, "198.51.100.7")).statusCode).toBe(401);
    expect((await verify(hh, "198.51.100.7")).statusCode).toBe(429);
    expect((await verify(hh, "198.51.100.8")).statusCode).toBe(401);
  });

  it("SEC-AUTH-08 verify is limited per challenged address across IPs", async () => {
    const hh = await harness();
    const target = testAccount(7);
    const issued = await challenge(hh, target.address, "198.51.100.30");
    const message = issued.json<{ message: string }>().message;
    for (let i = 0; i < 19; i += 1) expect((await verify(hh, `198.51.100.${i + 40}`, message)).statusCode).toBe(401);
    const limited = await verify(hh, "198.51.100.90", message);
    expect(limited.statusCode).toBe(429);
  });
});

describe("ipBucket", () => {
  it("keeps IPv4 (also IPv4-mapped) and reduces IPv6 to its /64", () => {
    expect(ipBucket("203.0.113.5")).toBe("203.0.113.5");
    expect(ipBucket("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(ipBucket("2001:DB8:0001:0002:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8:1:2::")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
    expect(ipBucket("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipBucket("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
  });
});
