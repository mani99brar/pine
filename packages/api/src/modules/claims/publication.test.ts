// Must stay the first import: serializes the memory-heavy claims test files (see test/lock.ts).
import "./test/lock.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalBytes, sha256Hex, type JsonValue } from "@pine/shared/canonical";
import { buildDeploymentManifest } from "@pine/shared/deployment";
import { planFromWire, verifyPlan, type WireTxPlan } from "@pine/shared/tx-plan";
import type { Address, Hex32 } from "@pine/shared/types";
import type { QuotaName } from "../../contracts/app.js";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../../contracts/app.js";
import { GitHubGatewayError } from "../../contracts/app.js";
import { buildTestApp, FakeQuotas } from "../../contracts/testing.js";
import { createClaimsModule } from "./index.js";
import { addOnChainClaim, BOT_POLICY_SHA, copyCatalog, createDraft, createPreview, documentWith, draftBody, markFresh, publish, REPO, TARGET_COMMIT, useHarness, type Harness } from "./test/helpers.js";

const harnessOf = useHarness();

interface PublicationBody {
  publication: { id: string; state: string; market: string | null; planId: string; documentSha256: string; transactions: { txHash: string; status: string }[] };
  planExpired: boolean;
  plan: WireTxPlan | null;
}

async function previewed(h: Harness) {
  const draft = await createDraft(h);
  const preview = await createPreview(h, draft.id);
  return { draft, preview };
}

function verifyWirePlan(h: Harness, wire: unknown) {
  const manifest = buildDeploymentManifest(h.ctx.config.contracts);
  // Decode the HTTP body (never the in-memory plan) and verify it like a client would (SEC-TX-01/02/05/11).
  const plan = planFromWire(wire);
  verifyPlan(plan, manifest, { markets: new Map(), questionIds: new Set() }, { maxTotalValueWei: 0n, maxApprovalAmount: 0n });
  return plan;
}

const rowCount = async (h: Harness) => (await h.ctx.database.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM claim_publications"))[0]!.n;

describe("publication plans", () => {
  it("returns one createClaim step that passes verifyPlan, bound to the previewed bytes, after storing the document", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    const response = await publish(h, preview);
    expect(response.statusCode).toBe(200);
    const body = response.json() as PublicationBody;
    expect(body.publication.state).toBe("planned");
    expect(body.planExpired).toBe(false);
    const plan = verifyWirePlan(h, body.plan);
    expect(plan.account).toBe(h.session.wallet.toLowerCase());
    expect(plan.planId).toBe(body.publication.planId);
    expect(plan.steps).toHaveLength(1);
    const [step] = plan.steps;
    expect(step!.allowlistId).toBe("claimRegistry.createClaim");
    expect(step!.to).toBe(h.ctx.config.contracts.claimRegistry);
    expect(step!.value).toBe(0n);
    const document = preview.document;
    expect(step!.args[0]).toEqual({
      claimDocumentSha256: preview.documentSha256,
      policyDocumentSha256: BOT_POLICY_SHA,
      repositoryId: BigInt(document.target.repository.id),
      commit: `0x${TARGET_COMMIT}`,
      evidenceDeadline: BigInt(document.evidence.evidenceDeadline),
      revealDeadline: BigInt(document.evidence.revealDeadline),
      minBond: 10n ** 19n,
      title: document.claim.title,
    });
    // Content stored before the plan was returned, byte-identical to the preview.
    const stored = await h.ctx.contentStore.get(preview.documentSha256);
    expect(stored?.record.sha256).toBe(preview.documentSha256);
    expect(h.ctx.compliance.calls).toEqual([{ wallet: h.session.wallet, action: "publish_claim" }]);
    expect(h.ctx.audit.entries.map((entry) => entry.action)).toContain("claim.publication.created");
  });

  it("a tampered wire plan is rejected by the client verifier (SEC-TX-02)", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    const wire = (await publish(h, preview)).json().plan as WireTxPlan;
    const tampered = structuredClone(wire);
    tampered.steps[0]!.to = "0x00000000000000000000000000000000000000ff";
    expect(() => verifyWirePlan(h, tampered)).toThrow(/target/);
    const valued = structuredClone(wire);
    valued.steps[0]!.value = "1";
    expect(() => verifyWirePlan(h, valued)).toThrow(/value/);
  });

  it("is idempotent per (user, digest): the same plan twice, one row, one quota unit", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    const first = await publish(h, preview);
    const second = await publish(h, preview);
    expect(second.statusCode).toBe(200);
    expect(second.json().plan).toEqual(first.json().plan);
    expect(second.json().publication.id).toBe(first.json().publication.id);
    expect(await rowCount(h)).toBe(1);
    expect(h.ctx.quotas.used.get(`${h.session.userId}:publications_per_day`)).toBe(1);
  });

  it("two concurrent identical first requests yield one row and the same response (no 500)", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    const [a, b] = await Promise.all([publish(h, preview), publish(h, preview)]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().publication.id).toBe(b.json().publication.id);
    expect(a.json().plan).toEqual(b.json().plan);
    expect(await rowCount(h)).toBe(1);
  });

  it("the losing first request re-reads the winner's row after its insert conflicts (deterministic race, PRD-03 §8c)", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    // The competing identical request runs to completion between the loser's existence check and its insert: the loser
    // has already found no row and consumed its quota unit when the winner inserts.
    let winner: Awaited<ReturnType<typeof publish>> | null = null;
    let raced = false;
    class RacingQuotas extends FakeQuotas {
      override async consume(userId: string, quota: QuotaName, amount = 1): Promise<void> {
        await super.consume(userId, quota, amount);
        if (quota === "publications_per_day" && !raced) {
          raced = true;
          winner = await publish(h, preview);
          expect(await rowCount(h)).toBe(1);
        }
      }
    }
    const quotas = new RacingQuotas();
    h.ctx.quotas = quotas;
    const loser = await publish(h, preview);
    expect(winner).not.toBeNull();
    const won = winner!;
    expect(won.statusCode).toBe(200);
    expect(loser.statusCode).toBe(200);
    expect(loser.json().publication.id).toBe(won.json().publication.id);
    expect(loser.json().plan).toEqual(won.json().plan);
    verifyWirePlan(h, loser.json().plan);
    expect(await rowCount(h)).toBe(1);
    // Both passed the existence check (two quota units, the accepted cost of the race); only the winner inserted.
    expect(quotas.used.get(`${h.session.userId}:publications_per_day`)).toBe(2);
    expect(h.ctx.audit.entries.filter((entry) => entry.action === "claim.publication.created")).toHaveLength(1);
  });

  it("409 on a digest mismatch and on a draft edited after the preview (SEC-CLAIM-04)", async () => {
    const h = harnessOf();
    const { draft, preview } = await previewed(h);
    const mismatch = await publish(h, { previewId: preview.previewId, documentSha256: `0x${"11".repeat(32)}` });
    expect(mismatch.statusCode).toBe(409);
    await h.app.inject({ method: "PUT", url: `/api/v1/drafts/${draft.id}`, headers: h.headers, payload: { input: draftBody({ requirement: "Changed after preview." }) } });
    const edited = await publish(h, preview);
    expect(edited.statusCode).toBe(409);
    expect(edited.json().error.message).toMatch(/modified after/);
    expect(await rowCount(h)).toBe(0);
  });

  it("frozen preview bytes that no longer pass the document rules (bracket title) are 409 without a plan", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    // A preview frozen before titles refused brackets: canonical bytes under their own digest, schema-invalid today.
    const document = structuredClone(preview.document);
    document.claim.title = "Rule [1]: fake terms [x";
    const bytes = canonicalBytes(document as unknown as JsonValue);
    const digest = sha256Hex(bytes);
    await h.ctx.database.sql.query("UPDATE claim_previews SET document = $1, document_sha256 = $2 WHERE id = $3", [bytes, digest, preview.previewId]);
    const response = await publish(h, { previewId: preview.previewId, documentSha256: digest });
    expect(response.statusCode).toBe(409);
    expect(response.json().plan).toBeUndefined();
    expect(await rowCount(h)).toBe(0);
    expect(h.ctx.quotas.used.get(`${h.session.userId}:publications_per_day`) ?? 0).toBe(0);
  });

  it("another user's preview is NOT_FOUND", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    const other = await h.user();
    expect((await publish(h, preview, other.headers)).statusCode).toBe(404);
  });

  it("compliance refusal returns 451, also on a retry of an existing publication (SEC-LEGAL)", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    expect((await publish(h, preview)).statusCode).toBe(200);
    h.ctx.compliance.blockedWallets.add(h.session.wallet.toLowerCase());
    const retry = await publish(h, preview);
    expect(retry.statusCode).toBe(451);
    expect(retry.json().plan).toBeUndefined();
    h.ctx.compliance.blockedWallets.clear();
    h.ctx.compliance.termsMissing.add(h.session.userId);
    expect((await publish(h, preview)).json().error.code).toBe("TERMS_REQUIRED");
  });

  it("quota is consumed only for new publications and refusal creates nothing", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    h.ctx.quotas = new FakeQuotas({ publications_per_day: 0 });
    const refused = await publish(h, preview);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("QUOTA_EXCEEDED");
    expect(await rowCount(h)).toBe(0);
    h.ctx.quotas = new FakeQuotas({ publications_per_day: 1 });
    expect((await publish(h, preview)).statusCode).toBe(200);
    // The retry reuses the row and needs no quota.
    expect((await publish(h, preview)).statusCode).toBe(200);
  });

  it("NOT_READY when the read model is stale or halted (SEC-IDX-07), before any row or quota", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    h.ctx.clock.advance((h.ctx.config.maxIndexerLagSeconds + 1) * 1000);
    const stale = await publish(h, preview);
    expect(stale.statusCode).toBe(503);
    expect(stale.json().error.code).toBe("NOT_READY");
    expect(stale.headers["retry-after"]).toBeDefined();
    markFresh(h.ctx);
    h.ctx.readModel.setHalted(true);
    const halted = await publish(h, preview);
    expect(halted.statusCode).toBe(503);
    expect(halted.json().error.code).toBe("NOT_READY");
    expect(await rowCount(h)).toBe(0);
    expect(h.ctx.quotas.used.get(`${h.session.userId}:publications_per_day`)).toBeUndefined();
  });

  it("returns no plan when the content store fails (a plan never precedes the stored document)", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    h.ctx.contentStore.put = async () => {
      throw new Error("disk full");
    };
    const response = await publish(h, preview);
    expect(response.statusCode).toBe(500);
    expect(response.json().plan).toBeUndefined();
  });

  it("a retry after the claim exists returns the market and no plan (latest-block marketOf or the read model)", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    expect((await publish(h, preview)).json().plan).not.toBeNull();
    const market = "0x00000000000000000000000000000000000ca1e0" as Address;
    h.chain.markets.set(`${h.session.wallet.toLowerCase()}|${preview.documentSha256}`, market);
    const retry = (await publish(h, preview)).json() as PublicationBody;
    expect(retry.plan).toBeNull();
    expect(retry.planExpired).toBe(false);
    expect(retry.publication).toMatchObject({ state: "mined", market });

    const second = await previewed(h);
    addOnChainClaim(h.ctx, h.chain, second.preview.document, second.preview.documentSha256);
    const fromIndex = (await publish(h, second.preview)).json() as PublicationBody;
    expect(fromIndex.plan).toBeNull();
    expect(fromIndex.publication.state).toBe("mined");
  });

  it("refuses to plan when the chain cannot be checked", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    h.chain.failMarketOf = true;
    const response = await publish(h, preview);
    expect(response.statusCode).toBe(502);
    expect(JSON.stringify(response.json())).not.toContain("secret-key");
  });

  it("after the plan offer expires a retry returns planExpired without a plan (24 h preview cap)", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    expect((await publish(h, preview)).statusCode).toBe(200);
    h.ctx.clock.advance(86_400 * 1000 - 1000);
    markFresh(h.ctx);
    expect((await publish(h, preview)).json().plan).not.toBeNull();
    h.ctx.clock.advance(1000);
    markFresh(h.ctx);
    const expired = (await publish(h, preview)).json() as PublicationBody;
    expect(expired.plan).toBeNull();
    expect(expired.planExpired).toBe(true);
    expect(expired.publication.state).toBe("planned");
    // A first request after expiry gets the same answer.
    const late = await previewed(h);
    h.ctx.clock.advance(86_400 * 1000);
    markFresh(h.ctx);
    const lateBody = (await publish(h, late.preview)).json() as PublicationBody;
    expect(lateBody).toMatchObject({ plan: null, planExpired: true });
  });

  it("applies the policy gate again at publication", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    const strict = await h.variant({ claims: { ...h.ctx.config.claims, allowDraftPolicies: false } });
    const response = await strict.app.inject({ method: "POST", url: "/api/v1/publications", headers: h.headers, payload: { previewId: preview.previewId, documentSha256: preview.documentSha256 } });
    expect(response.statusCode).toBe(422);
  });

  it("deleting a draft that has a publication is 409", async () => {
    const h = harnessOf();
    const { draft, preview } = await previewed(h);
    await publish(h, preview);
    const response = await h.app.inject({ method: "DELETE", url: `/api/v1/drafts/${draft.id}`, headers: h.headers });
    expect(response.statusCode).toBe(409);
    expect((await h.app.inject({ method: "GET", url: `/api/v1/drafts/${draft.id}`, headers: h.headers })).statusCode).toBe(200);
  });

  it("records submitted hashes idempotently and keeps replacements", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    const id = (await publish(h, preview)).json().publication.id as string;
    const first = `0x${"aa".repeat(32)}`;
    const replacement = `0x${"ab".repeat(32)}`;
    const submit = (txHash: string, headers = h.headers) => h.app.inject({ method: "POST", url: `/api/v1/publications/${id}/submitted`, headers, payload: { txHash } });
    expect((await submit(first)).json().publication.state).toBe("submitted");
    expect((await submit(first)).statusCode).toBe(200);
    const body = (await submit(replacement)).json() as PublicationBody;
    expect(body.publication.transactions.map((tx) => tx.txHash)).toEqual([first, replacement]);
    expect((await submit("0x1234")).statusCode).toBe(400);
    const other = await h.user();
    expect((await submit(first, other.headers)).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: `/api/v1/publications/${id}`, headers: other.headers })).statusCode).toBe(404);
    const read = await h.app.inject({ method: "GET", url: `/api/v1/publications/${id}`, headers: h.headers });
    expect(read.json().publication.state).toBe("submitted");
  });
});

describe("publication gates, races and audit (claims-006)", () => {
  const SC_SHA = "0xcc5859adc69b002d55db134193dd370bd0dff4c7445462a8772410ac3fea84d9" as Hex32;
  const permissive = (h: Harness) => h.variant({ claims: { ...h.ctx.config.claims, enabledPolicyFamilies: ["FUNC-001", "BOT-001", "SC-001"], allowDraftPolicies: true } });

  /** A draft and a preview of an SC-001 document, inserted directly (the API refuses to create either). */
  async function insertScPreview(h: Harness): Promise<{ draftId: string; previewId: string; documentSha256: Hex32 }> {
    const now = h.ctx.clock.unix();
    const evidenceDeadline = Math.ceil((now + 7 * 86_400) / 60) * 60;
    const revealDeadline = evidenceDeadline + 48 * 3_600;
    const { bytes, sha256, document } = documentWith((doc) => {
      doc.nonce = `0x${randomBytes(32).toString("hex")}` as Hex32;
      doc.policy = { id: "SC-001", version: "0.1.0", sha256: SC_SHA };
      doc.claim.policyParameters = {};
      doc.creator = h.session.wallet.toLowerCase() as Address;
      doc.evidence.evidenceDeadline = evidenceDeadline;
      doc.evidence.revealDeadline = revealDeadline;
      doc.market.openingTime = revealDeadline;
      doc.createdAt = h.ctx.clock.now().toISOString().replace(/\.\d{3}Z$/, "Z");
    });
    const draftId = randomUUID();
    const previewId = randomUUID();
    const at = h.ctx.clock.now().toISOString();
    await h.ctx.database.sql.query("INSERT INTO claim_drafts (id, user_id, revision, input, created_at, updated_at) VALUES ($1, $2, 1, $3::jsonb, $4, $4)", [
      draftId,
      h.session.userId,
      JSON.stringify(draftBody({ policy: { id: "SC-001", version: "0.1.0" }, policyParameters: {} })),
      at,
    ]);
    await h.ctx.database.sql.query(
      `INSERT INTO claim_previews (id, user_id, draft_id, draft_revision, document, document_sha256, document_cid, creator, question, policy_id, policy_version,
         evidence_deadline, reveal_deadline, plan_expires_at, created_at)
       VALUES ($1, $2, $3, 1, $4, $5, 'bafkreiexample', $6, 'question', 'SC-001', '0.1.0', $7, $8, $9, $10)`,
      [previewId, h.session.userId, draftId, bytes, sha256, document.creator, evidenceDeadline, revealDeadline, now + 86_400, at],
    );
    return { draftId, previewId, documentSha256: sha256 };
  }

  const previewCount = async (h: Harness) => (await h.ctx.database.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM claim_previews"))[0]!.n;

  it("SEC-CLAIM-06 SC-001 is FEATURE_DISABLED at preview: no preview is created, even when the family is enabled", async () => {
    const h = harnessOf();
    const { draftId } = await insertScPreview(h);
    const before = await previewCount(h);
    const app = (await permissive(h)).app;
    const response = await app.inject({ method: "POST", url: `/api/v1/drafts/${draftId}/preview`, headers: h.headers, payload: { attestLiveSystemImpactNone: true } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("FEATURE_DISABLED");
    expect(await previewCount(h)).toBe(before);
    expect(h.ctx.audit.entries.map((entry) => entry.action)).not.toContain("claim.preview.created");
    // Refused before any GitHub call.
    expect(h.ctx.quotas.used.get(`${h.session.userId}:github_calls_per_hour`)).toBeUndefined();
  });

  it("SEC-CLAIM-06 SC-001 is FEATURE_DISABLED at publication: no publication, no plan, no quota, nothing stored", async () => {
    const h = harnessOf();
    const sc = await insertScPreview(h);
    for (const app of [h.app, (await permissive(h)).app]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/publications", headers: h.headers, payload: { previewId: sc.previewId, documentSha256: sc.documentSha256 } });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("FEATURE_DISABLED");
      expect(response.json().plan).toBeUndefined();
    }
    expect(await rowCount(h)).toBe(0);
    expect(h.ctx.quotas.used.get(`${h.session.userId}:publications_per_day`)).toBeUndefined();
    expect(await h.ctx.contentStore.has(sc.documentSha256)).toBe(false);
  });

  it("a first publication racing a draft delete is NOT_FOUND, never 500 (FK race)", async () => {
    const h = harnessOf();
    const { draft, preview } = await previewed(h);
    const app = h.app;
    const headers = h.headers;
    // The draft (and its previews) are deleted after the preview was read and before the insert. No transaction is
    // open across the quota call, so the delete runs to completion here.
    class DeletingQuotas extends FakeQuotas {
      override async consume(userId: string, quota: QuotaName, amount = 1): Promise<void> {
        if (quota === "publications_per_day") expect((await app.inject({ method: "DELETE", url: `/api/v1/drafts/${draft.id}`, headers })).statusCode).toBe(204);
        return super.consume(userId, quota, amount);
      }
    }
    h.ctx.quotas = new DeletingQuotas();
    const response = await publish(h, preview);
    // The insert transaction's FOR SHARE on the draft finds nothing, so the answer comes before any insert (the wrapped
    // 23503 mapping of a real concurrent insert is unit-tested in races.test.ts).
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: "NOT_FOUND", message: "Preview not found" });
    expect(response.json().plan).toBeUndefined();
    expect(await rowCount(h)).toBe(0);
    expect(await previewCount(h)).toBe(0);
    expect(await h.ctx.contentStore.has(preview.documentSha256)).toBe(false);
  });

  it("the reverse race (a publication referencing a preview the delete removes) maps the delete's FK (RESTRICT) violation to 409", async () => {
    const h = harnessOf();
    const { draft, preview } = await previewed(h);
    const other = await createDraft(h);
    // A publication that references this draft's preview but another draft, so the delete's publication check passes
    // and PGlite raises a real 23503 on the preview DELETE (what a publication inserted after the check would do).
    await h.ctx.database.sql.query(
      `INSERT INTO claim_publications (id, user_id, preview_id, draft_id, document_sha256, creator, plan_id, state, evidence_deadline, plan_expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'planned', 1, 1, $8, $8)`,
      [randomUUID(), h.session.userId, preview.previewId, other.id, preview.documentSha256, h.session.wallet.toLowerCase(), randomUUID(), h.ctx.clock.now().toISOString()],
    );
    const response = await h.app.inject({ method: "DELETE", url: `/api/v1/drafts/${draft.id}`, headers: h.headers });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    // The transaction rolled back: the draft and its preview are intact.
    expect((await h.app.inject({ method: "GET", url: `/api/v1/drafts/${draft.id}`, headers: h.headers })).statusCode).toBe(200);
    expect(await previewCount(h)).toBe(1);
  });

  it("audits the request-side transitions: created, submitted, mined (on request)", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    const id = (await publish(h, preview)).json().publication.id as string;
    const txHash = `0x${"ac".repeat(32)}`;
    await h.app.inject({ method: "POST", url: `/api/v1/publications/${id}/submitted`, headers: h.headers, payload: { txHash } });
    const market = "0x00000000000000000000000000000000000ca1e1" as Address;
    h.chain.markets.set(`${h.session.wallet.toLowerCase()}|${preview.documentSha256}`, market);
    expect((await publish(h, preview)).json().publication.state).toBe("mined");
    const entries = h.ctx.audit.entries.filter((entry) => entry.subjectType === "claim_publication" && entry.subjectId === id);
    expect(entries.map((entry) => entry.action)).toEqual(["claim.publication.created", "claim.publication.tx_reported", "claim.publication.submitted", "claim.publication.mined"]);
    expect(entries.find((entry) => entry.action === "claim.publication.submitted")?.details).toMatchObject({ txHash });
    expect(entries.find((entry) => entry.action === "claim.publication.mined")?.details).toMatchObject({ market, via: "request" });
    // Idempotent: a retry audits nothing new.
    await publish(h, preview);
    expect(h.ctx.audit.entries.filter((entry) => entry.subjectId === id)).toHaveLength(4);
  });
});

describe("lock order, revision under lock and gate positions (claims-007, PRD-03 §8b)", () => {
  /** Replaces ctx.db for one test with a drizzle handle on the same PGlite client that records every statement. */
  async function recording<T>(h: Harness, run: (statements: string[]) => Promise<T>): Promise<T> {
    const statements: string[] = [];
    const original = h.ctx.db;
    h.ctx.db = drizzle(h.ctx.database.client, { logger: { logQuery: (query: string) => void statements.push(query.replace(/\s+/g, " ").trim()) } }) as unknown as Database;
    try {
      return await run(statements);
    } finally {
      h.ctx.db = original;
    }
  }

  /** The lock-relevant statements in order: row locks, the publication check of the delete, inserts and deletes. */
  function lockTrace(statements: string[]): string[] {
    const trace: string[] = [];
    for (const query of statements) {
      const lock = /FROM (\w+) .*\bFOR (UPDATE|SHARE)$/.exec(query);
      if (lock) trace.push(`${lock[1]} FOR ${lock[2]}`);
      else if (/^SELECT .* FROM claim_publications WHERE draft_id = /.test(query)) trace.push("check claim_publications");
      else if (/^INSERT INTO claim_publications /.test(query)) trace.push("INSERT claim_publications");
      else if (/^DELETE FROM (claim_previews|claim_drafts) /.test(query)) trace.push(`DELETE ${/^DELETE FROM (\w+)/.exec(query)![1]}`);
    }
    return trace;
  }

  it("a draft delete locks the draft FOR UPDATE, then its previews, before the publication check and the deletes", async () => {
    const h = harnessOf();
    const { draft } = await previewed(h);
    await createPreview(h, draft.id);
    const trace = await recording(h, async (statements) => {
      const response = await h.app.inject({ method: "DELETE", url: `/api/v1/drafts/${draft.id}`, headers: h.headers });
      expect(response.statusCode).toBe(204);
      return lockTrace(statements);
    });
    expect(trace).toEqual(["claim_drafts FOR UPDATE", "claim_previews FOR UPDATE", "check claim_publications", "DELETE claim_previews", "DELETE claim_drafts"]);
  });

  it("a draft delete with a publication stops after the locks and the check (409)", async () => {
    const h = harnessOf();
    const { draft, preview } = await previewed(h);
    expect((await publish(h, preview)).statusCode).toBe(200);
    const trace = await recording(h, async (statements) => {
      expect((await h.app.inject({ method: "DELETE", url: `/api/v1/drafts/${draft.id}`, headers: h.headers })).statusCode).toBe(409);
      return lockTrace(statements);
    });
    expect(trace).toEqual(["claim_drafts FOR UPDATE", "claim_previews FOR UPDATE", "check claim_publications"]);
  });

  it("a first publication takes FOR SHARE on the draft row (at the previewed revision) before its insert; a retry locks nothing", async () => {
    const h = harnessOf();
    const { draft, preview } = await previewed(h);
    const { first, retry } = await recording(h, async (statements) => {
      expect((await publish(h, preview)).statusCode).toBe(200);
      const firstStatements = [...statements];
      statements.length = 0;
      expect((await publish(h, preview)).statusCode).toBe(200);
      return { first: firstStatements, retry: [...statements] };
    });
    expect(lockTrace(first)).toEqual(["claim_drafts FOR SHARE", "INSERT claim_publications"]);
    const share = first.find((query) => query.endsWith("FOR SHARE"))!;
    expect(share).toMatch(/WHERE id = \$1::uuid AND user_id = \$2::uuid AND revision = \$3 FOR SHARE$/);
    expect(lockTrace(retry)).toEqual([]);
    expect(draft.revision).toBe(1);
  });

  it("a draft edited after the early revision check (before the locked insert) is 409, never a publication for a stale preview", async () => {
    const h = harnessOf();
    const { draft, preview } = await previewed(h);
    const app = h.app;
    const headers = h.headers;
    // The PUT commits after the unlocked 409 check and the quota call, before the insert transaction locks the draft.
    class EditingQuotas extends FakeQuotas {
      override async consume(userId: string, quota: QuotaName, amount = 1): Promise<void> {
        if (quota === "publications_per_day") {
          const put = await app.inject({ method: "PUT", url: `/api/v1/drafts/${draft.id}`, headers, payload: { input: draftBody({ requirement: "Edited during publication." }) } });
          expect(put.statusCode).toBe(200);
        }
        return super.consume(userId, quota, amount);
      }
    }
    h.ctx.quotas = new EditingQuotas();
    const response = await publish(h, preview);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/modified after/) });
    expect(response.json().plan).toBeUndefined();
    expect(await rowCount(h)).toBe(0);
    expect(await h.ctx.contentStore.has(preview.documentSha256)).toBe(false);
  });

  const strictApp = async (h: Harness) => (await h.variant({ claims: { ...h.ctx.config.claims, allowDraftPolicies: false } })).app;
  const publishOn = (app: Harness["app"], h: Harness, preview: { previewId: string; documentSha256: string }) =>
    app.inject({ method: "POST", url: "/api/v1/publications", headers: h.headers, payload: { previewId: preview.previewId, documentSha256: preview.documentSha256 } });

  it("a retry after the policy stopped being publishable returns the on-chain market without a plan", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    expect((await publish(h, preview)).json().plan).not.toBeNull();
    const market = "0x00000000000000000000000000000000000ca1e2" as Address;
    h.chain.markets.set(`${h.session.wallet.toLowerCase()}|${preview.documentSha256}`, market);
    const strict = await strictApp(h);
    const retry = await publishOn(strict, h, preview);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ plan: null, planExpired: false, publication: { state: "mined", market } });
    // And once mined, every later retry also answers without the gate.
    expect((await publishOn(strict, h, preview)).json()).toMatchObject({ plan: null, publication: { state: "mined", market } });
  });

  it("an existing row whose policy is no longer publishable: the gate runs after the chain re-check and before content and plan", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    expect((await publish(h, preview)).statusCode).toBe(200);
    let puts = 0;
    const put = h.ctx.contentStore.put.bind(h.ctx.contentStore);
    h.ctx.contentStore.put = async (input) => {
      puts += 1;
      return put(input);
    };
    h.chain.calls.length = 0;
    const strict = await strictApp(h);
    const refused = await publishOn(strict, h, preview);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().plan).toBeUndefined();
    // The chain was re-checked first (marketOf at latest), and nothing was stored for a plan.
    expect(h.chain.calls).toContain("eth_call");
    expect(puts).toBe(0);
    expect(h.ctx.quotas.used.get(`${h.session.userId}:publications_per_day`)).toBe(1);
  });

  it("an expired plan offer answers planExpired (no plan) before the gate, even when the policy is no longer publishable", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    expect((await publish(h, preview)).statusCode).toBe(200);
    h.ctx.clock.advance(86_400 * 1000);
    markFresh(h.ctx);
    const strict = await strictApp(h);
    const expired = await publishOn(strict, h, preview);
    expect(expired.statusCode).toBe(200);
    expect(expired.json()).toMatchObject({ plan: null, planExpired: true, publication: { state: "planned" } });
  });

  it("a claim created directly on-chain without a row is refused on its first POST when the policy is not publishable (no row, no quota)", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    h.chain.markets.set(`${h.session.wallet.toLowerCase()}|${preview.documentSha256}`, "0x00000000000000000000000000000000000ca1e3" as Address);
    const strict = await strictApp(h);
    const refused = await publishOn(strict, h, preview);
    expect(refused.statusCode).toBe(422);
    expect(await rowCount(h)).toBe(0);
    expect(h.ctx.quotas.used.get(`${h.session.userId}:publications_per_day`)).toBeUndefined();
  });
});

describe("request order and frozen inputs (decisions: POST /publications order; no recomputation)", () => {
  it("fixed order: validation -> compliance -> NOT_READY -> preview (NOT_FOUND) -> 409 checks -> quota/row", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    // Validation first: a malformed body never reaches compliance.
    h.ctx.compliance.blockedWallets.add(h.session.wallet.toLowerCase());
    const malformed = await publish(h, { previewId: preview.previewId, documentSha256: "0x12" });
    expect(malformed.statusCode).toBe(400);
    expect(h.ctx.compliance.calls).toEqual([]);
    // Compliance before readiness: a refused wallet gets 451 even while the read model is stale.
    h.ctx.clock.advance((h.ctx.config.maxIndexerLagSeconds + 1) * 1000);
    expect((await publish(h, preview)).statusCode).toBe(451);
    // Readiness before the preview lookup: an unknown preview is NOT_READY while stale, NOT_FOUND once fresh.
    h.ctx.compliance.blockedWallets.clear();
    const unknown = { previewId: randomUUID(), documentSha256: preview.documentSha256 };
    expect((await publish(h, unknown)).json().error.code).toBe("NOT_READY");
    markFresh(h.ctx);
    expect((await publish(h, unknown)).json().error.code).toBe("NOT_FOUND");
    // 409 checks before the quota: an exhausted quota is never reached by a digest mismatch.
    h.ctx.quotas = new FakeQuotas({ publications_per_day: 0 });
    expect((await publish(h, { previewId: preview.previewId, documentSha256: `0x${"22".repeat(32)}` })).statusCode).toBe(409);
    expect((await publish(h, preview)).statusCode).toBe(429);
    expect(await rowCount(h)).toBe(0);
  });

  it("the plan uses the previewed bytes only: a later clock and a changed default bond/window change nothing", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    h.ctx.clock.advance(3_600_000);
    markFresh(h.ctx);
    const changed = await h.variant({ claims: { ...h.ctx.config.claims, defaultMinBondWei: 20n * 10n ** 18n, defaultEvidenceWindowSeconds: 10 * 86_400 } });
    const response = await changed.app.inject({ method: "POST", url: "/api/v1/publications", headers: h.headers, payload: { previewId: preview.previewId, documentSha256: preview.documentSha256 } });
    expect(response.statusCode).toBe(200);
    const plan = verifyWirePlan(h, response.json().plan);
    expect(plan.steps[0]!.args[0]).toMatchObject({
      claimDocumentSha256: preview.documentSha256,
      evidenceDeadline: BigInt(preview.document.evidence.evidenceDeadline),
      revealDeadline: BigInt(preview.document.evidence.revealDeadline),
      minBond: 10n ** 19n,
    });
    const stored = await h.ctx.contentStore.get(preview.documentSha256);
    expect(stored?.record.sha256).toBe(preview.documentSha256);
    expect(JSON.parse(Buffer.from(stored!.bytes).toString("utf8"))).toEqual(preview.document);
  });
});

describe("policy digest recomputed at publication (claims-009, PRD-03 §8c)", () => {
  /** An app over a catalog copy whose BOT-001 0.1.0 text (and its catalog digest) changed after the preview. */
  async function amendedCatalogApp(h: Harness) {
    const dir = await copyCatalog();
    const file = path.join(dir, "BOT-001", "0.1.0.md");
    const bytes = Buffer.from(`${await readFile(file, "utf8")}\nAmended after the preview.\n`, "utf8");
    await writeFile(file, bytes);
    const sha256 = `0x${createHash("sha256").update(bytes).digest("hex")}`;
    const catalogFile = path.join(dir, "catalog.json");
    const json = JSON.parse(await readFile(catalogFile, "utf8")) as { policies: { id: string; sha256: string; bytes: number }[] };
    const entry = json.policies.find((item) => item.id === "BOT-001")!;
    entry.sha256 = sha256;
    entry.bytes = bytes.byteLength;
    await writeFile(catalogFile, JSON.stringify(json));
    const app = await buildTestApp([createClaimsModule({ catalogDir: dir })], h.ctx);
    return {
      sha256,
      publish: (preview: { previewId: string; documentSha256: string }) =>
        app.inject({ method: "POST", url: "/api/v1/publications", headers: h.headers, payload: { previewId: preview.previewId, documentSha256: preview.documentSha256 } }),
      close: async () => {
        await app.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  it("SEC-CLAIM-03 a preview whose policy sha256 differs from the loaded catalog entry is refused: no row, quota, content or plan", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    expect(preview.document.policy.sha256).toBe(BOT_POLICY_SHA);
    const amended = await amendedCatalogApp(h);
    try {
      expect(amended.sha256).not.toBe(BOT_POLICY_SHA);
      const response = await amended.publish(preview);
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatchObject({ code: "UNPROCESSABLE", message: "The policy text changed since the preview; preview again" });
      expect(response.json().plan).toBeUndefined();
      expect(await rowCount(h)).toBe(0);
      expect(h.ctx.quotas.used.get(`${h.session.userId}:publications_per_day`)).toBeUndefined();
      expect(await h.ctx.contentStore.has(preview.documentSha256)).toBe(false);

      // Existing-row path: a publication planned under the old catalog is refused on its retry, without a plan.
      const other = await previewed(h);
      expect((await publish(h, other.preview)).statusCode).toBe(200);
      const retry = await amended.publish(other.preview);
      expect(retry.statusCode).toBe(422);
      expect(retry.json().plan).toBeUndefined();
    } finally {
      await amended.close();
    }
  });
});

describe("publish-time repository recheck (claims-010, PRD-03 §8d, SEC-GH-13)", () => {
  const setVisibility = (h: Harness, visibility: "public" | "private") => {
    const repo = h.ctx.github.repos.get(`${REPO.owner}/${REPO.name}`.toLowerCase());
    if (!repo) throw new Error("seeded repository missing");
    repo.visibility = visibility;
  };
  const publicationsQuota = (h: Harness) => h.ctx.quotas.used.get(`${h.session.userId}:publications_per_day`);
  const githubQuota = (h: Harness) => h.ctx.quotas.used.get(`${h.session.userId}:github_calls_per_hour`) ?? 0;

  it("SEC-GH-13 a repository flipped to private between preview and the first publish is 422 REPO_NOT_PUBLIC: no plan, row, quota or content", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    setVisibility(h, "private");
    // The 409 checks come first: a digest mismatch is 409 whatever the repository's visibility, without a GitHub call.
    const beforeMismatch = githubQuota(h);
    expect((await publish(h, { previewId: preview.previewId, documentSha256: `0x${"22".repeat(32)}` })).statusCode).toBe(409);
    expect(githubQuota(h)).toBe(beforeMismatch);
    // The recheck runs before the quota: an exhausted publication quota is never reached.
    h.ctx.quotas = new FakeQuotas({ publications_per_day: 0 });
    const refused = await publish(h, preview);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({ code: "UNPROCESSABLE", message: expect.stringMatching(/^REPO_NOT_PUBLIC/) });
    expect(refused.json().plan).toBeUndefined();
    expect(await rowCount(h)).toBe(0);
    expect(publicationsQuota(h)).toBeUndefined();
    expect(await h.ctx.contentStore.has(preview.documentSha256)).toBe(false);
    // Public again: the same preview publishes.
    setVisibility(h, "public");
    h.ctx.quotas = new FakeQuotas();
    const ok = await publish(h, preview);
    expect(ok.statusCode).toBe(200);
    verifyWirePlan(h, ok.json().plan);
    expect(publicationsQuota(h)).toBe(1);
    expect(githubQuota(h)).toBe(1);
  });

  it("SEC-GH-13 a retry of an existing publication after the repository became private is 422 without a plan", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    expect((await publish(h, preview)).statusCode).toBe(200);
    setVisibility(h, "private");
    const refused = await publish(h, preview);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.message).toMatch(/^REPO_NOT_PUBLIC/);
    expect(refused.json().plan).toBeUndefined();
    expect(await rowCount(h)).toBe(1);
    expect(publicationsQuota(h)).toBe(1);
  });

  it("SEC-GH-13 a deleted (or now invisible) repository is 422 REPO_NOT_PUBLIC on both paths", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    const saved = h.ctx.github.repos.get(`${REPO.owner}/${REPO.name}`.toLowerCase())!;
    h.ctx.github.repos.clear();
    const first = await publish(h, preview);
    expect(first.statusCode).toBe(422);
    expect(first.json().error.message).toMatch(/^REPO_NOT_PUBLIC/);
    expect(await rowCount(h)).toBe(0);
    h.ctx.github.repos.set(`${REPO.owner}/${REPO.name}`.toLowerCase(), saved);
    expect((await publish(h, preview)).statusCode).toBe(200);
    h.ctx.github.repos.clear();
    const retry = await publish(h, preview);
    expect(retry.statusCode).toBe(422);
    expect(retry.json().plan).toBeUndefined();
  });

  it("SEC-GH-13 a GitHub outage at publish refuses with 503 NOT_READY and no plan (never an unchecked plan), on both paths", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    h.ctx.github.rateLimited = true;
    const limited = await publish(h, preview);
    expect(limited.statusCode).toBe(503);
    expect(limited.json().error.code).toBe("NOT_READY");
    expect(limited.json().plan).toBeUndefined();
    expect(await rowCount(h)).toBe(0);
    expect(publicationsQuota(h)).toBeUndefined();
    h.ctx.github.rateLimited = false;
    expect((await publish(h, preview)).statusCode).toBe(200);
    // Upstream failure on the existing-row path.
    const getRepoById = h.ctx.github.getRepoById.bind(h.ctx.github);
    h.ctx.github.getRepoById = async () => {
      throw new GitHubGatewayError("UPSTREAM", "GitHub returned 502");
    };
    const down = await publish(h, preview);
    expect(down.statusCode).toBe(503);
    expect(down.json().error.code).toBe("NOT_READY");
    expect(down.json().plan).toBeUndefined();
    h.ctx.github.getRepoById = getRepoById;
    expect((await publish(h, preview)).json().plan).not.toBeNull();
  });

  it("SEC-GH-13 an unlinked GitHub account is 409 without a plan", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    h.ctx.github.linkedUsers.delete(h.session.userId);
    const refused = await publish(h, preview);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("CONFLICT");
    expect(refused.json().plan).toBeUndefined();
    expect(await rowCount(h)).toBe(0);
    expect(publicationsQuota(h)).toBeUndefined();
  });

  it("the recheck runs on the existing-row path after the chain re-check: an on-chain claim is returned without a plan even if the repository is private", async () => {
    const h = harnessOf();
    const { preview } = await previewed(h);
    expect((await publish(h, preview)).statusCode).toBe(200);
    setVisibility(h, "private");
    const market = "0x00000000000000000000000000000000000ca1e5" as Address;
    h.chain.markets.set(`${h.session.wallet.toLowerCase()}|${preview.documentSha256}`, market);
    const before = githubQuota(h);
    const retry = await publish(h, preview);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ plan: null, publication: { state: "mined", market } });
    // No plan would be returned, so GitHub was not asked.
    expect(githubQuota(h)).toBe(before);
  });
});
