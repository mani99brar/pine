// Must stay the first import: blocks this file until no other PGlite-backed core test file runs.
import "./testing/suite-lock.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RouteModule } from "../../contracts/app.js";
import { lookupSession, rotateSession } from "./sessions.js";
import { bodylessCsrfHeaders, cookieValue, createHarness, csrfHeaders, signIn, testAccount, useSharedDatabase, type CoreHarness } from "./testing/harness.js";

const db = useSharedDatabase({ beforeAll, afterAll, beforeEach });
let h: CoreHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const whoami: RouteModule = {
  name: "whoami",
  async register(app) {
    app.get("/api/v1/whoami", { preHandler: app.requireSession }, async (request) => ({ session: request.session }));
    app.post("/api/v1/admin/probe", { preHandler: app.requireAdmin }, async () => ({ ok: true }));
  },
};

async function harness(options: Parameters<typeof createHarness>[0] = {}): Promise<CoreHarness> {
  h = await createHarness({ database: db(), modules: [whoami], ...options });
  return h;
}

const alice = testAccount(0xa11ce);
const admin = testAccount(0xad);
const HOUR = 3_600_000;

async function status(app: CoreHarness["app"], cookie: string): Promise<number> {
  return (await app.inject({ method: "GET", url: "/api/v1/whoami", headers: { cookie } })).statusCode;
}

describe("GET /api/v1/auth/session", () => {
  it("SEC-LEGAL-03 reports wallet, admin flag, expiries and terms status; a new terms digest needs re-acceptance", async () => {
    const hh = await harness({ settings: { adminWallets: new Set([admin.address.toLowerCase()]) } });
    const user = await signIn(hh, alice);
    const boss = await signIn(hh, admin);
    const view = async (app: CoreHarness["app"], cookie: string) => (await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie } })).json<Record<string, unknown>>();
    const row = (await hh.database.sql.query<{ idle_expires_at: Date; absolute_expires_at: Date; authenticated_at: Date }>(
      "SELECT idle_expires_at, absolute_expires_at, authenticated_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.wallet_address = $1",
      [alice.address.toLowerCase()],
    ))[0];
    expect(await view(hh.app, user.cookie)).toEqual({
      wallet: alice.address.toLowerCase(),
      githubUserId: null,
      githubLogin: null,
      isAdmin: false,
      termsDigest: hh.settings.termsDigest,
      termsAccepted: true,
      authenticatedAt: new Date(row?.authenticated_at ?? 0).toISOString(),
      idleExpiresAt: new Date(row?.idle_expires_at ?? 0).toISOString(),
      absoluteExpiresAt: new Date(row?.absolute_expires_at ?? 0).toISOString(),
    });
    expect((await view(hh.app, boss.cookie)).isAdmin).toBe(true);
    // The operator publishes new terms: the same session must accept them again.
    const rotated = await createHarness({ database: db(), modules: [whoami], settings: { termsDigest: `0x${"5e".repeat(32)}` } });
    try {
      const after = await view(rotated.app, user.cookie);
      expect(after).toMatchObject({ termsAccepted: false, termsDigest: `0x${"5e".repeat(32)}` });
    } finally {
      await rotated.close();
    }
  });
});

describe("session expiry (SEC-AUTH-12)", () => {
  it("SEC-AUTH-12 an idle session expires after 24 h (valid at -1 s, refused at the boundary)", async () => {
    const { app, clock } = await harness();
    const a = await signIn(h!, alice);
    const b = await signIn(h!, alice);
    clock.advance(24 * HOUR - 1_000);
    expect(await status(app, a.cookie)).toBe(200);
    clock.advance(1_000);
    expect(await status(app, b.cookie)).toBe(401);
  });

  it("touches the idle expiry at most once per 5 minutes", async () => {
    const { clock, database } = await harness();
    const a = await signIn(h!, alice);
    const read = async () => (await database.sql.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM sessions"))[0]?.last_seen_at.getTime();
    const start = await read();
    clock.advance(4 * 60_000);
    expect(await status(h!.app, a.cookie)).toBe(200);
    expect(await read()).toBe(start);
    clock.advance(2 * 60_000);
    expect(await status(h!.app, a.cookie)).toBe(200);
    expect(await read()).toBe(clock.now().getTime());
  });

  it("SEC-AUTH-12 an active session still expires at the 7-day absolute limit", async () => {
    const { app, clock } = await harness();
    const a = await signIn(h!, alice);
    for (let day = 0; day < 7; day += 1) {
      clock.advance(23 * HOUR);
      expect(await status(app, a.cookie)).toBe(200);
    }
    clock.advance(7 * 24 * HOUR - 7 * 23 * HOUR - 1_000);
    expect(await status(app, a.cookie)).toBe(200);
    clock.advance(1_000);
    expect(await status(app, a.cookie)).toBe(401);
  });

  it("rejects malformed and unknown session cookies without a GitHub lookup", async () => {
    const { app, githubAuth } = await harness();
    githubAuth.calls.length = 0;
    expect(await status(app, "__Host-pine_session=not-a-token")).toBe(401);
    expect(await status(app, `__Host-pine_session=pine_s1_${"Z".repeat(43)}`)).toBe(401);
    expect(githubAuth.calls).toEqual([]);
  });

  it("fills the GitHub identity through identityOf on every request", async () => {
    const { app, githubAuth } = await harness();
    const a = await signIn(h!, alice);
    githubAuth.identities.set(a.userId, { githubUserId: 42, login: "alice-gh" });
    const res = await app.inject({ method: "GET", url: "/api/v1/whoami", headers: { cookie: a.cookie } });
    expect(res.json().session).toMatchObject({ userId: a.userId, wallet: a.address, githubUserId: 42, githubLogin: "alice-gh", isAdmin: false });
    expect(JSON.stringify(res.json())).not.toContain(a.token);
  });
});

describe("logout (SEC-AUTH-13)", () => {
  it("SEC-AUTH-13 a cookie used after logout gets 401 and the cookie is cleared", async () => {
    const { app } = await harness();
    const a = await signIn(h!, alice);
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: bodylessCsrfHeaders({ cookie: a.cookie }) });
    expect(res.statusCode, res.body).toBe(204);
    expect(String(res.headers["set-cookie"])).toMatch(/__Host-pine_session=;/);
    expect(await status(app, a.cookie)).toBe(401);
  });

  it("SEC-AUTH-13 log out everywhere deletes every session of the user", async () => {
    const { app } = await harness();
    const a = await signIn(h!, alice);
    const b = await signIn(h!, alice);
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: csrfHeaders({ cookie: a.cookie }), payload: { everywhere: true } });
    expect(res.statusCode).toBe(204);
    expect(await status(app, a.cookie)).toBe(401);
    expect(await status(app, b.cookie)).toBe(401);
  });

  it("SEC-AUTH-14 logout requires the CSRF header", async () => {
    const { app } = await harness();
    const a = await signIn(h!, alice);
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: a.cookie, origin: "https://app.pine.test" } });
    expect(res.json().error.code).toBe("CSRF_REJECTED");
    expect(await status(app, a.cookie)).toBe(200);
  });
});

describe("rotation (SEC-AUTH-11)", () => {
  it("SEC-AUTH-11 rotation issues a new token, invalidates the old one and keeps authenticatedAt and the absolute expiry", async () => {
    const { clock, database } = await harness();
    const a = await signIn(h!, alice);
    const before = await lookupSession(database.db, a.token, clock.now());
    clock.advance(HOUR);
    const rotated = await rotateSession(database.db, before?.sessionId ?? "", clock.now());
    expect(rotated).not.toBeNull();
    expect(rotated?.token).not.toBe(a.token);
    expect(rotated?.session.authenticatedAt.getTime()).toBe(before?.authenticatedAt.getTime());
    expect(rotated?.session.absoluteExpiresAt.getTime()).toBe(before?.absoluteExpiresAt.getTime());
    expect(await lookupSession(database.db, a.token, clock.now())).toBeNull();
  });

  it("linking GitHub rotates the session but never refreshes the admin step-up window", async () => {
    const { app, clock, githubAuth } = await harness({ settings: { adminWallets: new Set([admin.address.toLowerCase()]) } });
    const a = await signIn(h!, admin);
    clock.advance(200_000);
    const start = await app.inject({ method: "POST", url: "/api/v1/auth/github/start", headers: bodylessCsrfHeaders({ cookie: a.cookie }) });
    const state = new URL(start.json<{ authorizationUrl: string }>().authorizationUrl).searchParams.get("state") ?? "";
    githubAuth.codes.set("good-code", { githubUserId: 7, login: "admin-gh" });
    const callback = await app.inject({ method: "GET", url: `/api/v1/auth/github/callback?code=good-code&state=${state}`, headers: { cookie: a.cookie } });
    expect(callback.statusCode).toBe(303);
    const rotated = cookieValue(callback.headers["set-cookie"], "__Host-pine_session");
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(a.token);
    expect(await status(app, a.cookie)).toBe(401);
    const newCookie = `__Host-pine_session=${rotated}`;
    const fresh = await app.inject({ method: "POST", url: "/api/v1/admin/probe", headers: bodylessCsrfHeaders({ cookie: newCookie }) });
    expect(fresh.statusCode).toBe(200);
    clock.advance(101_000);
    const stale = await app.inject({ method: "POST", url: "/api/v1/admin/probe", headers: bodylessCsrfHeaders({ cookie: newCookie }) });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error.code).toBe("STEP_UP_REQUIRED");
  });
});

describe("admin step-up (SEC-AUTH-21)", () => {
  it("SEC-AUTH-21 requireAdmin: 401 without a session, 403 for non-admins, STEP_UP_REQUIRED after 300 s", async () => {
    const { app, clock } = await harness({ settings: { adminWallets: new Set([admin.address.toLowerCase()]) } });
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/probe", headers: bodylessCsrfHeaders() })).json().error.code).toBe("UNAUTHENTICATED");
    const user = await signIn(h!, alice);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/probe", headers: bodylessCsrfHeaders({ cookie: user.cookie }) })).json().error.code).toBe("FORBIDDEN");
    const a = await signIn(h!, admin);
    clock.advance(300_000);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/probe", headers: bodylessCsrfHeaders({ cookie: a.cookie }) })).statusCode).toBe(200);
    clock.advance(1_000);
    const res = await app.inject({ method: "POST", url: "/api/v1/admin/probe", headers: bodylessCsrfHeaders({ cookie: a.cookie }) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("STEP_UP_REQUIRED");
    const again = await signIn(h!, admin);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/probe", headers: bodylessCsrfHeaders({ cookie: again.cookie }) })).statusCode).toBe(200);
  });

  it("SEC-AUTH-21 removing a wallet from the allowlist revokes admin on the next request", async () => {
    const wallets = new Set([admin.address.toLowerCase()]);
    const { app } = await harness({ settings: { adminWallets: wallets } });
    const a = await signIn(h!, admin);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/probe", headers: bodylessCsrfHeaders({ cookie: a.cookie }) })).statusCode).toBe(200);
    wallets.delete(admin.address.toLowerCase());
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/probe", headers: bodylessCsrfHeaders({ cookie: a.cookie }) })).json().error.code).toBe("FORBIDDEN");
  });
});
