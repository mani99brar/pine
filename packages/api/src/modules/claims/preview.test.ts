// Must stay the first import: serializes the memory-heavy claims test files (see test/lock.ts).
import "./test/lock.js";
import { describe, expect, it } from "vitest";
import { rawCidFromBytes } from "@pine/shared/canonical";
import { encodeClaimDocument, parseClaimDocumentBytes } from "@pine/shared/claim-document";
import { buildDeploymentManifest } from "@pine/shared/deployment";
import { renderQuestion, tokenNames } from "@pine/shared/question";
import { BASE_COMMIT, BOT_POLICY_SHA, createDraft, createPreview, draftBody, publish, REPO, TARGET_COMMIT, useHarness } from "./test/helpers.js";

const harnessOf = useHarness();

const previewOf = (h: ReturnType<typeof harnessOf>, draftId: string, payload: unknown = { attestLiveSystemImpactNone: true }, headers = h.headers) =>
  h.app.inject({ method: "POST", url: `/api/v1/drafts/${draftId}/preview`, headers, payload: payload as Record<string, unknown> });

describe("preview", () => {
  it("freezes a canonical document with manifest constants, the rendered question and token names", async () => {
    const h = harnessOf();
    const draft = await createDraft(h);
    const preview = await createPreview(h, draft.id);
    const manifest = buildDeploymentManifest(h.ctx.config.contracts);
    const now = h.ctx.clock.unix();
    const document = preview.document;

    expect(document.creator).toBe(h.session.wallet.toLowerCase());
    expect(document.policy).toEqual({ id: "BOT-001", version: "0.1.0", sha256: BOT_POLICY_SHA });
    expect(document.target.repository).toEqual({ id: REPO.id, ownerLogin: REPO.owner, name: REPO.name });
    expect(document.target.membership).toMatchObject({ method: "pull_head", ref: { kind: "pull", number: 2101 } });
    expect(document.market).toMatchObject({
      chainId: 100,
      claimRegistry: manifest.pine.claimRegistry,
      seerMarketFactory: manifest.seer.marketFactory,
      collateralToken: manifest.seer.collateralToken,
      realitio: manifest.seer.realitio,
      arbitrator: manifest.seer.arbitrator,
      questionTimeoutSeconds: manifest.seer.questionTimeoutSeconds,
      minBondWei: (10n ** 19n).toString(),
    });
    expect(document.evidence.registry).toBe(manifest.pine.evidenceRegistry);
    expect(document.evidence.evidenceDeadline).toBe(now + 7 * 86_400);
    expect(document.evidence.revealDeadline).toBe(document.evidence.evidenceDeadline + 48 * 3_600);
    expect(document.market.openingTime).toBe(document.evidence.revealDeadline);
    expect(document.disclosure).toEqual({ liveSystemImpact: "none" });
    expect(document.createdAt).toBe("2026-10-01T00:00:00Z");

    const encoded = encodeClaimDocument(document);
    expect(preview.documentSha256).toBe(encoded.sha256);
    expect(preview.cid).toBe(rawCidFromBytes(encoded.bytes));
    expect(preview.question).toBe(
      renderQuestion({
        evidenceRegistry: manifest.pine.evidenceRegistry,
        title: document.claim.title,
        evidenceDeadline: document.evidence.evidenceDeadline,
        revealDeadline: document.evidence.revealDeadline,
        repositoryId: REPO.id,
        commit: TARGET_COMMIT,
        claimDocumentSha256: encoded.sha256,
        policyDocumentSha256: BOT_POLICY_SHA,
      }),
    );
    expect(preview.tokenNames).toEqual([...tokenNames(encoded.sha256)]);

    // The stored preview holds exactly the canonical bytes of the returned document.
    const [row] = await h.ctx.database.sql.query<{ document: Uint8Array; document_sha256: string }>("SELECT document, document_sha256 FROM claim_previews WHERE id = $1", [preview.previewId]);
    expect(parseClaimDocumentBytes(row!.document, preview.documentSha256)).toEqual(document);

    expect(preview.timeline).toMatchObject({
      evidenceDeadline: { unix: document.evidence.evidenceDeadline },
      revealDeadline: { unix: document.evidence.revealDeadline },
      answersOpen: { unix: document.evidence.revealDeadline },
      earliestFinalization: { unix: document.evidence.revealDeadline + 302_400 },
    });
    expect(String(preview.timeline.arbitration)).toMatch(/16-20 days.*0\.1674 ETH/);
    expect(preview.costs).toMatchObject({ estimatedGas: "1800000", gasPriceWei: "2000000000", estimatedCostWei: (1_800_000n * 2_000_000_000n).toString() });
    expect(String(preview.costs.note)).toMatch(/[Ff]unding .* separate/);
    expect(preview.disclosures.map((item) => item.code)).toEqual(
      expect.arrayContaining(["no_is_not_certification", "price_is_not_probability", "liquidity_is_not_bounty", "invalid_is_not_refund", "deadlines_are_not_trading_cutoffs", "min_bond", "liveness"]),
    );
    // Preview-to-publish cap: the plan is offered for at most 24 h after the preview.
    expect(preview.planExpiresAt).toBe(now + 86_400);
  });

  it("is deterministic except for nonce and createdAt", async () => {
    const h = harnessOf();
    const draft = await createDraft(h);
    const first = await createPreview(h, draft.id);
    const second = await createPreview(h, draft.id);
    expect(first.document.nonce).not.toBe(second.document.nonce);
    expect(first.documentSha256).not.toBe(second.documentSha256);
    const strip = (document: typeof first.document) => ({ ...document, nonce: null, createdAt: null });
    expect(strip(first.document)).toEqual(strip(second.document));
  });

  it("requires the explicit live-system-impact attestation", async () => {
    const h = harnessOf();
    const draft = await createDraft(h);
    const refused = await previewOf(h, draft.id, { attestLiveSystemImpactNone: false });
    expect(refused.statusCode).toBe(422);
    expect((await previewOf(h, draft.id, {})).statusCode).toBe(400);
    expect((await previewOf(h, draft.id, { attestLiveSystemImpactNone: "true" })).statusCode).toBe(400);
    const [count] = await h.ctx.database.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM claim_previews");
    expect(count!.n).toBe(0);
  });

  it("refuses when commit membership cannot be proven (SEC-GH-11)", async () => {
    const h = harnessOf();
    const draft = await createDraft(h, draftBody({ commit: "f".repeat(40) }));
    const response = await previewOf(h, draft.id);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toMatch(/not part of/);
    const branch = await createDraft(h, draftBody({ membership: { kind: "branch", name: "main" } }));
    expect((await previewOf(h, branch.id)).statusCode).toBe(422);
    const [count] = await h.ctx.database.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM claim_previews");
    expect(count!.n).toBe(0);
  });

  it("proves a pull request's base commit against the base branch history", async () => {
    const h = harnessOf();
    const regression = await createDraft(h, draftBody({ regressionOnly: true, baseCommit: BASE_COMMIT }));
    const preview = await createPreview(h, regression.id);
    expect(preview.document.target.baseCommit).toBe(BASE_COMMIT);
    const notInBase = await createDraft(h, draftBody({ regressionOnly: true, baseCommit: "e".repeat(40) }));
    expect((await previewOf(h, notInBase.id)).statusCode).toBe(422);
  });

  it("refuses when GitHub is not linked", async () => {
    const h = harnessOf();
    const draft = await createDraft(h);
    h.ctx.github.linkedUsers.delete(h.session.userId);
    expect((await previewOf(h, draft.id)).statusCode).toBe(403);
  });

  it("a draft whose repository became private: 422 and no preview row (SEC-GH-13, PRD-03 §8c)", async () => {
    const h = harnessOf();
    const draft = await createDraft(h);
    const previewRows = async () => (await h.ctx.database.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM claim_previews"))[0]!.n;
    // The gateway refuses it (REPO_NOT_PUBLIC).
    h.ctx.github.addRepo(
      { id: REPO.id, owner: REPO.owner, ownerId: 1, name: REPO.name, fullName: `${REPO.owner}/${REPO.name}`, fork: false, defaultBranch: "main", htmlUrl: `https://github.com/${REPO.owner}/${REPO.name}`, pushedAt: null },
      { visibility: "private" },
    );
    const refused = await previewOf(h, draft.id);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe("UNPROCESSABLE");
    expect(await previewRows()).toBe(0);
    // A gateway answer that is not explicitly public is refused by the module itself as well.
    const getRepo = h.ctx.github.getRepo.bind(h.ctx.github);
    h.ctx.github.addRepo({ id: REPO.id, owner: REPO.owner, ownerId: 1, name: REPO.name, fullName: `${REPO.owner}/${REPO.name}`, fork: false, defaultBranch: "main", htmlUrl: `https://github.com/${REPO.owner}/${REPO.name}`, pushedAt: null });
    h.ctx.github.getRepo = async (...args) => ({ ...(await getRepo(...args)), private: true }) as unknown as Awaited<ReturnType<typeof getRepo>>;
    const leaked = await previewOf(h, draft.id);
    expect(leaked.statusCode).toBe(422);
    expect(await previewRows()).toBe(0);
    // Public again: the same draft previews.
    h.ctx.github.getRepo = getRepo;
    await createPreview(h, draft.id);
    expect(await previewRows()).toBe(1);
  });

  it("rounds the evidence deadline up to the minute and enforces the window bounds after rounding", async () => {
    const h = harnessOf();
    h.ctx.clock.advance(30_000); // now = ...:00:30
    const now = h.ctx.clock.unix();
    const rounded = await createPreview(h, (await createDraft(h, draftBody({ evidenceWindowSeconds: 3 * 86_400 }))).id);
    expect(rounded.document.evidence.evidenceDeadline).toBe(now + 3 * 86_400 + 30);
    expect(rounded.document.evidence.evidenceDeadline % 60).toBe(0);

    const atMax = await createDraft(h, draftBody({ evidenceWindowSeconds: 30 * 86_400 }));
    const tooLong = await previewOf(h, atMax.id);
    expect(tooLong.statusCode).toBe(422);
    expect(tooLong.json().error.message).toContain(String(30 * 86_400 - 60));
    const justUnder = await createDraft(h, draftBody({ evidenceWindowSeconds: 30 * 86_400 - 60 }));
    const accepted = await createPreview(h, justUnder.id);
    expect(accepted.document.evidence.evidenceDeadline - now).toBe(30 * 86_400 - 30);

    // A configured minimum above the API floor applies too.
    const variant = await h.variant({ claims: { ...h.ctx.config.claims, minEvidenceWindowSeconds: 5 * 86_400 } });
    const short = await variant.app.inject({ method: "POST", url: `/api/v1/drafts/${atMax.id}/preview`, headers: h.headers, payload: { attestLiveSystemImpactNone: true } });
    expect(short.statusCode).toBe(422);
    const shortDraft = await createDraft(h, draftBody({ evidenceWindowSeconds: 4 * 86_400 }));
    const below = await variant.app.inject({ method: "POST", url: `/api/v1/drafts/${shortDraft.id}/preview`, headers: h.headers, payload: { attestLiveSystemImpactNone: true } });
    expect(below.statusCode).toBe(400);
  });

  it("applies the policy gate again at preview (draft policies refused when allowDraftPolicies is false)", async () => {
    const h = harnessOf();
    const draft = await createDraft(h);
    const strict = await h.variant({ claims: { ...h.ctx.config.claims, allowDraftPolicies: false } });
    const response = await strict.app.inject({ method: "POST", url: `/api/v1/drafts/${draft.id}/preview`, headers: h.headers, payload: { attestLiveSystemImpactNone: true } });
    expect(response.statusCode).toBe(422);
    const disabledFamily = await h.variant({ claims: { ...h.ctx.config.claims, enabledPolicyFamilies: ["FUNC-001"] } });
    const refused = await disabledFamily.app.inject({ method: "POST", url: `/api/v1/drafts/${draft.id}/preview`, headers: h.headers, payload: { attestLiveSystemImpactNone: true } });
    expect(refused.json().error.code).toBe("FEATURE_DISABLED");
  });

  it("deleting a draft without publications removes its previews; a later publication naming one is NOT_FOUND", async () => {
    const h = harnessOf();
    const draft = await createDraft(h);
    const preview = await createPreview(h, draft.id);
    expect((await h.app.inject({ method: "DELETE", url: `/api/v1/drafts/${draft.id}`, headers: h.headers })).statusCode).toBe(204);
    const [count] = await h.ctx.database.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM claim_previews WHERE draft_id = $1", [draft.id]);
    expect(count!.n).toBe(0);
    const response = await publish(h, preview);
    expect(response.statusCode).toBe(404);
  });

  it("keeps the preview usable when the gas price RPC fails (estimate omitted)", async () => {
    const h = harnessOf();
    h.ctx.chain.setHandler(async () => {
      throw new Error("rpc down");
    });
    const preview = await createPreview(h, (await createDraft(h)).id);
    expect(preview.costs).toMatchObject({ gasPriceWei: null, estimatedCostWei: null, estimatedGas: "1800000" });
  });
});
