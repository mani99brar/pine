// Negative paths of PRD-06 section 3 through the whole backend: CSRF, stale and halted read model (NOT_READY), SC-001
// disabled, blocked content (451), compliance refusal (451), cookies ignored on public routes, and no secret in any
// response or captured log line (including an RPC outage whose error text embeds the provider URL and API key).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeEvidenceManifest, type EvidenceManifest } from "@pine/shared/evidence";
import type { Hex32 } from "@pine/shared/types";
import { ORACLE_CACHE_SECONDS } from "../../src/modules/markets/oracle.js";
import { Browser, createE2e, ORIGIN, type E2e } from "./support/app.js";
import { assertNoSecretLeaks, assertNoSecretsPersisted } from "./support/leaks.js";
import { account, createDraft, createPreview, draftBody, linkGitHub, mineCreateClaim, publishClaim, seedRepository, type PublishedClaim } from "./support/scenario.js";

let e2e: E2e;
let creator: Browser;
let researcher: Browser;
let admin: Browser;
let sanctioned: Browser;
let published: PublishedClaim;
const sessionTokens: string[] = [];

const ADMIN = account(0xad00001);
const SANCTIONED = account(0x5a0c7);

beforeAll(async () => {
  e2e = await createE2e({
    adminWallets: [ADMIN.address.toLowerCase() as `0x${string}`],
    blockedWallets: [SANCTIONED.address.toLowerCase() as `0x${string}`],
    // Defence in depth: even a (non-production) configuration that enables SC-001 cannot publish it.
    env: { PINE_ENABLED_POLICY_FAMILIES: "FUNC-001,BOT-001,SC-001" },
  });
  seedRepository(e2e);
  await e2e.chain.tick();
  creator = new Browser(e2e, account(0xc0ffee));
  researcher = new Browser(e2e, account(0xbeef01));
  admin = new Browser(e2e, ADMIN);
  sanctioned = new Browser(e2e, SANCTIONED);
  await creator.signIn();
  await linkGitHub(creator, { githubUserId: 9_001, login: "maintainer" });
  await researcher.signIn();
  sessionTokens.push(creator.session ?? "", researcher.session ?? "");
  published = await publishClaim(creator);
}, 30 * 60_000);

afterAll(async () => {
  await e2e?.close();
}, 120_000);

// A well-formed ladder request (risk acknowledged at the whole budget, SEC-LEGAL-03): refusals must come from readiness
// or compliance, never from validation.
const ladderBody = () => ({
  market: published.event.market,
  budgetWei: "1000000000000000000",
  lowerPrice: "0.05",
  upperPrice: "0.5",
  riskAcknowledgement: { budgetWei: "1000000000000000000", maxLossIfYesShares: "1000000000000000000" },
});
const errorCode = (body: string): string => (JSON.parse(body) as { error: { code: string } }).error.code;
const countRows = async (sql: string, params: unknown[] = []): Promise<number> => (await e2e.db.api.sql.query<{ n: number }>(sql, params))[0]?.n ?? -1;

describe("CSRF (SEC-AUTH-14)", () => {
  it("SEC-AUTH-14 refuses unsafe requests without the custom header, from another origin, cross-site or with a non-JSON type", async () => {
    const before = await countRows("SELECT count(*)::int AS n FROM claim_drafts");
    const body = JSON.stringify(draftBody());
    const cookie = `__Host-pine_session=${creator.session ?? ""}`;
    const base = { origin: ORIGIN, "sec-fetch-site": "same-origin", "x-pine-csrf": "1", "content-type": "application/json", cookie };
    const attempts: Record<string, string>[] = [
      { ...base, "x-pine-csrf": "" },
      { ...base, origin: "https://evil.example" },
      { ...base, origin: "https://app.pine.test.evil.example" },
      { ...base, "sec-fetch-site": "cross-site" },
      { ...base, "content-type": "text/plain" },
      { ...base, "content-type": "multipart/form-data; boundary=x" },
    ];
    for (const headers of attempts) {
      const response = await e2e.request({ method: "POST", url: "/api/v1/drafts", headers: Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== "")), payload: body });
      expect(response.statusCode, JSON.stringify(headers)).toBe(403);
      expect(errorCode(response.body)).toBe("CSRF_REJECTED");
    }
    // A forged logout cannot end the session either.
    const logout = await e2e.request({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, payload: "{}" });
    expect(logout.statusCode).toBe(403);
    expect((await creator.send("GET", "/api/v1/auth/session")).statusCode).toBe(200);
    expect(await countRows("SELECT count(*)::int AS n FROM claim_drafts")).toBe(before);
  });
});

describe("stale or halted read model (SEC-IDX-07)", () => {
  it("SEC-IDX-07 answers NOT_READY for every plan while the read model lags, and /readyz reports it", async () => {
    const draftId = await createDraft(creator);
    const preview = await createPreview(creator, draftId);
    e2e.clock.advance((e2e.config.maxIndexerLagSeconds + 120) * 1000);
    const quotaBefore = await countRows("SELECT coalesce(sum(used), 0)::int AS n FROM quota_usage");
    const publication = await creator.send("POST", "/api/v1/publications", { body: { previewId: preview.previewId, documentSha256: preview.documentSha256 } });
    expect(publication.statusCode).toBe(503);
    expect(errorCode(publication.body)).toBe("NOT_READY");
    expect(publication.headers["retry-after"]).toBeDefined();
    const ladder = await creator.send("POST", "/api/v1/funding/plans/ladder", {
      body: ladderBody(),
      headers: { "idempotency-key": "stale-ladder" },
    });
    expect(errorCode(ladder.body)).toBe("NOT_READY");
    const commit = await researcher.send("POST", "/api/v1/evidence/plans/commit", { body: { market: published.event.market, commitment: `0x${"11".repeat(32)}` }, headers: { "idempotency-key": "stale-commit" } });
    expect(errorCode(commit.body)).toBe("NOT_READY");
    const ready = await e2e.request({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: "not_ready", checks: { readModel: "stale" } });
    // Public reads keep working and say they are stale.
    const list = await e2e.request({ method: "GET", url: "/api/v1/claims" });
    expect(list.json()).toMatchObject({ indexer: { stale: true } });
    // No plan was stored and no quota was consumed by refused plans.
    expect(await countRows("SELECT coalesce(sum(used), 0)::int AS n FROM quota_usage")).toBe(quotaBefore);
    expect(await countRows("SELECT count(*)::int AS n FROM claim_publications WHERE preview_id = $1::uuid", [preview.previewId])).toBe(0);

    await e2e.chain.tick();
    e2e.clock.advance(6_000);
    const fresh = await creator.send("POST", "/api/v1/publications", { body: { previewId: preview.previewId, documentSha256: preview.documentSha256 } });
    expect(fresh.statusCode).toBe(200);
    expect((await e2e.request({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });

  it("SEC-IDX-07 answers NOT_READY while the indexer is halted, even when its cursor is fresh", async () => {
    await e2e.chain.halt();
    e2e.clock.advance(6_000);
    const ladder = await creator.send("POST", "/api/v1/funding/plans/ladder", {
      body: ladderBody(),
      headers: { "idempotency-key": "halted-ladder" },
    });
    expect(ladder.statusCode).toBe(503);
    expect(errorCode(ladder.body)).toBe("NOT_READY");
    expect(ladder.json<{ error: { message: string } }>().error.message).toMatch(/halted/);
    const ready = await e2e.request({ method: "GET", url: "/readyz" });
    expect(ready.json()).toMatchObject({ checks: { readModel: "halted" } });
    const oracle = await e2e.request({ method: "GET", url: `/api/v1/markets/${published.event.market}/oracle` });
    expect(oracle.json()).toMatchObject({ freshness: { halted: true, stale: true, status: "stalled" } });
    await e2e.chain.clearHalts();
    e2e.clock.advance(6_000);
    expect((await e2e.request({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });
});

describe("SC-001 disabled (SEC-LEGAL-09)", () => {
  it("SEC-LEGAL-09 refuses an SC-001 draft even when the configuration lists the family", async () => {
    const response = await creator.send("POST", "/api/v1/drafts", { body: draftBody({ policy: { id: "SC-001", version: "0.1.0" } }) });
    expect(response.statusCode).toBe(503);
    expect(errorCode(response.body)).toBe("FEATURE_DISABLED");
    const policies = await e2e.request({ method: "GET", url: "/api/v1/policies" });
    const sc = policies.json<{ policies: { id: string; publishable?: boolean; status?: string }[] }>().policies.find((policy) => policy.id === "SC-001");
    expect(sc).toBeDefined();
    expect(sc?.publishable === true).toBe(false);
  });
});

describe("compliance refusals (SEC-LEGAL-01..03)", () => {
  it("SEC-LEGAL-02 refuses every plan for a screened wallet with 451 and stores nothing", async () => {
    await sanctioned.signIn();
    sessionTokens.push(sanctioned.session ?? "");
    const plans = (await countRows("SELECT count(*)::int AS n FROM markets_plans")) + (await countRows("SELECT count(*)::int AS n FROM funding_plans"));
    const commit = await sanctioned.send("POST", "/api/v1/evidence/plans/commit", { body: { market: published.event.market, commitment: `0x${"22".repeat(32)}` }, headers: { "idempotency-key": "sanctioned-commit" } });
    expect(commit.statusCode).toBe(451);
    expect(errorCode(commit.body)).toBe("UNAVAILABLE_FOR_LEGAL_REASONS");
    const ladder = await sanctioned.send("POST", "/api/v1/funding/plans/ladder", {
      body: ladderBody(),
      headers: { "idempotency-key": "sanctioned-ladder" },
    });
    expect(ladder.statusCode).toBe(451);
    expect((await countRows("SELECT count(*)::int AS n FROM markets_plans")) + (await countRows("SELECT count(*)::int AS n FROM funding_plans"))).toBe(plans);
    expect(await countRows("SELECT count(*)::int AS n FROM audit_log WHERE action = 'compliance.refused' AND details->>'reason' = 'sanctions'")).toBeGreaterThanOrEqual(2);
  });

  it("SEC-LEGAL-01 refuses publication and funding from a blocked country (header set by the trusted proxy) with 451", async () => {
    const draftId = await createDraft(creator);
    const preview = await createPreview(creator, draftId);
    const blocked = { "cf-ipcountry": "KP", "x-forwarded-for": "203.0.113.7" };
    const publication = await creator.send("POST", "/api/v1/publications", { body: { previewId: preview.previewId, documentSha256: preview.documentSha256 }, headers: blocked });
    expect(publication.statusCode).toBe(451);
    expect(await countRows("SELECT count(*)::int AS n FROM claim_publications WHERE preview_id = $1::uuid", [preview.previewId])).toBe(0);
    const ladder = await creator.send("POST", "/api/v1/funding/plans/ladder", {
      body: ladderBody(),
      headers: { ...blocked, "idempotency-key": "kp-ladder" },
    });
    expect(ladder.statusCode).toBe(451);
    // Evidence is not geofenced for KP in this configuration: the same request from KP gets its plan.
    const commit = await creator.send("POST", "/api/v1/evidence/plans/commit", { body: { market: published.event.market, commitment: `0x${"33".repeat(32)}` }, headers: { ...blocked, "idempotency-key": "kp-commit" } });
    expect(commit.statusCode).toBe(201);
    const audit = await e2e.db.api.sql.query<{ country: string }>("SELECT details->>'country' AS country FROM audit_log WHERE action = 'compliance.refused' AND details->>'reason' = 'geofence'");
    expect(audit.map((row) => row.country)).toEqual(["KP", "KP"]);
  });
});

describe("blocked content (SEC-EVID-12, SEC-OPS-06)", () => {
  let manifestSha: Hex32;

  it("SEC-EVID-12 an admin block makes the user-content host answer 451 and the ERC-1497 evidence route 451", async () => {
    // A published (not committed) evidence submission with a stored manifest.
    const manifest: EvidenceManifest = {
      schema: "urn:pine:evidence-manifest:v1",
      submitter: researcher.wallet,
      claim: { chainId: 100, market: published.event.market, claimDocumentSha256: published.event.claimDocumentSha256, commit: published.event.commit },
      title: "Takedown candidate",
      violatedRequirement: "Each reporter-funding deposit's principal is allocated only from eligible bridging/reporter funds in scope.",
      summary: "Contains material that must be taken down.",
      expectedBehavior: "n/a",
      actualBehavior: "n/a",
      reproduction: { environment: "n/a", setup: "n/a", command: "n/a", initialState: "", notes: "" },
      artifacts: [],
    };
    const stored = await researcher.send("POST", "/api/v1/evidence/manifests", { body: manifest });
    expect(stored.statusCode).toBe(201);
    manifestSha = encodeEvidenceManifest(manifest).sha256;
    const publish = await researcher.send("POST", "/api/v1/evidence/plans/publish", { body: { market: published.event.market, contentSha256: manifestSha }, headers: { "idempotency-key": "publish-1" } });
    expect(publish.statusCode, publish.body).toBe(201);
    await e2e.chain.mine([{ kind: "EvidencePublished", address: e2e.manifest.pine.evidenceRegistry, submissionId: 7n, market: published.event.market, submitter: researcher.wallet, contentSha256: manifestSha, publishedAt: e2e.clock.unix() }]);
    const erc1497 = `/api/v1/markets/${published.event.market}/evidence/${e2e.manifest.pine.evidenceRegistry}/7/erc1497.json`;
    expect((await e2e.request({ method: "GET", url: erc1497 })).statusCode).toBe(200);
    const base = await e2e.startContentServer();
    expect((await fetch(`${base}/c/${manifestSha}`)).status).toBe(200);

    // A non-admin cannot moderate.
    const denied = await researcher.send("POST", "/api/v1/admin/moderation", { body: { subject: "content", id: manifestSha, action: "block", reason: "takedown request #1" } });
    expect(denied.statusCode).toBe(403);

    await admin.signIn();
    sessionTokens.push(admin.session ?? "");
    const block = await admin.send("POST", "/api/v1/admin/moderation", { body: { subject: "content", id: manifestSha, action: "block", reason: "takedown request #1" } });
    expect(block.statusCode, block.body).toBe(200);
    const blockedDownload = await fetch(`${base}/c/${manifestSha}`);
    expect(blockedDownload.status).toBe(451);
    expect(await blockedDownload.text()).not.toContain("Takedown candidate");
    const blockedErc = await e2e.request({ method: "GET", url: erc1497 });
    expect(blockedErc.statusCode).toBe(451);
    expect(blockedErc.body).not.toContain("Takedown candidate");
    // Moderation never alters chain data: the submission is still listed with its digest, without content.
    const list = await e2e.request({ method: "GET", url: `/api/v1/markets/${published.event.market}/evidence` });
    expect(list.body).toContain(manifestSha);
    expect(list.body).not.toContain("Takedown candidate");
    expect(await countRows("SELECT count(*)::int AS n FROM audit_log WHERE action = 'moderation.blocked'")).toBe(1);
  });

  it("SEC-OPS-06 a blocked claim document leaves only metadata in the public claim detail", async () => {
    const base = await e2e.startContentServer();
    expect((await fetch(`${base}/c/${published.event.claimDocumentSha256}`)).status).toBe(200);
    const block = await admin.send("POST", "/api/v1/admin/moderation", { body: { subject: "content", id: published.event.claimDocumentSha256, action: "block", reason: "takedown request #2" } });
    expect(block.statusCode).toBe(200);
    expect((await fetch(`${base}/c/${published.event.claimDocumentSha256}`)).status).toBe(451);
    const detail = await e2e.request({ method: "GET", url: `/api/v1/claims/${published.event.market}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ claim: { market: published.event.market, title: null, marketName: null } });
    const feed = await e2e.request({ method: "GET", url: "/api/v1/agents/claims" });
    expect(feed.body).not.toContain(published.event.market);
  });
});

describe("public routes ignore cookies (SEC-AGENT-04)", () => {
  it("SEC-AGENT-04 returns identical cookie-free responses with or without a session and never sets cookies", async () => {
    for (const url of ["/api/v1/claims", `/api/v1/claims/${published.event.market}`, "/api/v1/agents/claims", "/.well-known/pine.json", "/api/v1/policies", `/api/v1/markets/${published.event.market}/oracle`]) {
      const anonymous = await e2e.request({ method: "GET", url });
      const withSession = await e2e.request({ method: "GET", url, headers: { cookie: `__Host-pine_session=${creator.session ?? ""}; other=1` } });
      const garbage = await e2e.request({ method: "GET", url, headers: { cookie: `__Host-pine_session=pine_s1_${"x".repeat(43)}` } });
      for (const response of [anonymous, withSession, garbage]) {
        expect(response.statusCode, url).toBe(200);
        expect(response.headers["set-cookie"], url).toBeUndefined();
        expect(response.headers["access-control-allow-origin"], url).toBe("*");
        expect(response.headers["access-control-allow-credentials"], url).toBeUndefined();
      }
      expect(withSession.body, url).toBe(anonymous.body);
      expect(garbage.body, url).toBe(anonymous.body);
    }
    // Public routes are GET/HEAD only.
    const post = await creator.send("POST", "/api/v1/claims", { body: {} });
    expect(post.statusCode).toBe(404);
  });
});

describe("secrets", () => {
  it("SEC-OPS-03 an RPC outage whose error embeds the provider URL and key never reaches a client, a log line or a stored error", async () => {
    // A second claim whose publication plan is issued before the outage.
    const draftId = await createDraft(creator);
    const preview = await createPreview(creator, draftId);
    const first = await creator.send("POST", "/api/v1/publications", { body: { previewId: preview.previewId, documentSha256: preview.documentSha256 } });
    expect(first.statusCode).toBe(200);
    const plan = e2e.plans.at(-1)?.plan;
    if (!plan) throw new Error("no publication plan");
    // Let the public oracle-status cache (PRD-04 4a) expire so the read below reaches the failing RPC.
    e2e.clock.advance(ORACLE_CACHE_SECONDS * 1000);
    await e2e.chain.tick();
    e2e.rpc.failure = `request to ${e2e.secrets.rpcUrls.primary} failed, reason: connect ECONNREFUSED (key ${new URL(e2e.secrets.rpcUrls.primary).pathname})`;
    try {
      const publication = await creator.send("POST", "/api/v1/publications", { body: { previewId: preview.previewId, documentSha256: preview.documentSha256 } });
      expect(publication.statusCode).toBe(502);
      expect(errorCode(publication.body)).toBe("UPSTREAM_UNAVAILABLE");
      const oracle = await e2e.request({ method: "GET", url: `/api/v1/markets/${published.event.market}/oracle` });
      expect(oracle.statusCode).toBe(502);
      // The oracle helper reads Reality by eth_call before building: the outage is a 502 with a fixed message.
      const answer = await researcher.send("POST", "/api/v1/oracle/plans/submit-answer", {
        body: { market: published.event.market, outcome: "no", bond: "10000000000000000000" },
        headers: { "idempotency-key": "outage-answer" },
      });
      expect(answer.statusCode).toBe(502);
      expect(errorCode(answer.body)).toBe("UPSTREAM_UNAVAILABLE");
      // The claim lands on chain during the outage: the jobs cannot read its receipt and keep it pending, storing only
      // the error's safe short form for operators (never the transport text that carries the URL and key).
      const claimB = await mineCreateClaim(e2e, plan);
      await e2e.runJob("claims.reconcile-publications");
      await e2e.runJob("claims.verify-integrity");
      const rows = await e2e.db.api.sql.query<{ integrity_status: string; last_error: string | null }>("SELECT integrity_status, last_error FROM claims_index WHERE market = $1", [claimB.market]);
      expect(rows[0]?.integrity_status).toBe("pending");
      const stored = rows[0]?.last_error ?? "";
      expect(stored).toMatch(/^[A-Za-z]+Error: /);
      expect(stored).not.toContain("e2e-primary-api-key");
      expect(stored).not.toContain("/v2/");
    } finally {
      e2e.rpc.failure = null;
    }
  });

  it("verified every plan of every response, and leaked no secret into any response, log line or stored error", async () => {
    expect(e2e.plans.length).toBeGreaterThanOrEqual(4);
    const scan = assertNoSecretLeaks(e2e, sessionTokens);
    await assertNoSecretsPersisted(e2e, sessionTokens);
    expect(scan.responses).toBeGreaterThan(50);
    expect(scan.logLines).toBeGreaterThan(50);
  });
});
