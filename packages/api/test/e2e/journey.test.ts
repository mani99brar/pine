// The SPEC section 3 customer journey through the whole backend (PRD-06 section 3): SIWE login, GitHub link (fake
// GitHub), draft, preview, publication plan, simulated ClaimCreated, reconciliation to `confirmed`, integrity
// `verified`, listings and the agent feed, a funding ladder plan, evidence manifest upload with commit/reveal plans and
// the simulated reveal, oracle status and due actions, a simulated answer and resolution, and a redeem plan.
// Every plan in a response is decoded with planFromWire and verified with verifyPlan by the harness (support/app.ts).

import { randomBytes } from "node:crypto";
import { decodeFunctionData, keccak256, toBytes, toFunctionSelector } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimRegistryAbi, evidenceRegistryAbi } from "@pine/shared/abi/generated";
import { algebraPositionManagerAbi } from "@pine/shared/abi/algebra";
import { erc20Abi } from "@pine/shared/abi/external";
import type { ClaimCreatedEvent } from "@pine/shared/chain-events";
import { computeEvidenceCommitment, encodeEvidenceManifest, type EvidenceManifest } from "@pine/shared/evidence";
import { buildStep, newPlan, verifyPlan, type TxPlan } from "@pine/shared/tx-plan";
import type { Address, Hex32 } from "@pine/shared/types";
import { historyHashAfter } from "../../src/modules/markets/history.js";
import { ORACLE_CACHE_SECONDS } from "../../src/modules/markets/oracle.js";
import { Browser, CLIENT_PLAN_LIMITS, createE2e, multipart, ORIGIN, TERMS_DIGEST, USER_CONTENT_ORIGIN, XDAI, type E2e } from "./support/app.js";
import { txHashOf } from "./support/chain.js";
import { assertNoSecretLeaks, assertNoSecretsPersisted } from "./support/leaks.js";
import { account, createDraft, createPreview, linkGitHub, mineCreateClaim, PULL_NUMBER, seedRepository, TARGET_COMMIT, type PreviewBody, type PublicationBody } from "./support/scenario.js";

const DAY = 86_400;
let e2e: E2e;
let creator: Browser;
let researcher: Browser;
const sessionTokens: string[] = [];

// State carried from step to step (the journey is one story).
let draftId = "";
let preview: PreviewBody;
let publicationId = "";
let createPlan: TxPlan;
let claim: ClaimCreatedEvent;
let manifestSha: Hex32;
let artifactSha: Hex32;
const salt = `0x${randomBytes(32).toString("hex")}` as Hex32;

const lastPlan = (): TxPlan => {
  const verified = e2e.plans.at(-1);
  if (!verified) throw new Error("no verified plan");
  return verified.plan;
};

beforeAll(async () => {
  e2e = await createE2e();
  seedRepository(e2e);
  creator = new Browser(e2e, account(0xc0ffee));
  researcher = new Browser(e2e, account(0xbeef01));
  await e2e.chain.tick();
}, 30 * 60_000);

afterAll(async () => {
  await e2e?.close();
}, 120_000);

describe(`customer journey (SPEC section 3) on ${process.env.PINE_E2E_DATABASE_URL ? "PostgreSQL 16" : "PGlite"}`, () => {
  it("signs in with SIWE (EOA signature verified locally) and accepts the current terms", async () => {
    await creator.signIn();
    expect(creator.session).toMatch(/^pine_s1_/);
    sessionTokens.push(creator.session ?? "");
    const session = await creator.send("GET", "/api/v1/auth/session");
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ wallet: creator.wallet, githubUserId: null, termsDigest: TERMS_DIGEST, termsAccepted: true, isAdmin: false });
    // The session cookie is __Host-, Secure, HttpOnly, SameSite=Lax (SEC-AUTH).
    const verifyResponse = e2e.responses.find((response) => response.url === "/api/v1/auth/siwe/verify");
    const cookie = [verifyResponse?.headers["set-cookie"]].flat().map(String).find((line) => line.startsWith("__Host-pine_session=")) ?? "";
    const attributes = cookie.split(";").map((part) => part.trim().toLowerCase());
    expect(attributes).toEqual(expect.arrayContaining(["httponly", "secure", "samesite=lax", "path=/"]));
    expect(attributes.some((part) => part.startsWith("domain="))).toBe(false);
  });

  it("links GitHub through the OAuth App flow (PKCE S256, state bound to the session) and rotates the session", async () => {
    const { callback, authorizationUrl, previousSession } = await linkGitHub(creator, { githubUserId: 9_001, login: "maintainer" });
    expect(new URL(authorizationUrl).searchParams.get("code_challenge_method")).toBe("S256");
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe(`${ORIGIN}/settings?github=linked`);
    expect(creator.session).not.toBe(previousSession);
    sessionTokens.push(creator.session ?? "");
    // The pre-link session no longer authenticates (rotation on GitHub link).
    const stale = await e2e.request({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: `__Host-pine_session=${previousSession ?? ""}` } });
    expect(stale.statusCode).toBe(401);
    const session = await creator.send("GET", "/api/v1/auth/session");
    expect(session.json()).toMatchObject({ githubUserId: 9_001, githubLogin: "maintainer" });
    // Browsing through the real gateway against the fake GitHub, with the stored (encrypted) token.
    const pull = await creator.send("GET", `/api/v1/github/repos/kleros/kleros-v2/pulls/${PULL_NUMBER}`);
    expect(pull.statusCode).toBe(200);
    expect(pull.json()).toMatchObject({ number: PULL_NUMBER, headSha: TARGET_COMMIT });
    const stored = await e2e.db.api.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM github_tokens WHERE user_id = $1::uuid", [creator.userId]);
    expect(stored[0]?.n).toBeGreaterThan(0);
  });

  it("saves a draft and previews the immutable claim document, question and timeline", async () => {
    draftId = await createDraft(creator);
    preview = await createPreview(creator, draftId);
    expect(preview.document).toMatchObject({
      creator: creator.wallet,
      policy: { id: "BOT-001", version: "0.1.0" },
      target: { repository: { id: 427_016_914, ownerLogin: "kleros", name: "kleros-v2" }, commit: TARGET_COMMIT, membership: { method: "pull_head" } },
      market: { chainId: 100, claimRegistry: e2e.manifest.pine.claimRegistry, minBondWei: "10000000000000000000" },
    });
    expect(preview.document.evidence.evidenceDeadline - e2e.clock.unix()).toBeGreaterThanOrEqual(7 * DAY);
    expect(preview.question).toContain(TARGET_COMMIT);
    expect(preview.question).toContain(preview.documentSha256.slice(2));
  });

  it("returns a verified createClaim publication plan bound to the previewed bytes, once per document", async () => {
    const response = await creator.send("POST", "/api/v1/publications", { body: { previewId: preview.previewId, documentSha256: preview.documentSha256 } });
    expect(response.statusCode).toBe(200);
    const body = response.json<PublicationBody>();
    expect(body.publication.state).toBe("planned");
    publicationId = body.publication.id;
    createPlan = lastPlan();
    expect(createPlan.planId).toBe(body.plan?.planId);
    expect(createPlan.account).toBe(creator.wallet);
    expect(createPlan.steps).toHaveLength(1);
    expect(createPlan.steps[0]).toMatchObject({ allowlistId: "claimRegistry.createClaim", to: e2e.manifest.pine.claimRegistry, value: 0n });
    const [params] = decodeFunctionData({ abi: claimRegistryAbi, data: createPlan.steps[0]?.data ?? "0x" }).args as unknown as [Record<string, unknown>];
    expect(params).toMatchObject({
      claimDocumentSha256: preview.documentSha256,
      repositoryId: 427_016_914n,
      commit: `0x${TARGET_COMMIT}`,
      evidenceDeadline: BigInt(preview.document.evidence.evidenceDeadline),
      revealDeadline: BigInt(preview.document.evidence.revealDeadline),
      minBond: 10n * XDAI,
    });
    // The document is stored (content-addressed) before any plan is returned.
    expect(await e2e.gateways.contentStore.has(preview.documentSha256)).toBe(true);
    // A retry returns the same publication and plan id, never a second row.
    const again = await creator.send("POST", "/api/v1/publications", { body: { previewId: preview.previewId, documentSha256: preview.documentSha256 } });
    expect(again.json<PublicationBody>().publication.id).toBe(publicationId);
    expect(again.json<PublicationBody>().plan?.planId).toBe(createPlan.planId);
    const rows = await e2e.db.api.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM claim_publications WHERE user_id = $1::uuid", [creator.userId]);
    expect(rows[0]?.n).toBe(1);
  });

  it("reconciles the simulated ClaimCreated to `confirmed` from the finalized read model and the creation receipt", async () => {
    const txHash = txHashOf("creator-wallet:createClaim");
    const submitted = await creator.send("POST", `/api/v1/publications/${publicationId}/submitted`, { body: { txHash } });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({ publication: { state: "submitted" } });
    e2e.clock.advance(60_000);
    claim = await mineCreateClaim(e2e, createPlan, txHash);
    await e2e.runJob("claims.reconcile-publications");
    const publication = await creator.send("GET", `/api/v1/publications/${publicationId}`);
    expect(publication.json()).toMatchObject({ publication: { state: "confirmed", market: claim.market } });
    // A late retry never offers a second plan for an existing market (SEC-TX-08).
    const retry = await creator.send("POST", "/api/v1/publications", { body: { previewId: preview.previewId, documentSha256: preview.documentSha256 } });
    expect(retry.json<PublicationBody>().plan).toBeNull();
  });

  it("verifies the claim's integrity, lists it publicly and in the agent feed", async () => {
    await e2e.runJob("claims.verify-integrity");
    const detail = await e2e.request({ method: "GET", url: `/api/v1/claims/${claim.market}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ claim: { market: claim.market, title: claim.title, integrity: { status: "verified" }, listable: true } });
    const list = await e2e.request({ method: "GET", url: "/api/v1/claims" });
    expect(list.json<{ items: { market: string }[] }>().items.map((item) => item.market)).toEqual([claim.market]);
    const feed = await e2e.request({ method: "GET", url: "/api/v1/agents/claims" });
    expect(feed.statusCode).toBe(200);
    const items = feed.json<{ items: { platform: { market: string }; contentTrust: string; userSupplied: { title: string } }[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ platform: { market: claim.market }, contentTrust: "untrusted", userSupplied: { title: claim.title } });
    const wellKnown = await e2e.request({ method: "GET", url: "/.well-known/pine.json" });
    expect(wellKnown.json()).toMatchObject({ chainId: 100, feeds: { claims: `${ORIGIN}/api/v1/agents/claims` }, userContentOrigin: USER_CONTENT_ORIGIN });
  });

  it("returns a verified YES-ladder funding plan: exact split value, exact approval consumed by the single-sided mint", async () => {
    const budget = 100n * XDAI;
    const ladder = { market: claim.market, budgetWei: budget.toString(), lowerPrice: "0.05", upperPrice: "0.5" };
    // SEC-LEGAL-03: a plan is offered only once the user acknowledged the maximum loss if YES resolves; an
    // acknowledgement below the computed figure is refused with the computed figures (and no plan).
    const plansBefore = e2e.plans.length;
    const refused = await creator.send("POST", "/api/v1/funding/plans/ladder", {
      body: { ...ladder, riskAcknowledgement: { budgetWei: ladder.budgetWei, maxLossIfYesShares: "0" } },
      headers: { "idempotency-key": "ladder-0" },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    const figures = refused.json<{ error: { code: string; issues: { path: string[]; message: string }[] } }>().error;
    expect(figures.code).toBe("CONFLICT");
    expect(e2e.plans.length).toBe(plansBefore);
    const maxLoss = figures.issues.find((issue) => issue.path.at(-1) === "maxLossIfYesShares")?.message ?? "";
    expect(maxLoss).toMatch(/^[1-9]\d*$/);
    const riskAcknowledgement = { budgetWei: ladder.budgetWei, maxLossIfYesShares: maxLoss };
    const response = await creator.send("POST", "/api/v1/funding/plans/ladder", {
      body: { ...ladder, riskAcknowledgement },
      headers: { "idempotency-key": "ladder-1" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ details: { riskAcknowledgement: { maxLossIfYesShares: maxLoss, computedMaxLossIfYesShares: maxLoss } } });
    const verified = e2e.plans.at(-1);
    expect(verified?.totalValue).toBe(budget);
    const plan = lastPlan();
    expect(plan.account).toBe(creator.wallet);
    expect(plan.steps.map((step) => step.allowlistId)).toEqual(["gnosisRouter.splitFromBase", "outcomeToken.approve", "positionManager.createAndInitializePoolIfNecessary", "positionManager.mint"]);
    const approve = decodeFunctionData({ abi: erc20Abi, data: plan.steps[1]?.data ?? "0x" }).args as readonly [Address, bigint];
    expect(plan.steps[1]?.to).toBe(claim.yesToken);
    expect(approve[0].toLowerCase()).toBe(e2e.manifest.amm.positionManager);
    const [mint] = decodeFunctionData({ abi: algebraPositionManagerAbi, data: plan.steps[3]?.data ?? "0x" }).args as unknown as [{ recipient: Address; amount0Desired: bigint; amount1Desired: bigint }];
    expect(mint.recipient.toLowerCase()).toBe(creator.wallet);
    expect(Math.min(Number(mint.amount0Desired), Number(mint.amount1Desired))).toBe(0);
    // Allowance bound (decision 6) at plan level: the only approval in the plan goes to the position manager and equals
    // exactly the mint's desired amounts, so the planned residual is 0 (a larger approval fails here). Algebra rounds
    // liquidity down, so on chain the mint may pull a few wei less: the at-most-10-wei residual toward the position
    // manager is asserted by the deploy-e2e fork test (contracts/test/e2e/E2EScenarioBase.sol
    // test_replayedFunding_ladderMintSwapAndPayoutsAfterYes, MAX_RESIDUAL_ALLOWANCE).
    expect(approve[1] - (mint.amount0Desired + mint.amount1Desired)).toBe(0n);
    const approveSelector = toFunctionSelector("approve(address,uint256)");
    expect(plan.steps.filter((step) => step.data.startsWith(approveSelector)).map((step) => step.id)).toEqual([plan.steps[1]?.id]);
    // Replaying the same Idempotency-Key returns the same plan.
    const replay = await creator.send("POST", "/api/v1/funding/plans/ladder", {
      body: { ...ladder, riskAcknowledgement },
      headers: { "idempotency-key": "ladder-1" },
    });
    expect(replay.statusCode).toBe(200);
    expect(lastPlan().planId).toBe(plan.planId);
    const ladders = await e2e.db.api.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM funding_plans WHERE user_id = $1::uuid", [creator.userId]);
    expect(ladders[0]?.n).toBe(1);
  });

  it("stores an evidence manifest and artifact, returns a verified commit plan, and the client builds the reveal locally", async () => {
    await researcher.signIn();
    sessionTokens.push(researcher.session ?? "");
    const artifact = new TextEncoder().encode("1) start the bot with config/example.json\n2) reporter deposit draws 5 xDAI from the arbitration allocation\n");
    const upload = await researcher.send("POST", "/api/v1/evidence/artifacts", { raw: multipart({}, { bytes: artifact, mediaType: "text/plain", name: "steps.txt" }) });
    expect(upload.statusCode, upload.body).toBe(201);
    artifactSha = upload.json<{ sha256: Hex32 }>().sha256;
    const manifest: EvidenceManifest = {
      schema: "urn:pine:evidence-manifest:v1",
      submitter: researcher.wallet,
      claim: { chainId: 100, market: claim.market, claimDocumentSha256: claim.claimDocumentSha256, commit: claim.commit },
      title: "Arbitration allocation funds a reporter deposit",
      violatedRequirement: "Each reporter-funding deposit's principal is allocated only from eligible bridging/reporter funds in scope.",
      summary: "A crash between journal steps makes the reporter reuse the arbitration allocation.",
      expectedBehavior: "Deposit principal comes from reporter funds.",
      actualBehavior: "Deposit principal comes from the arbitration allocation.",
      reproduction: { environment: "Node 24, simulated chains", setup: "yarn install --immutable", command: "yarn test reporter", initialState: "", notes: "" },
      artifacts: [{ name: "steps.txt", sha256: artifactSha, size: artifact.byteLength, mediaType: "text/plain", locators: [], description: "Steps" }],
    };
    const stored = await researcher.send("POST", "/api/v1/evidence/manifests", { body: manifest });
    expect(stored.statusCode, stored.body).toBe(201);
    manifestSha = stored.json<{ sha256: Hex32 }>().sha256;
    expect(manifestSha).toBe(encodeEvidenceManifest(manifest).sha256);

    const commitment = computeEvidenceCommitment({ chainId: 100, registry: e2e.manifest.pine.evidenceRegistry, market: claim.market, submitter: researcher.wallet, contentSha256: manifestSha, salt });
    const commit = await researcher.send("POST", "/api/v1/evidence/plans/commit", { body: { market: claim.market, commitment }, headers: { "idempotency-key": "commit-1" } });
    expect(commit.statusCode, commit.body).toBe(201);
    const plan = lastPlan();
    expect(plan.steps.map((step) => step.allowlistId)).toEqual(["evidenceRegistry.commitEvidence"]);
    const commitArgs = decodeFunctionData({ abi: evidenceRegistryAbi, data: plan.steps[0]?.data ?? "0x" }).args as readonly [Address, Hex32];
    expect([commitArgs[0].toLowerCase(), commitArgs[1]]).toEqual([claim.market, commitment]);
    // Pine never receives the salt: a body carrying one is refused.
    const withSalt = await researcher.send("POST", "/api/v1/evidence/plans/commit", { body: { market: claim.market, commitment, salt }, headers: { "idempotency-key": "commit-2" } });
    expect(withSalt.statusCode).toBe(400);

    e2e.clock.advance(3_600_000);
    await e2e.chain.mine([{ kind: "EvidenceCommitted", address: e2e.manifest.pine.evidenceRegistry, submissionId: 1n, market: claim.market, submitter: researcher.wallet, commitment, committedAt: e2e.clock.unix() }]);
    const committed = await e2e.request({ method: "GET", url: `/api/v1/markets/${claim.market}/evidence` });
    expect(committed.json<{ items: { status: string }[] }>().items.map((item) => item.status)).toEqual(["committed"]);

    const template = await researcher.send("POST", "/api/v1/evidence/reveal-template", { body: { submissionId: "1", contentSha256: manifestSha } });
    expect(template.statusCode, template.body).toBe(200);
    const t = template.json<{ template: { commitment: Hex32; registry: Address; market: Address; account: Address }; warnings: unknown[] }>();
    expect(t.warnings).toEqual([]);
    expect(computeEvidenceCommitment({ chainId: 100, registry: t.template.registry, market: t.template.market, submitter: t.template.account, contentSha256: manifestSha, salt })).toBe(t.template.commitment);
    // The reveal plan is built and verified client-side with the client's own @pine/shared.
    const reveal = newPlan(e2e.manifest, "client-reveal-1", researcher.wallet, [buildStep(e2e.manifest, { id: "reveal", allowlistId: "evidenceRegistry.revealEvidence", args: [1n, manifestSha, salt] })]);
    expect(verifyPlan(reveal, e2e.manifest, e2e.planContext, CLIENT_PLAN_LIMITS)).toBe(0n);
    expect(JSON.stringify(e2e.responses.map((response) => response.body))).not.toContain(salt.slice(2));

    e2e.clock.advance(3_600_000);
    await e2e.chain.mine([
      { kind: "EvidenceRevealed", address: e2e.manifest.pine.evidenceRegistry, submissionId: 1n, market: claim.market, submitter: researcher.wallet, contentSha256: manifestSha, committedAt: e2e.clock.unix() - 3_600, revealedAt: e2e.clock.unix() },
    ]);
    const revealed = await e2e.request({ method: "GET", url: `/api/v1/markets/${claim.market}/evidence` });
    const item = revealed.json<{ items: Record<string, unknown>[] }>().items[0];
    expect(item).toMatchObject({
      status: "revealed",
      contentSha256: manifestSha,
      availability: { stored: true },
      timeliness: { timely: true },
      attribution: { submitterMatches: true, claimMatches: true },
      contentTrust: "untrusted",
    });

    // The user-content origin serves the bytes as an inert attachment.
    const base = await e2e.startContentServer();
    const download = await fetch(`${base}/c/${manifestSha}`, { headers: { cookie: `__Host-pine_session=${researcher.session ?? ""}` } });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-security-policy")).toContain("sandbox");
    expect(download.headers.get("set-cookie")).toBeNull();
    const storedManifest = await e2e.gateways.contentStore.get(manifestSha);
    expect(Buffer.from(await download.arrayBuffer()).equals(Buffer.from(storedManifest?.bytes ?? new Uint8Array()))).toBe(true);
  });

  it("reports oracle status and due actions, then a verified submit-answer plan after the reveal deadline", async () => {
    const before = await e2e.request({ method: "GET", url: `/api/v1/markets/${claim.market}/oracle` });
    expect(before.json()).toMatchObject({ phase: "evidence_open", status: { state: "not_open" } });
    e2e.clock.set(new Date((claim.revealDeadline + 60) * 1000));
    await e2e.chain.tick();
    // Days later: the old sessions expired (24 h idle); the researcher signs in again.
    expect((await researcher.send("GET", "/api/v1/auth/session")).statusCode).toBe(401);
    await researcher.signIn();
    sessionTokens.push(researcher.session ?? "");
    const open = await e2e.request({ method: "GET", url: `/api/v1/markets/${claim.market}/oracle` });
    expect(open.statusCode).toBe(200);
    const body = open.json<{ phase: string; status: { state: string }; dueActions: { action: string; details: Record<string, unknown> }[] }>();
    expect(body.phase).toBe("oracle_open");
    expect(body.status.state).toBe("open_unanswered");
    expect(body.dueActions.map((action) => action.action)).toEqual(["answer", "fund_bounty"]);
    const bond = 10n * XDAI;
    const answer = await researcher.send("POST", "/api/v1/oracle/plans/submit-answer", { body: { market: claim.market, outcome: "yes", bond: bond.toString() }, headers: { "idempotency-key": "answer-1" } });
    expect(answer.statusCode, answer.body).toBe(201);
    expect(e2e.plans.at(-1)?.totalValue).toBe(bond);
    expect(lastPlan().steps.map((step) => step.allowlistId)).toEqual(["realitio.submitAnswer"]);

    const yes = `0x${"0".repeat(64)}` as Hex32;
    const history = historyHashAfter(`0x${"0".repeat(64)}`, yes, bond, researcher.wallet, false);
    await e2e.chain.mine([{ kind: "RealityNewAnswer", address: e2e.manifest.seer.realitio, questionId: claim.questionId, answer: yes, historyHash: history, user: researcher.wallet, bond, ts: e2e.clock.unix(), isCommitment: false }]);
    e2e.rpc.historyHashes.set(claim.questionId, history);
    // The public status is cached per market and account for ORACLE_CACHE_SECONDS (PRD-04 4a): the answer shows after it.
    const cached = await e2e.request({ method: "GET", url: `/api/v1/markets/${claim.market}/oracle` });
    expect(cached.json<{ status: { state: string } }>().status.state).toBe("open_unanswered");
    e2e.clock.advance(ORACLE_CACHE_SECONDS * 1000);
    await e2e.chain.tick();
    const answered = await e2e.request({ method: "GET", url: `/api/v1/markets/${claim.market}/oracle` });
    const answeredBody = answered.json<{ status: { state: string; outcome: string }; dueActions: { action: string }[] }>();
    expect(answeredBody.status).toMatchObject({ state: "answered", outcome: "yes" });
    expect(answeredBody.dueActions.map((action) => action.action)).toContain("request_arbitration_on_ethereum");
  });

  it("finalizes, returns a verified resolve plan, and shows the simulated resolution", async () => {
    e2e.clock.advance((e2e.config.seer.questionTimeoutSeconds + 60) * 1000);
    await e2e.chain.tick();
    await researcher.signIn();
    sessionTokens.push(researcher.session ?? "");
    const finalized = await e2e.request({ method: "GET", url: `/api/v1/markets/${claim.market}/oracle` });
    const body = finalized.json<{ phase: string; status: { state: string; outcome: string }; dueActions: { action: string }[] }>();
    expect(body.phase).toBe("finalized");
    expect(body.status).toMatchObject({ state: "finalized", outcome: "yes" });
    expect(body.dueActions.map((action) => action.action)).toEqual(["resolve_market", "claim_winnings"]);
    const resolve = await researcher.send("POST", "/api/v1/oracle/plans/resolve", { body: { market: claim.market }, headers: { "idempotency-key": "resolve-1" } });
    expect(resolve.statusCode, resolve.body).toBe(201);
    expect(lastPlan().steps.map((step) => step.allowlistId)).toEqual(["realityProxy.resolve"]);
    const winnings = await researcher.send("POST", "/api/v1/oracle/plans/claim-winnings", { body: { market: claim.market }, headers: { "idempotency-key": "winnings-1" } });
    expect(winnings.statusCode, winnings.body).toBe(201);
    expect(lastPlan().steps.map((step) => step.allowlistId)).toEqual(["realitio.claimWinnings"]);

    await e2e.chain.mine([
      { kind: "ConditionResolution", address: e2e.manifest.seer.conditionalTokens, conditionId: claim.conditionId, oracle: e2e.manifest.seer.realityProxy, ctfQuestionId: keccak256(toBytes(`ctf:${claim.questionId}`)), outcomeSlotCount: 3, payoutNumerators: [1n, 0n, 0n] },
    ]);
    e2e.clock.advance(ORACLE_CACHE_SECONDS * 1000);
    await e2e.chain.tick();
    const resolved = await e2e.request({ method: "GET", url: `/api/v1/markets/${claim.market}/oracle` });
    expect(resolved.json()).toMatchObject({ phase: "resolved", resolution: { payoutNumerators: ["1", "0", "0"] } });
  });

  it("returns a verified redeem plan for the winning outcome tokens", async () => {
    const held = 7n * XDAI;
    e2e.rpc.setBalance(claim.yesToken, researcher.wallet, held);
    const response = await researcher.send("POST", "/api/v1/funding/plans/redeem", { body: { market: claim.market }, headers: { "idempotency-key": "redeem-1" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ kind: "redeem", details: { payoutNumerators: ["1", "0", "0"], outcomes: [{ outcome: "yes", amount: held.toString() }] } });
    const plan = lastPlan();
    expect(plan.account).toBe(researcher.wallet);
    expect(plan.steps.map((step) => step.allowlistId)).toEqual(["outcomeToken.approve", "gnosisRouter.redeemToBase"]);
    const approveArgs = decodeFunctionData({ abi: erc20Abi, data: plan.steps[0]?.data ?? "0x" }).args as readonly [Address, bigint];
    expect([approveArgs[0].toLowerCase(), approveArgs[1]]).toEqual([e2e.manifest.seer.gnosisRouter, held]);
    expect(plan.steps[0]?.to).toBe(claim.yesToken);
    expect(e2e.plans.at(-1)?.totalValue).toBe(0n);
  });

  it("verified every plan of every response, and leaked no secret into any response, log line or stored error", async () => {
    // Plans seen: publication (x2 identical), ladder (x2 identical), commit, answer, resolve, claim-winnings, redeem.
    expect(e2e.plans.length).toBeGreaterThanOrEqual(9);
    const scan = assertNoSecretLeaks(e2e, sessionTokens);
    expect(await assertNoSecretsPersisted(e2e, sessionTokens)).toBeGreaterThan(10);
    expect(scan.responses).toBeGreaterThan(30);
    expect(scan.logLines).toBeGreaterThan(30);
  });
});
