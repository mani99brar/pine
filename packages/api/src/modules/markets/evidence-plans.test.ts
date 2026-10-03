// Must stay the first import: serializes the memory-heavy markets test files (see test/lock.ts).
import "./test/lock.js";
import { describe, expect, it } from "vitest";
import { computeEvidenceCommitment } from "@pine/shared/evidence";
import { buildStep, newPlan, verifyPlan } from "@pine/shared/tx-plan";
import type { Hex32 } from "@pine/shared/types";
import { MARKETS_PLAN_LIMITS } from "./common.js";
import { addClaim, EVIDENCE_REGISTRY, exampleManifest, MANIFEST, observableText, postJson, storeManifest, useHarness, verifiedPlan } from "./test/helpers.js";

const harnessOf = useHarness();
const SALT = `0x${"5a17".repeat(16)}` as Hex32;
const COMMITMENT = `0x${"c0".repeat(32)}` as Hex32;

describe("POST /api/v1/evidence/plans/commit", () => {
  it("returns a verified one-step commit plan bound to the registered market and the session wallet", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "c1");
    const response = await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: COMMITMENT });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    const plan = verifiedPlan(body.plan, claim);
    expect(plan.account).toBe(h.session.wallet);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ allowlistId: "evidenceRegistry.commitEvidence", to: EVIDENCE_REGISTRY, value: 0n, args: [claim.market, COMMITMENT] });
    expect(body.planState).toMatchObject({ kind: "evidence_commit", state: "planned", market: claim.market, expiresAt: Math.min(claim.evidenceDeadline - 60, h.ctx.clock.unix() + 86_400) });
    expect(h.ctx.compliance.calls).toEqual([{ wallet: h.session.wallet, action: "submit_evidence" }]);
  });

  it("SEC-TX-08 same key and body returns the identical plan and consumes one quota unit; another body is 409", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "c2");
    const first = await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: COMMITMENT }, { key: "retry-1" });
    const again = await postJson(h, "/api/v1/evidence/plans/commit", { commitment: COMMITMENT, market: claim.market.toUpperCase().replace("0X", "0x") }, { key: "retry-1" });
    expect(again.statusCode).toBe(200);
    expect(again.json().plan).toEqual(first.json().plan);
    expect(h.ctx.quotas.used.get(`${h.session.userId}:plans_per_day`)).toBe(1);
    const other = await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: `0x${"c1".repeat(32)}` }, { key: "retry-1" });
    expect(other.statusCode).toBe(409);
    expect(h.ctx.quotas.used.get(`${h.session.userId}:plans_per_day`)).toBe(1);
    expect(h.ctx.audit.entries.filter((entry) => entry.action === "markets.plan.created")).toEqual([
      expect.objectContaining({ actorUserId: h.session.userId, subjectId: first.json().planState.id, details: expect.objectContaining({ route: "evidence.commit", kind: "evidence_commit", steps: 1 }) }),
    ]);
    // The key is scoped to (user, route): the same key on another route or for another user is independent.
    const other2 = await h.user();
    expect((await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: COMMITMENT }, { key: "retry-1", headers: other2.headers })).statusCode).toBe(201);
  });

  it("SEC-TX-08 a same-key replay returns the stored plan while the read model is halted or lagging (lookup before readiness)", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "c2r");
    const body = { market: claim.market, commitment: COMMITMENT };
    const first = await postJson(h, "/api/v1/evidence/plans/commit", body, { key: "replay-halted" });
    expect(first.statusCode).toBe(201);
    h.ctx.readModel.setHalted(true);
    const replayed = await postJson(h, "/api/v1/evidence/plans/commit", body, { key: "replay-halted" });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toEqual(first.json());
    expect((await postJson(h, "/api/v1/evidence/plans/commit", { ...body, commitment: `0x${"c2".repeat(32)}` }, { key: "replay-halted" })).statusCode).toBe(409);
    // A new key needs a fresh read model, and the refusal burns no quota.
    const fresh = await postJson(h, "/api/v1/evidence/plans/commit", body, { key: "replay-new" });
    expect(fresh.json().error.code).toBe("NOT_READY");
    h.ctx.readModel.setHalted(false);
    h.at(h.ctx.clock.unix() + h.ctx.config.maxIndexerLagSeconds + 1);
    expect((await postJson(h, "/api/v1/evidence/plans/commit", body, { key: "replay-halted" })).json()).toEqual(first.json());
    expect((await postJson(h, "/api/v1/evidence/plans/commit", body, { key: "replay-new" })).json().error.code).toBe("NOT_READY");
    expect(h.ctx.quotas.used.get(`${h.session.userId}:plans_per_day`)).toBe(1);
    expect(await h.ctx.database.sql.query("SELECT id FROM markets_plans")).toHaveLength(1);
  });

  it("SEC-TX-08 two concurrent first requests with one key store one plan and both return it", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "c2b");
    const body = { market: claim.market, commitment: COMMITMENT };
    const [a, b] = await Promise.all([postJson(h, "/api/v1/evidence/plans/commit", body, { key: "race" }), postJson(h, "/api/v1/evidence/plans/commit", body, { key: "race" })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().plan).toEqual(b.json().plan);
    expect(await h.ctx.database.sql.query("SELECT id FROM markets_plans")).toHaveLength(1);
    expect(await h.ctx.database.sql.query("SELECT step_id FROM markets_plan_steps")).toHaveLength(1);
    expect(h.ctx.audit.entries.filter((entry) => entry.action === "markets.plan.created")).toHaveLength(1);
  });

  it("SEC-TX-01 binds what verifyPlan does not: the module refuses unregistered markets, verifyPlan the target", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "c2c");
    const wire = (await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: COMMITMENT })).json().plan;
    // verifyPlan binds no market for evidence steps (PRD-04 section 2.2), so the module's own registered-market check is
    // the only guard: an unregistered market never gets a plan.
    expect(verifiedPlan(wire, null).steps[0]?.args[0]).toBe(claim.market);
    expect((await postJson(h, "/api/v1/evidence/plans/commit", { market: "0x00000000000000000000000000000000000000c1", commitment: COMMITMENT })).statusCode).toBe(404);
    expect(() => verifiedPlan({ ...wire, steps: [{ ...wire.steps[0], to: "0x00000000000000000000000000000000000000ff" }] }, claim)).toThrow(/deployment manifest/);
  });

  it("SEC-TX-08 requires a well-formed Idempotency-Key", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "c3");
    for (const key of [null, "", "has space", "x".repeat(65)]) {
      const response = await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: COMMITMENT }, { key });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_FAILED");
    }
    expect(h.ctx.quotas.used.size).toBe(0);
  });

  it("a QUOTA_EXCEEDED leaves no stored plan", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "c4");
    h.ctx.quotas.limits.plans_per_day = 0;
    const response = await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: COMMITMENT });
    expect(response.statusCode).toBe(429);
    expect(await h.ctx.database.sql.query("SELECT id FROM markets_plans")).toEqual([]);
  });

  it("refuses unregistered markets and markets of another claim registry", async () => {
    const h = harnessOf();
    await addClaim(h, "c5");
    const response = await postJson(h, "/api/v1/evidence/plans/commit", { market: "0x00000000000000000000000000000000000000c0", commitment: COMMITMENT });
    expect(response.statusCode).toBe(404);
    const { claimCreated } = await import("@pine/shared/testing/read-model-scenarios");
    const foreign = { ...claimCreated(h.b.nextBlock(), "foreign"), address: "0x00000000000000000000000000000000000f0e1a" as const };
    await h.apply(foreign);
    expect((await postJson(h, "/api/v1/evidence/plans/commit", { market: foreign.market, commitment: COMMITMENT })).statusCode).toBe(404);
    // No plan; plans_per_day precedes the build (PRD-04 4b), so each refused key spent one unit.
    expect(await h.ctx.database.sql.query("SELECT id FROM markets_plans")).toEqual([]);
    expect(h.ctx.quotas.used.get(`${h.session.userId}:plans_per_day`)).toBe(2);
  });

  it("enforces the 60 s submission margin before the evidence deadline", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "c6");
    h.at(claim.evidenceDeadline - 61);
    await h.fresh();
    expect((await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: COMMITMENT })).statusCode).toBe(201);
    h.at(claim.evidenceDeadline - 60);
    await h.fresh();
    const late = await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: COMMITMENT });
    expect(late.statusCode).toBe(422);
    expect(late.json().error.message).toMatch(/window has closed/);
  });

  it("SEC-IDX-07 refuses with NOT_READY when the read model is stale or halted", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "c7");
    h.at(h.ctx.clock.unix() + h.ctx.config.maxIndexerLagSeconds + 1);
    const stale = await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: COMMITMENT });
    expect(stale.statusCode).toBe(503);
    expect(stale.json().error.code).toBe("NOT_READY");
    await h.fresh();
    h.ctx.readModel.setHalted(true);
    expect((await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: COMMITMENT })).json().error.code).toBe("NOT_READY");
    expect(h.ctx.quotas.used.size).toBe(0);
  });

  it("SEC-LEGAL-01 compliance refusals return no plan (blocked wallet 451, terms 403)", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "c8");
    h.ctx.compliance.blockedWallets.add(h.session.wallet);
    expect((await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: COMMITMENT })).statusCode).toBe(451);
    h.ctx.compliance.blockedWallets.clear();
    h.ctx.compliance.termsMissing.add(h.session.userId);
    expect((await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: COMMITMENT })).json().error.code).toBe("TERMS_REQUIRED");
    expect(await h.ctx.database.sql.query("SELECT id FROM markets_plans")).toEqual([]);
  });

  it("refuses a zero commitment", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "c9");
    expect((await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: `0x${"0".repeat(64)}` })).statusCode).toBe(400);
  });
});

describe("verifyPlan limits of the markets lane (PRD-04 section 1)", () => {
  it("SEC-TX-03 at most 10,000 xDAI of value and no approvals at all", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "limits");
    expect(MARKETS_PLAN_LIMITS).toEqual({ maxTotalValueWei: 10_000n * 10n ** 18n, maxApprovalAmount: 0n });
    const context = { markets: new Map([[claim.market, [claim.yesToken, claim.noToken, claim.invalidToken]]]), questionIds: new Set([claim.questionId]) };
    const approve = buildStep(MANIFEST, { id: "approve", allowlistId: "outcomeToken.approve", to: claim.yesToken, args: [MANIFEST.seer.gnosisRouter, 1n] });
    const merge = buildStep(MANIFEST, { id: "merge", allowlistId: "gnosisRouter.mergeToBase", args: [claim.market, 1n], dependsOn: ["approve"] });
    expect(() => verifyPlan(newPlan(MANIFEST, "p1", h.session.wallet, [approve, merge]), MANIFEST, context, MARKETS_PLAN_LIMITS)).toThrow(/approval amount/);
    const answer = (value: bigint) => buildStep(MANIFEST, { id: "answer", allowlistId: "realitio.submitAnswer", args: [claim.questionId, `0x${"0".repeat(64)}`, 0n], value });
    expect(verifyPlan(newPlan(MANIFEST, "p2", h.session.wallet, [answer(10_000n * 10n ** 18n)]), MANIFEST, context, MARKETS_PLAN_LIMITS)).toBe(10_000n * 10n ** 18n);
    expect(() => verifyPlan(newPlan(MANIFEST, "p3", h.session.wallet, [answer(10_000n * 10n ** 18n + 1n)]), MANIFEST, context, MARKETS_PLAN_LIMITS)).toThrow();
  });
});

describe("salts (SEC-EVID-13, PRD-04 section 2.2)", () => {
  it("no route accepts a salt: every JSON POST route of the module refuses it, and it is never stored or logged", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "s1");
    // Plausible bodies so that only the extra `salt` field can be the reason for the refusal.
    const bodies: Record<string, Record<string, unknown>> = {
      "/api/v1/evidence/manifests": { ...exampleManifest(claim, h.session.wallet) },
      "/api/v1/evidence/plans/commit": { market: claim.market, commitment: COMMITMENT },
      "/api/v1/evidence/plans/publish": { market: claim.market, contentSha256: COMMITMENT },
      "/api/v1/evidence/reveal-template": { submissionId: "1", contentSha256: COMMITMENT },
      "/api/v1/oracle/plans/submit-answer": { market: claim.market, outcome: "yes", bond: "1000000000000000000" },
      "/api/v1/oracle/plans/fund-bounty": { market: claim.market, amount: "5" },
      "/api/v1/markets/plans/:planId/submitted": { stepId: "commit", txHash: `0x${"ab".repeat(32)}` },
    };
    const posts = h.routes.filter((route) => route.method === "POST" && route.url !== "/api/v1/evidence/artifacts");
    // 15 JSON POST routes (the multipart artifact route refuses unknown fields itself, see evidence-content.test.ts).
    expect(posts).toHaveLength(15);
    for (const route of posts) {
      const url = route.url.replace(":planId", "00000000-0000-4000-8000-000000000001").replace(":id", "00000000-0000-4000-8000-000000000002");
      const base = bodies[route.url] ?? (route.url === "/api/v1/oracle/plans/withdraw" || route.url.endsWith("/read") ? {} : { market: claim.market });
      const response = await postJson(h, url, { ...base, salt: SALT });
      expect({ url: route.url, status: response.statusCode, code: response.json().error?.code }).toEqual({ url: route.url, status: 400, code: "VALIDATION_FAILED" });
      expect(response.body.toLowerCase()).not.toContain(SALT.slice(2));
    }
    expect(h.ctx.contentStore.items.size).toBe(0);
    expect(h.ctx.quotas.used.size).toBe(0);
    expect(await observableText(h)).not.toContain(SALT.slice(2));
  });
});

describe("POST /api/v1/evidence/plans/publish", () => {
  it("returns a verified publish plan for a stored manifest of the session wallet", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "p1");
    const sha = await storeManifest(h, exampleManifest(claim, h.session.wallet));
    const response = await postJson(h, "/api/v1/evidence/plans/publish", { market: claim.market, contentSha256: sha });
    expect(response.statusCode).toBe(201);
    const plan = verifiedPlan(response.json().plan, claim);
    expect(plan.steps[0]).toMatchObject({ allowlistId: "evidenceRegistry.publishEvidence", args: [claim.market, sha] });
  });

  it("enforces the 60 s submission margin before the evidence deadline", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "p3");
    const sha = await storeManifest(h, exampleManifest(claim, h.session.wallet));
    h.at(claim.evidenceDeadline - 61);
    await h.fresh();
    const inTime = await postJson(h, "/api/v1/evidence/plans/publish", { market: claim.market, contentSha256: sha });
    expect(inTime.statusCode).toBe(201);
    expect(inTime.json().planState.expiresAt).toBe(claim.evidenceDeadline - 60);
    h.at(claim.evidenceDeadline - 60);
    await h.fresh();
    expect((await postJson(h, "/api/v1/evidence/plans/publish", { market: claim.market, contentSha256: sha })).statusCode).toBe(422);
  });

  it("refuses when the manifest is not stored, belongs to another submitter or another claim", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "p2");
    const other = await addClaim(h, "p2-other");
    const missing = await postJson(h, "/api/v1/evidence/plans/publish", { market: claim.market, contentSha256: COMMITMENT });
    expect(missing.statusCode).toBe(422);
    const foreign = await storeManifest(h, exampleManifest(claim, "0x00000000000000000000000000000000000000b0"));
    expect((await postJson(h, "/api/v1/evidence/plans/publish", { market: claim.market, contentSha256: foreign })).statusCode).toBe(422);
    const wrongClaim = await storeManifest(h, exampleManifest(other, h.session.wallet));
    expect((await postJson(h, "/api/v1/evidence/plans/publish", { market: claim.market, contentSha256: wrongClaim })).statusCode).toBe(422);
    expect(await h.ctx.database.sql.query("SELECT id FROM markets_plans")).toEqual([]);
    expect(h.ctx.quotas.used.get(`${h.session.userId}:plans_per_day`)).toBe(3);
  });
});

describe("POST /api/v1/evidence/reveal-template", () => {
  async function committed(h: ReturnType<typeof harnessOf>, seed: string) {
    const claim = await addClaim(h, seed);
    const sha = await storeManifest(h, exampleManifest(claim, h.session.wallet));
    const commitment = computeEvidenceCommitment({ chainId: 100, registry: EVIDENCE_REGISTRY, market: claim.market, submitter: h.session.wallet, contentSha256: sha, salt: SALT });
    h.b.nextBlock();
    await h.apply({ ...h.b.envelope(EVIDENCE_REGISTRY), kind: "EvidenceCommitted", submissionId: 7n, market: claim.market, submitter: h.session.wallet, commitment, committedAt: h.b.now() });
    h.at(h.b.now() + 10);
    await h.fresh();
    return { claim, sha, commitment };
  }

  it("returns a salt-free template the client completes and verifies with its own copy of @pine/shared", async () => {
    const h = harnessOf();
    const { claim, sha, commitment } = await committed(h, "r1");
    h.at(claim.evidenceDeadline + 100);
    await h.fresh();
    const response = await postJson(h, "/api/v1/evidence/reveal-template", { submissionId: "7", contentSha256: sha }, { key: null });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.template).toMatchObject({
      chainId: 100,
      registry: EVIDENCE_REGISTRY,
      function: "revealEvidence(uint256,bytes32,bytes32)",
      submissionId: "7",
      contentSha256: sha,
      commitment,
      revealDeadline: claim.revealDeadline,
      expiresAt: claim.revealDeadline - 60,
    });
    expect(body.warnings).toEqual([]);
    expect(JSON.stringify(body).toLowerCase()).not.toContain("salt\":");
    // The client side: commitment check with its own salt, then its own buildStep/verifyPlan.
    expect(computeEvidenceCommitment({ chainId: 100, registry: body.template.registry, market: body.template.market, submitter: body.template.account, contentSha256: sha, salt: SALT })).toBe(body.template.commitment);
    const step = buildStep(MANIFEST, { id: "reveal", allowlistId: "evidenceRegistry.revealEvidence", args: [7n, sha, SALT] });
    const plan = newPlan(MANIFEST, "client-plan", h.session.wallet, [step]);
    expect(verifyPlan(plan, MANIFEST, { markets: new Map(), questionIds: new Set() }, { maxTotalValueWei: 0n, maxApprovalAmount: 0n })).toBe(0n);
    expect(await h.ctx.database.sql.query("SELECT id FROM markets_plans")).toEqual([]);
  });

  it("requires acknowledgement and warns when the manifest is not available to adjudicators", async () => {
    const h = harnessOf();
    const { claim } = await committed(h, "r2");
    h.at(claim.evidenceDeadline + 100);
    await h.fresh();
    const unstored = `0x${"ab".repeat(32)}`;
    const refused = await postJson(h, "/api/v1/evidence/reveal-template", { submissionId: "7", contentSha256: unstored }, { key: null });
    expect(refused.statusCode).toBe(422);
    const acknowledged = await postJson(h, "/api/v1/evidence/reveal-template", { submissionId: "7", contentSha256: unstored, unavailableContentAcknowledged: true }, { key: null });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json().warnings).toEqual([expect.objectContaining({ code: "manifest_unavailable", text: expect.stringMatching(/inadmissible/) })]);
  });

  it("SEC-LEGAL-01 / SEC-IDX-07 refuses on compliance and on a stale or halted read model", async () => {
    const h = harnessOf();
    const { claim, sha } = await committed(h, "r4");
    h.at(claim.evidenceDeadline + 100);
    await h.fresh();
    h.ctx.compliance.blockedActions.add("submit_evidence");
    expect((await postJson(h, "/api/v1/evidence/reveal-template", { submissionId: "7", contentSha256: sha }, { key: null })).statusCode).toBe(451);
    h.ctx.compliance.blockedActions.clear();
    h.ctx.readModel.setHalted(true);
    const halted = await postJson(h, "/api/v1/evidence/reveal-template", { submissionId: "7", contentSha256: sha }, { key: null });
    expect(halted.statusCode).toBe(503);
    expect(halted.json().error.code).toBe("NOT_READY");
  });

  it("is only for the submitter's own still-committed submission and before revealDeadline - 60 s", async () => {
    const h = harnessOf();
    const { claim, sha } = await committed(h, "r3");
    const stranger = await h.user();
    h.at(claim.revealDeadline - 61);
    await h.fresh();
    expect((await postJson(h, "/api/v1/evidence/reveal-template", { submissionId: "7", contentSha256: sha }, { key: null, headers: stranger.headers })).statusCode).toBe(404);
    expect((await postJson(h, "/api/v1/evidence/reveal-template", { submissionId: "7", contentSha256: sha }, { key: null })).statusCode).toBe(200);
    h.at(claim.revealDeadline - 60);
    await h.fresh();
    expect((await postJson(h, "/api/v1/evidence/reveal-template", { submissionId: "7", contentSha256: sha }, { key: null })).statusCode).toBe(422);
    h.b.nextBlock();
    await h.apply({ ...h.b.envelope(EVIDENCE_REGISTRY), kind: "EvidenceRevealed", submissionId: 7n, market: claim.market, submitter: h.session.wallet, contentSha256: sha, committedAt: 1, revealedAt: h.b.now() });
    h.at(claim.evidenceDeadline + 100);
    await h.fresh();
    expect((await postJson(h, "/api/v1/evidence/reveal-template", { submissionId: "7", contentSha256: sha }, { key: null })).statusCode).toBe(409);
  });
});
