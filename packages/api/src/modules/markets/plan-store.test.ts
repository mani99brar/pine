// Must stay the first import: serializes the memory-heavy markets test files (see test/lock.ts).
import "./test/lock.js";
import { describe, expect, it } from "vitest";
import { concat, keccak256, toHex } from "viem";
import { REALITY_ANSWERED_TOO_SOON } from "@pine/shared/read-model";
import { SCENARIO_ADDRESSES } from "@pine/shared/testing/read-model-scenarios";
import type { Address, Hex32 } from "@pine/shared/types";
import { addClaim, answerHex, EVIDENCE_REGISTRY, exampleManifest, postJson, storeManifest, useHarness, ZERO32, type Harness } from "./test/helpers.js";

const harnessOf = useHarness();
const XDAI = 10n ** 18n;
const TIMEOUT = 302_400;
const ALICE = "0x0000000000000000000000000000000000a1a1a1" as Address;
const REALITY = SCENARIO_ADDRESSES.reality as Address;
const COMMITMENT = `0x${"c0".repeat(32)}` as Hex32;
const txHash = (n: number) => `0x${n.toString(16).padStart(64, "f")}` as Hex32;

const chains = new Map<string, Hex32>();
async function answer(h: Harness, questionId: Hex32, value: Hex32, bond: bigint) {
  const historyHash = keccak256(concat([chains.get(questionId) ?? ZERO32, value, toHex(bond, { size: 32 }), ALICE, "0x00"]));
  chains.set(questionId, historyHash);
  h.chain.historyHashes.set(questionId, historyHash);
  h.b.nextBlock();
  await h.apply({ ...h.b.envelope(REALITY), kind: "RealityNewAnswer", questionId, answer: value, historyHash, user: ALICE, bond, ts: h.b.now(), isCommitment: false });
}
async function moveTo(h: Harness, seconds: number) {
  h.b.nextBlock(Math.max(1, seconds - h.b.now()));
  h.at(seconds);
  await h.fresh();
}

const reconcile = async (h: Harness) => {
  const job = h.module.jobs!.find((item) => item.name === "markets.reconcile")!;
  await job.run(h.ctx, new AbortController().signal);
};
const planOf = async (h: Harness, id: string, headers = h.headers) => (await h.app.inject({ method: "GET", url: `/api/v1/markets/plans/${id}`, headers })).json();
const submitted = (h: Harness, id: string, stepId: string, hash: string, headers = h.headers) =>
  h.app.inject({ method: "POST", url: `/api/v1/markets/plans/${id}/submitted`, headers, payload: { stepId, txHash: hash } });

async function commitPlan(h: Harness, seed: string) {
  const claim = await addClaim(h, seed);
  const response = await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: COMMITMENT });
  return { claim, body: response.json() as { plan: { steps: { id: string; to: Address; data: `0x${string}`; value: string }[] }; planState: { id: string; expiresAt: number } } };
}

async function resolvePlan(h: Harness, seed: string) {
  chains.clear();
  const claim = await addClaim(h, seed);
  await moveTo(h, claim.revealDeadline + 1);
  await answer(h, claim.questionId, answerHex(1n), XDAI);
  await moveTo(h, h.b.now() + TIMEOUT);
  const body = (await postJson(h, "/api/v1/oracle/plans/resolve", { market: claim.market })).json();
  return { claim, body: body as { plan: { steps: { id: string; to: Address; data: `0x${string}`; value: string }[] }; planState: { id: string; expiresAt: number } } };
}

describe("POST /api/v1/markets/plans/:planId/submitted", () => {
  it("records hints idempotently, moves planned -> submitted, and is owner-only", async () => {
    const h = harnessOf();
    const { body } = await commitPlan(h, "s1");
    const id = body.planState.id;
    const stranger = await h.user();
    expect((await submitted(h, id, "commit", txHash(1), stranger.headers)).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: `/api/v1/markets/plans/${id}`, headers: stranger.headers })).statusCode).toBe(404);
    expect((await submitted(h, id, "nope", txHash(1))).statusCode).toBe(404);
    const first = await submitted(h, id, "commit", txHash(1));
    expect(first.json().planState).toMatchObject({ state: "submitted", steps: [{ id: "commit", transactions: [{ txHash: txHash(1), status: "unknown" }] }] });
    await submitted(h, id, "commit", txHash(1));
    await submitted(h, id, "commit", txHash(2));
    expect((await planOf(h, id)).planState.steps[0].transactions.map((tx: { txHash: string }) => tx.txHash)).toEqual([txHash(1), txHash(2)]);
    // Only a NEW {stepId, txHash} is audited; the identical repeated hint is an idempotent replay (PRD-04 4b).
    expect(h.ctx.audit.entries.filter((entry) => entry.action === "markets.plan.tx_reported").map((entry) => ({ actor: entry.actorUserId, subject: entry.subjectId, details: entry.details }))).toEqual([
      { actor: h.session.userId, subject: id, details: { stepId: "commit", txHash: txHash(1) } },
      { actor: h.session.userId, subject: id, details: { stepId: "commit", txHash: txHash(2) } },
    ]);
    await submitted(h, id, "commit", txHash(2));
    expect(h.ctx.audit.entries.filter((entry) => entry.action === "markets.plan.tx_reported")).toHaveLength(2);
  });
});

describe("transaction hint cap", () => {
  it("accepts at most 20 hashes per step; repeating a known hash stays accepted", async () => {
    const h = harnessOf();
    const { body } = await commitPlan(h, "cap");
    const id = body.planState.id;
    for (let n = 1; n <= 20; n += 1) expect((await submitted(h, id, "commit", txHash(n))).statusCode).toBe(200);
    const over = await submitted(h, id, "commit", txHash(21));
    expect(over.statusCode).toBe(422);
    expect((await submitted(h, id, "commit", txHash(20))).statusCode).toBe(200);
    expect(await h.ctx.database.sql.query("SELECT tx_hash FROM markets_plan_txs")).toHaveLength(20);
  });
});

describe("markets.reconcile", () => {
  it("confirms an evidence commit from the read-model fact (no transaction hash needed)", async () => {
    const h = harnessOf();
    const { claim, body } = await commitPlan(h, "r1");
    h.b.nextBlock();
    await h.apply({ ...h.b.envelope(EVIDENCE_REGISTRY), kind: "EvidenceCommitted", submissionId: 1n, market: claim.market, submitter: h.session.wallet, commitment: COMMITMENT, committedAt: h.b.now() });
    await reconcile(h);
    expect((await planOf(h, body.planState.id)).planState).toMatchObject({ state: "confirmed", steps: [{ state: "confirmed" }] });
  });

  it("ignores a commit by another submitter", async () => {
    const h = harnessOf();
    const { claim, body } = await commitPlan(h, "r2");
    h.b.nextBlock();
    await h.apply({ ...h.b.envelope(EVIDENCE_REGISTRY), kind: "EvidenceCommitted", submissionId: 1n, market: claim.market, submitter: ALICE, commitment: COMMITMENT, committedAt: h.b.now() });
    await reconcile(h);
    expect((await planOf(h, body.planState.id)).planState.state).toBe("planned");
  });

  it("confirms a publish from the read-model published fact of that submitter and digest", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "r2b");
    const sha = await storeManifest(h, exampleManifest(claim, h.session.wallet));
    const body = (await postJson(h, "/api/v1/evidence/plans/publish", { market: claim.market, contentSha256: sha })).json();
    h.b.nextBlock();
    // Another digest, and the same digest by another submitter: neither confirms the plan.
    await h.apply(
      { ...h.b.envelope(EVIDENCE_REGISTRY), kind: "EvidencePublished", submissionId: 1n, market: claim.market, submitter: h.session.wallet, contentSha256: `0x${"d1".repeat(32)}`, publishedAt: h.b.now() },
      { ...h.b.envelope(EVIDENCE_REGISTRY), kind: "EvidencePublished", submissionId: 2n, market: claim.market, submitter: ALICE, contentSha256: sha, publishedAt: h.b.now() },
    );
    await reconcile(h);
    expect((await planOf(h, body.planState.id)).planState.state).toBe("planned");
    h.b.nextBlock();
    await h.apply({ ...h.b.envelope(EVIDENCE_REGISTRY), kind: "EvidencePublished", submissionId: 3n, market: claim.market, submitter: h.session.wallet, contentSha256: sha, publishedAt: h.b.now() });
    await reconcile(h);
    expect((await planOf(h, body.planState.id)).planState).toMatchObject({ state: "confirmed", steps: [{ state: "confirmed" }] });
  });

  it("confirms submitAnswer from the indexed answer of that answerer with the same answer and bond", async () => {
    const h = harnessOf();
    chains.clear();
    const claim = await addClaim(h, "r2c");
    await moveTo(h, claim.revealDeadline + 1);
    const body = (await postJson(h, "/api/v1/oracle/plans/submit-answer", { market: claim.market, outcome: "no", bond: (2n * XDAI).toString() })).json();
    expect(body.planState.state).toBe("planned");
    const indexAnswer = async (answerer: Address, value: Hex32, bond: bigint) => {
      h.b.nextBlock();
      await h.apply({ ...h.b.envelope(REALITY), kind: "RealityNewAnswer", questionId: claim.questionId, answer: value, historyHash: keccak256(toHex(`${answerer}${value}${bond}`)), user: answerer, bond, ts: h.b.now(), isCommitment: false });
    };
    await indexAnswer(ALICE, answerHex(1n), 2n * XDAI);
    await indexAnswer(h.session.wallet, answerHex(0n), 4n * XDAI);
    await reconcile(h);
    expect((await planOf(h, body.planState.id)).planState.state).toBe("planned");
    await indexAnswer(h.session.wallet, answerHex(1n), 2n * XDAI);
    await reconcile(h);
    expect((await planOf(h, body.planState.id)).planState).toMatchObject({ state: "confirmed", steps: [{ state: "confirmed" }] });
  });

  it("confirms other kinds only from a finalized successful receipt whose transaction equals the step", async () => {
    const h = harnessOf();
    const { body } = await resolvePlan(h, "r3");
    const id = body.planState.id;
    const step = body.plan.steps[0]!;
    const base = { from: h.session.wallet, to: step.to, input: step.data, value: 0n, status: "success" as const };
    h.chain.txs.set(txHash(1), { ...base, input: `${step.data}00` as `0x${string}`, blockNumber: 10n });
    h.chain.txs.set(txHash(2), { ...base, status: "reverted", blockNumber: 10n });
    h.chain.txs.set(txHash(3), { ...base, from: ALICE, blockNumber: 10n });
    h.chain.txs.set(txHash(4), { ...base, blockNumber: h.chain.finalized + 1n });
    h.chain.txs.set(txHash(5), { ...base, value: 1n, blockNumber: 10n });
    h.chain.txs.set(txHash(6), { ...base, to: "0x00000000000000000000000000000000000000ff", blockNumber: 10n });
    // A revert above the finalized block is not recorded yet (a reorg may drop it); only a finalized one is.
    h.chain.txs.set(txHash(7), { ...base, status: "reverted", blockNumber: h.chain.finalized + 1n });
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await submitted(h, id, step.id, txHash(n));
    await reconcile(h);
    let view = (await planOf(h, id)).planState;
    expect(view.state).toBe("submitted");
    expect(view.steps[0].transactions.map((tx: { status: string; reason: string | null }) => [tx.status, tx.reason])).toEqual([
      ["mismatch", "transaction does not match the plan step"],
      ["reverted", "transaction reverted"],
      ["mismatch", "transaction does not match the plan step"],
      ["unknown", null],
      ["mismatch", "transaction does not match the plan step"],
      ["mismatch", "transaction does not match the plan step"],
      ["unknown", null],
    ]);
    expect(h.ctx.metrics.counters.get('markets_reconcile{"outcome":"unchanged"}')).toBe(1);
    h.chain.finalized += 1n;
    await reconcile(h);
    view = (await planOf(h, id)).planState;
    expect(view.state).toBe("confirmed");
    expect(view.steps[0].transactions[3].status).toBe("succeeded");
    expect(view.steps[0].state).toBe("confirmed");
    expect(h.ctx.metrics.counters.get('markets_reconcile{"outcome":"confirmed"}')).toBe(1);
    expect(h.ctx.audit.entries.filter((entry) => entry.action === "markets.plan.confirmed")).toHaveLength(1);
  });

  it("records a revert only from a finalized receipt (an unfinalized revert may still be reorged away)", async () => {
    const h = harnessOf();
    const { body } = await resolvePlan(h, "r3b");
    const id = body.planState.id;
    const step = body.plan.steps[0]!;
    h.chain.txs.set(txHash(8), { from: h.session.wallet, to: step.to, input: step.data, value: 0n, status: "reverted", blockNumber: h.chain.finalized + 2n });
    await submitted(h, id, step.id, txHash(8));
    await reconcile(h);
    const statusOf = async () => (await planOf(h, id)).planState.steps[0].transactions.map((tx: { status: string; reason: string | null }) => [tx.status, tx.reason]);
    expect(await statusOf()).toEqual([["unknown", null]]);
    h.chain.finalized += 1n;
    await reconcile(h);
    expect(await statusOf()).toEqual([["unknown", null]]);
    h.chain.finalized += 1n;
    await reconcile(h);
    expect(await statusOf()).toEqual([["reverted", "transaction reverted"]]);
    expect((await planOf(h, id)).planState.state).toBe("submitted");
  });

  it("expires per kind only after expires_at + 1 h: commit at evidenceDeadline - 60 s, oracle helpers at created + 1 h", async () => {
    const h = harnessOf();
    // A claim whose evidence deadline is 2 h away: the kind deadline (evidenceDeadline - 60 s) is below the 24 h cap.
    const claim = await addClaim(h, "r4", { evidenceDeadline: h.b.now() + 7_200 });
    const commit = (await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: COMMITMENT })).json() as { planState: { id: string; expiresAt: number } };
    expect(commit.planState.expiresAt).toBe(claim.evidenceDeadline - 60);
    h.at(commit.planState.expiresAt + 3_600);
    await h.fresh();
    await reconcile(h);
    expect((await planOf(h, commit.planState.id)).planState.state).toBe("planned");
    h.at(commit.planState.expiresAt + 3_601);
    await h.fresh();
    await reconcile(h);
    expect((await planOf(h, commit.planState.id)).planState.state).toBe("expired");

    const { body: oracle } = await resolvePlan(h, "r5");
    const oracleCreated = h.ctx.clock.unix();
    expect(oracle.planState.expiresAt).toBe(oracleCreated + 3_600);
    h.at(oracleCreated + 7_200);
    await h.fresh();
    await reconcile(h);
    expect((await planOf(h, oracle.planState.id)).planState.state).toBe("planned");
    h.at(oracleCreated + 7_201);
    await h.fresh();
    await reconcile(h);
    expect((await planOf(h, oracle.planState.id)).planState.state).toBe("expired");
  });

  it("partial execution becomes failed (claimWinnings on the replacement confirmed, the original claim never sent)", async () => {
    const h = harnessOf();
    chains.clear();
    const claim = await addClaim(h, "r6");
    await moveTo(h, claim.revealDeadline + 1);
    await answer(h, claim.questionId, REALITY_ANSWERED_TOO_SOON, XDAI);
    await moveTo(h, h.b.now() + TIMEOUT + 1);
    const replacement = `0x${"5e".repeat(32)}` as Hex32;
    h.b.nextBlock();
    await h.apply({ ...h.b.envelope(REALITY), kind: "RealityQuestionReopened", questionId: replacement, reopenedQuestionId: claim.questionId });
    h.chain.reopened.set(claim.questionId, replacement);
    await moveTo(h, h.b.now() + 10);
    await answer(h, replacement, answerHex(1n), XDAI);
    await moveTo(h, h.b.now() + TIMEOUT + 1);
    const response = await postJson(h, "/api/v1/oracle/plans/claim-winnings", { market: claim.market }, { key: "claim-both" });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.plan.steps.map((step: { id: string }) => step.id)).toEqual(["claim", "claim-original"]);
    const step = body.plan.steps[0];
    h.chain.txs.set(txHash(9), { from: h.session.wallet, to: step.to, input: step.data, value: 0n, status: "success", blockNumber: 5n });
    await submitted(h, body.planState.id, "claim", txHash(9));
    await reconcile(h);
    expect((await planOf(h, body.planState.id)).planState).toMatchObject({ state: "submitted", steps: [{ state: "confirmed" }, { state: "pending" }] });
    h.at(body.planState.expiresAt + 3_601);
    await h.fresh();
    await reconcile(h);
    expect((await planOf(h, body.planState.id)).planState.state).toBe("failed");
    // Same key and body after the outcome: the stored plan with its state.
    h.chain.historyHashes.set(replacement, ZERO32);
    const retry = await postJson(h, "/api/v1/oracle/plans/claim-winnings", { market: claim.market }, { key: "claim-both" });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ plan: body.plan, planState: { id: body.planState.id, state: "failed", offerExpired: true } });
  });

  it("never expires while the read model is stale, and concurrent runs move a plan once", async () => {
    const h = harnessOf();
    const { body } = await resolvePlan(h, "r7");
    h.at(body.planState.expiresAt + 3_601);
    await reconcile(h);
    expect((await planOf(h, body.planState.id)).planState.state).toBe("planned");
    await h.fresh();
    await Promise.all([reconcile(h), reconcile(h)]);
    expect((await planOf(h, body.planState.id)).planState.state).toBe("expired");
    expect(h.ctx.audit.entries.filter((entry) => entry.action === "markets.plan.expired")).toHaveLength(1);
  });
});
