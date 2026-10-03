// Must stay the first import: blocks this file until no other PGlite-backed core test file runs.
import "./testing/suite-lock.js";
import type { FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ComplianceAction, RouteModule, SessionInfo } from "../../contracts/app.js";
import { createRedactor } from "../../contracts/redact.js";
import { testSession } from "../../contracts/testing.js";
import { PostgresAuditLog } from "./audit.js";
import { PlatformCompliance, requestCountry, type ComplianceDeps } from "./compliance.js";
import { createHarness, csrfHeaders, signIn, TEST_TERMS_DIGEST, testAccount, testSettings, useSharedDatabase, type CoreHarness } from "./testing/harness.js";

const db = useSharedDatabase({ beforeAll, afterAll, beforeEach });
let h: CoreHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const SANCTIONED = testAccount(0x5a);
const alice = testAccount(0xa11ce);

function request(headers: Record<string, string> = {}): FastifyRequest {
  return { headers, ip: "203.0.113.4" } as unknown as FastifyRequest;
}

function compliance(overrides: Partial<ComplianceDeps> = {}, blocked: Partial<Record<ComplianceAction, string[]>> = {}): PlatformCompliance {
  const settings = testSettings();
  return new PlatformCompliance({
    db: db().db,
    audit: new PostgresAuditLog(db().db, createRedactor()),
    environment: "test",
    termsDigest: TEST_TERMS_DIGEST,
    trustProxyHops: 1,
    compliance: {
      ...settings.compliance,
      countryHeader: "cf-ipcountry",
      blockedCountries: { ...settings.compliance.blockedCountries, ...Object.fromEntries(Object.entries(blocked).map(([action, list]) => [action, new Set(list)])) },
    },
    sanctions: { mode: "static", blockedWallets: new Set([SANCTIONED.address.toLowerCase()]) },
    ...overrides,
  });
}

async function signedInSession(seedAccount = alice): Promise<SessionInfo> {
  h = await createHarness({ database: db() });
  const user = await signIn(h, seedAccount);
  return testSession({ userId: user.userId, wallet: user.address, sessionId: "00000000-0000-4000-8000-0000000000ff" });
}

async function refusals(): Promise<{ reason: string; action: string }[]> {
  return db().sql.query("SELECT details->>'reason' AS reason, details->>'action' AS action FROM audit_log WHERE action = 'compliance.refused' ORDER BY id");
}

describe("compliance (SEC-LEGAL-01..03)", () => {
  it("allows a user with current terms from an allowed country", async () => {
    const session = await signedInSession();
    await expect(compliance().assertAllowed(request({ "cf-ipcountry": "DE" }), session, "publish_claim")).resolves.toBeUndefined();
  });

  it("SEC-LEGAL-02 refuses a wallet on the sanctions denylist with 451 and audits", async () => {
    const session = await signedInSession(SANCTIONED);
    await expect(compliance().assertAllowed(request({ "cf-ipcountry": "DE" }), session, "fund_market")).rejects.toMatchObject({ code: "UNAVAILABLE_FOR_LEGAL_REASONS", statusCode: 451 });
    expect(await refusals()).toEqual([{ reason: "sanctions", action: "fund_market" }]);
  });

  it("SEC-LEGAL-01 refuses a blocked country for the configured action only", async () => {
    const session = await signedInSession();
    const gate = compliance({}, { fund_market: ["US"] });
    await expect(gate.assertAllowed(request({ "cf-ipcountry": "us" }), session, "fund_market")).rejects.toMatchObject({ statusCode: 451 });
    await expect(gate.assertAllowed(request({ "cf-ipcountry": "US" }), session, "redeem")).resolves.toBeUndefined();
    expect(await refusals()).toEqual([{ reason: "geofence", action: "fund_market" }]);
  });

  it("SEC-LEGAL-01 ignores the country header unless trustProxy is configured", async () => {
    const session = await signedInSession();
    const gate = compliance({ trustProxyHops: 0 }, { fund_market: ["US"] });
    await expect(gate.assertAllowed(request({ "cf-ipcountry": "US" }), session, "fund_market")).resolves.toBeUndefined();
    expect(requestCountry(request({ "cf-ipcountry": "US" }), { trustProxyHops: 0, compliance: testSettings().compliance })).toBeNull();
  });

  it("SEC-LEGAL-01 fails closed in production when the country is unknown for publish and fund", async () => {
    const session = await signedInSession();
    const gate = compliance({ environment: "production" });
    for (const headers of [{}, { "cf-ipcountry": "XX" }, { "cf-ipcountry": "T1" }, { "cf-ipcountry": "not-a-country" }]) {
      await expect(gate.assertAllowed(request(headers), session, "fund_market")).rejects.toMatchObject({ statusCode: 451 });
      await expect(gate.assertAllowed(request(headers), session, "publish_claim")).rejects.toMatchObject({ statusCode: 451 });
      await expect(gate.assertAllowed(request(headers), session, "submit_evidence")).resolves.toBeUndefined();
    }
    await expect(compliance({ environment: "staging" }).assertAllowed(request({}), session, "fund_market")).resolves.toBeUndefined();
  });

  it("SEC-LEGAL-03 TERMS_REQUIRED without an acceptance of the current terms digest", async () => {
    const session = await signedInSession();
    await expect(compliance({ termsDigest: `0x${"11".repeat(32)}` }).assertAllowed(request({ "cf-ipcountry": "DE" }), session, "publish_claim")).rejects.toMatchObject({
      code: "TERMS_REQUIRED",
      statusCode: 403,
    });
    const stranger = testSession({ userId: "00000000-0000-4000-8000-0000000000cc" });
    await expect(compliance().assertAllowed(request({ "cf-ipcountry": "DE" }), stranger, "redeem")).rejects.toMatchObject({ code: "TERMS_REQUIRED" });
  });

  it("records the country of the acceptance when the trusted header is present (SEC-LEGAL-03)", async () => {
    h = await createHarness({ database: db(), settings: { trustProxyHops: 1, compliance: { ...testSettings().compliance, countryHeader: "cf-ipcountry" } } });
    await signIn(h, alice, { "cf-ipcountry": "FR" });
    expect(await db().sql.query("SELECT country FROM terms_acceptances")).toEqual([{ country: "FR" }]);
  });

  it("SEC-LEGAL-01/02 ctx.compliance and ctx.quotas are built from the configured settings (createCoreServices)", async () => {
    const gated: RouteModule = {
      name: "gated",
      async register(app, ctx) {
        app.post("/api/v1/probe/gated", { preHandler: app.requireSession }, async (request) => {
          const session = request.session;
          if (!session) throw new Error("unreachable");
          await ctx.compliance.assertAllowed(request, session, "fund_market");
          await ctx.quotas.consume(session.userId, "publications_per_day");
          return { ok: true };
        });
      },
    };
    const settings = testSettings();
    h = await createHarness({
      database: db(),
      modules: [gated],
      config: { environment: "production" },
      settings: {
        trustProxyHops: 1,
        sanctions: { mode: "static", blockedWallets: new Set([SANCTIONED.address.toLowerCase()]) },
        compliance: { ...settings.compliance, countryHeader: "cf-ipcountry", blockedCountries: { ...settings.compliance.blockedCountries, fund_market: new Set(["US"]) } },
        quotas: { ...settings.quotas, publications_per_day: { limit: 1, windowSeconds: 86_400 } },
      },
    });
    const hh = h;
    const sanctioned = await signIn(hh, SANCTIONED);
    const user = await signIn(hh, alice);
    const call = (cookie: string, country?: string) =>
      hh.app.inject({ method: "POST", url: "/api/v1/probe/gated", headers: csrfHeaders({ cookie, ...(country ? { "cf-ipcountry": country } : {}) }), payload: {} });
    expect((await call(sanctioned.cookie, "DE")).statusCode).toBe(451);
    expect((await call(user.cookie, "US")).statusCode).toBe(451);
    expect((await call(user.cookie)).statusCode).toBe(451);
    expect(await refusals()).toEqual([
      { reason: "sanctions", action: "fund_market" },
      { reason: "geofence", action: "fund_market" },
      { reason: "country_unknown", action: "fund_market" },
    ]);
    // Terms digest of the settings: the sign-in accepted it, so an allowed country passes; the quota limit is 1.
    expect((await call(user.cookie, "DE")).statusCode).toBe(200);
    const second = await call(user.cookie, "DE");
    expect(second.json().error.code).toBe("QUOTA_EXCEEDED");
  });
});
