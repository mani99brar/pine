import { releaseSuiteLock } from "./test/lock.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
import { buildStep, planFromWire, type TxPlan, type WireTxPlan } from "@pine/shared/tx-plan";
import type { Address } from "@pine/shared/types";
import type { RouteModule } from "../../contracts/app.js";
import { testSessionHeaders } from "../../contracts/testing.js";
import { manifestOf, planContextFor } from "./common.js";
import { fundingModule } from "./index.js";
import { RECONCILE_BATCH, reconcileOnce, RECONCILE_JOB_NAME, REVERTED_REASON } from "./reconcile.js";
import { bodyHashOf, createPlan, insertPlan, PARTIAL_EXECUTION_RECOVERY } from "./store.js";
import { buildLaneTestApp } from "./test/app.js";
import { ALICE, BOB, createHarness, freshKey, MARKET_A, postPlan, refreshIndexer, seedClaim, WAD, type Harness } from "./test/harness.js";

afterAll(releaseSuiteLock);

const START = new Date("2026-10-01T00:00:00.000Z");
let h: Harness;
let hashCounter = 0;

const nextHash = (): Hex => keccak256(toHex(`tx-${(hashCounter += 1)}`));

function fundWallet(): void {
  for (const token of [MARKET_A.yesToken, MARKET_A.noToken, MARKET_A.invalidToken]) h.chain.setBalance(token, ALICE.wallet, 100n * WAD);
}

async function mergePlan(options: { key?: string } = {}): Promise<{ planId: string; plan: TxPlan }> {
  fundWallet();
  const response = await postPlan(h, "/api/v1/funding/plans/merge", { market: MARKET_A.market, amount: WAD.toString() }, { key: options.key ?? freshKey() });
  expect(response.statusCode).toBe(200);
  return { planId: response.json().planId, plan: planFromWire(response.json().plan) };
}

async function ladderPlan(): Promise<{ planId: string; plan: TxPlan }> {
  h.chain.setBalance(MARKET_A.yesToken, ALICE.wallet, 0n); // no YES held: the plan starts with splitFromBase
  const response = await postPlan(h, "/api/v1/funding/plans/ladder", {
    market: MARKET_A.market,
    budgetWei: (10n * WAD).toString(),
    lowerPrice: "0.2",
    upperPrice: "0.9",
    riskAcknowledgement: { budgetWei: (10n * WAD).toString(), maxLossIfYesShares: (10n * WAD).toString() },
  });
  expect(response.statusCode).toBe(200);
  return { planId: response.json().planId, plan: planFromWire(response.json().plan) };
}

const submit = (planId: string, stepId: string, txHash: string, session = ALICE) =>
  h.app.inject({ method: "POST", url: `/api/v1/funding/plans/${planId}/submitted`, headers: { ...testSessionHeaders(session), "content-type": "application/json" }, payload: JSON.stringify({ stepId, txHash }) });

const detail = async (planId: string, session = ALICE) => h.app.inject({ method: "GET", url: `/api/v1/funding/plans/${planId}`, headers: testSessionHeaders(session) });

/** Scripts a mined transaction for a step and reports it. */
async function execute(planId: string, plan: TxPlan, stepId: string, options: { status?: "0x0" | "0x1"; blockNumber?: bigint; tamper?: "to" | "from" | "input" | "value" } = {}): Promise<Hex> {
  const step = plan.steps.find((item) => item.id === stepId);
  if (!step) throw new Error(`no step ${stepId}`);
  const hash = nextHash();
  h.chain.transactions.set(hash, {
    receipt: { status: options.status ?? "0x1", blockNumber: options.blockNumber ?? h.chain.finalized },
    tx: {
      to: options.tamper === "to" ? ("0x00000000000000000000000000000000000ba5e0" as Address) : step.to,
      from: options.tamper === "from" ? BOB.wallet : plan.account,
      input: options.tamper === "input" ? (`${step.data}00` as Hex) : step.data,
      value: options.tamper === "value" ? step.value + 1n : step.value,
    },
  });
  expect((await submit(planId, stepId, hash)).statusCode).toBe(200);
  return hash;
}

async function stateOf(planId: string): Promise<{ state: string; steps: { id: string; state: string; txHashes: string[]; confirmedTxHash: string | null; revertReason: string | null }[]; recovery: string | null }> {
  return (await detail(planId)).json();
}

beforeAll(async () => {
  h = await createHarness();
  seedClaim(h.ctx, { ...MARKET_A });
});

afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  h.ctx.clock.set(START);
  refreshIndexer(h);
});

describe("plan store routes (PRD-04 section 1)", () => {
  it("/submitted records the hint once (idempotent) and moves planned -> submitted", async () => {
    const { planId } = await mergePlan();
    expect((await stateOf(planId)).state).toBe("planned");
    const hash = nextHash();
    expect((await submit(planId, "approve-yes", hash)).json().state).toBe("submitted");
    const again = await submit(planId, "approve-yes", hash.toUpperCase().replace("0X", "0x"));
    expect(again.statusCode).toBe(200);
    expect(again.json().steps.find((step: { id: string }) => step.id === "approve-yes").txHashes).toEqual([hash]);
  });

  it("/submitted is owner-only: another user's plan, an unknown plan or an unknown step are NOT_FOUND", async () => {
    const { planId } = await mergePlan();
    expect((await submit(planId, "approve-yes", nextHash(), BOB)).statusCode).toBe(404);
    expect((await submit("00000000-0000-4000-8000-00000000dead", "approve-yes", nextHash())).statusCode).toBe(404);
    expect((await submit(planId, "no-such-step", nextHash())).statusCode).toBe(404);
    expect((await submit(planId, "approve-yes", "0x1234")).statusCode).toBe(400);
    expect((await detail(planId, BOB)).statusCode).toBe(404);
    expect((await stateOf(planId)).state).toBe("planned");
  });

  it("accepts at most 8 hashes per step (speed-ups and replacements)", async () => {
    const { planId } = await mergePlan();
    for (let index = 0; index < 8; index += 1) expect((await submit(planId, "merge", nextHash())).statusCode).toBe(200);
    expect((await submit(planId, "merge", nextHash())).statusCode).toBe(409);
  });

  it("history lists only the user's plans, newest first, with a keyset cursor", async () => {
    const created: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      h.ctx.clock.advance(1_000);
      refreshIndexer(h);
      created.push((await mergePlan()).planId);
    }
    const page1 = (await h.app.inject({ method: "GET", url: "/api/v1/funding/history?limit=2", headers: testSessionHeaders(ALICE) })).json();
    expect(page1.items.map((item: { planId: string }) => item.planId)).toEqual([created[2], created[1]]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = (await h.app.inject({ method: "GET", url: `/api/v1/funding/history?limit=2&cursor=${page1.nextCursor}`, headers: testSessionHeaders(ALICE) })).json();
    expect(page2.items[0].planId).toBe(created[0]);
    const bob = (await h.app.inject({ method: "GET", url: "/api/v1/funding/history", headers: testSessionHeaders(BOB) })).json();
    expect(bob.items).toEqual([]);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/funding/history?cursor=bad!", headers: testSessionHeaders(ALICE) })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/funding/history" })).statusCode).toBe(401);
  });
});

describe("funding.reconcile (PRD-04 section 1)", () => {
  it("is registered as a 30 s job", () => {
    expect(fundingModule.jobs?.map((job) => [job.name, job.intervalMs])).toEqual([[RECONCILE_JOB_NAME, 30_000]]);
  });

  it("confirms each step from a finalized successful receipt whose transaction matches, then the plan", async () => {
    const { planId, plan } = await mergePlan();
    for (const step of plan.steps) await execute(planId, plan, step.id);
    await reconcileOnce(h.ctx);
    const state = await stateOf(planId);
    expect(state.state).toBe("confirmed");
    expect(state.steps.every((step) => step.state === "confirmed" && step.confirmedTxHash !== null)).toBe(true);
    await reconcileOnce(h.ctx); // idempotent
    expect((await stateOf(planId)).state).toBe("confirmed");
  });

  it("waits for finality: a receipt above the finalized block does not confirm", async () => {
    const { planId, plan } = await mergePlan();
    for (const step of plan.steps) await execute(planId, plan, step.id, { blockNumber: h.chain.finalized + 1n });
    await reconcileOnce(h.ctx);
    expect((await stateOf(planId)).state).toBe("submitted");
    h.chain.finalized += 5n;
    await reconcileOnce(h.ctx);
    expect((await stateOf(planId)).state).toBe("confirmed");
  });

  for (const tamper of ["to", "from", "input", "value"] as const) {
    it(`SEC-TX-08 never confirms from a transaction whose ${tamper} differs from the step`, async () => {
      const { planId, plan } = await mergePlan();
      await execute(planId, plan, "approve-yes", { tamper });
      await reconcileOnce(h.ctx);
      const state = await stateOf(planId);
      expect(state.steps.find((step) => step.id === "approve-yes")?.state).toBe("pending");
    });
  }

  it("records a reverted attempt without confirming; a later replacement confirms", async () => {
    const { planId, plan } = await mergePlan();
    await execute(planId, plan, "approve-yes", { status: "0x0" });
    await reconcileOnce(h.ctx);
    let step = (await stateOf(planId)).steps.find((item) => item.id === "approve-yes");
    expect(step).toMatchObject({ state: "pending", revertReason: REVERTED_REASON });
    const replacement = await execute(planId, plan, "approve-yes");
    await reconcileOnce(h.ctx);
    step = (await stateOf(planId)).steps.find((item) => item.id === "approve-yes");
    expect(step).toMatchObject({ state: "confirmed", confirmedTxHash: replacement, revertReason: null });
  });

  it("partial execution past expires_at + 1 h becomes failed and points to the merge plan", async () => {
    const { planId, plan } = await ladderPlan();
    await execute(planId, plan, "split");
    await reconcileOnce(h.ctx);
    expect((await stateOf(planId)).state).toBe("submitted");
    h.ctx.clock.advance((20 * 60 + 3_600) * 1000);
    refreshIndexer(h);
    await reconcileOnce(h.ctx);
    const state = await stateOf(planId);
    expect(state.state).toBe("failed");
    expect(state.recovery).toBe(PARTIAL_EXECUTION_RECOVERY);
  });

  it("expiry per kind: ladder after 20 min + 1 h, merge after 1 h + 1 h; never before", async () => {
    const ladder = await ladderPlan();
    const merge = await mergePlan();
    h.ctx.clock.advance((20 * 60 + 3_600) * 1000 - 1_000);
    refreshIndexer(h);
    await reconcileOnce(h.ctx);
    expect((await stateOf(ladder.planId)).state).toBe("planned");
    h.ctx.clock.advance(1_000);
    refreshIndexer(h);
    await reconcileOnce(h.ctx);
    expect((await stateOf(ladder.planId)).state).toBe("expired");
    expect((await stateOf(merge.planId)).state).toBe("planned");
    h.ctx.clock.advance((3_600 - 20 * 60) * 1000);
    refreshIndexer(h);
    await reconcileOnce(h.ctx);
    expect((await stateOf(merge.planId)).state).toBe("expired");
  });

  it("a same-key retry after expiry returns the stored plan with its state; terminal plans ignore hints", async () => {
    const key = freshKey();
    const { planId } = await mergePlan({ key });
    h.ctx.clock.advance(2 * 3_600 * 1000 + 1_000);
    refreshIndexer(h);
    await reconcileOnce(h.ctx);
    const retry = await postPlan(h, "/api/v1/funding/plans/merge", { market: MARKET_A.market, amount: WAD.toString() }, { key });
    expect(retry.json()).toMatchObject({ planId, state: "expired" });
    const hint = await submit(planId, "merge", nextHash());
    expect(hint.json().state).toBe("expired");
    expect(hint.json().steps.find((step: { id: string }) => step.id === "merge").txHashes).toEqual([]);
  });

  it("one plan's RPC failure does not stop the run", async () => {
    const broken = await mergePlan();
    const healthy = await mergePlan();
    const badHash = await execute(broken.planId, broken.plan, "approve-yes");
    for (const step of healthy.plan.steps) await execute(healthy.planId, healthy.plan, step.id);
    const original = h.chain.handle;
    h.ctx.chain.setHandler(async (method, params) => {
      if (method === "eth_getTransactionReceipt" && Array.isArray(params) && params[0] === badHash) throw new Error("upstream down");
      return original(method, params);
    });
    try {
      await reconcileOnce(h.ctx);
    } finally {
      h.ctx.chain.setHandler(original);
    }
    expect((await stateOf(healthy.planId)).state).toBe("confirmed");
    expect((await stateOf(broken.planId)).state).toBe("submitted");
  });

  it("bumps reconciled_at on every attempt, errors included, so failing plans cannot starve the batch (PRD-04 4a)", async () => {
    // Only this test's plans are open.
    await h.ctx.database.sql.query("UPDATE funding_plans SET state = 'expired' WHERE state IN ('planned', 'submitted')");
    const healthy = await mergePlan();
    for (const step of healthy.plan.steps) await execute(healthy.planId, healthy.plan, step.id);
    const wire = (await detail(healthy.planId)).json().plan as WireTxPlan;
    const badHash = nextHash();
    // A full batch of plans whose checks always throw, all sorting before the healthy plan (ids 00000000-...).
    for (let index = 0; index < RECONCILE_BATCH; index += 1) {
      const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      await insertPlan(h.ctx.db, {
        id,
        userId: ALICE.userId,
        route: "funding.merge",
        key: freshKey(),
        bodyHash: "1".repeat(64),
        kind: "merge",
        market: MARKET_A.market,
        account: ALICE.wallet,
        wire,
        details: {},
        now: h.ctx.clock.now(),
        expiresAt: new Date(h.ctx.clock.now().getTime() + 3_600_000),
      });
      await h.ctx.database.sql.query("UPDATE funding_plan_steps SET tx_hashes = ARRAY[$1::text] WHERE plan_id = $2::uuid AND step_id = 'approve-yes'", [badHash, id]);
    }
    const original = h.chain.handle;
    h.ctx.chain.setHandler(async (method, params) => {
      // A JSON-RPC error code viem does not retry, so 50 failures stay fast.
      if (method === "eth_getTransactionReceipt" && Array.isArray(params) && params[0] === badHash) throw Object.assign(new Error("upstream down"), { code: -32602 });
      return original(method, params);
    });
    const unattempted = async (): Promise<number> =>
      Number((await h.ctx.database.sql.query<{ count: string }>("SELECT count(*)::text AS count FROM funding_plans WHERE id::text LIKE '00000000-0000-4000-8000-%' AND reconciled_at IS NULL"))[0]?.count);
    try {
      expect(await unattempted()).toBe(RECONCILE_BATCH);
      await reconcileOnce(h.ctx);
      // The first run was filled by the failing plans; each attempt was recorded although it threw.
      expect(await unattempted()).toBe(0);
      expect((await stateOf(healthy.planId)).state).toBe("submitted");
      h.ctx.clock.advance(30_000);
      await reconcileOnce(h.ctx);
      expect((await stateOf(healthy.planId)).state).toBe("confirmed");
    } finally {
      h.ctx.chain.setHandler(original);
    }
  });
});

describe("plan store: server-side verification and same-key races (PRD-04 section 1, SEC-TX-08)", () => {
  const planRows = async (): Promise<number> => Number((await h.ctx.database.sql.query<{ count: string }>("SELECT count(*)::text AS count FROM funding_plans"))[0]?.count ?? "0");
  const keyRows = async (key: string): Promise<string[]> =>
    (await h.ctx.database.sql.query<{ id: string }>("SELECT id::text AS id FROM funding_plans WHERE idempotency_key = $1", [key])).map((row) => row.id);

  it("SEC-TX-01 a built plan that fails verifyPlan is refused with 422 and nothing is stored", async () => {
    const claim = await h.ctx.readModel.getClaim(MARKET_A.market);
    if (!claim) throw new Error("claim not seeded");
    const unregistered: Address = "0x0000000000000000000000000000000000dead01";
    const probe: RouteModule = {
      name: "funding-verify-probe",
      async register(app, ctx) {
        const manifest = manifestOf(ctx.config);
        app.post("/probe/plan", { preHandler: app.requireSession }, async (request) =>
          createPlan({
            ctx,
            manifest,
            request,
            route: "funding.probe",
            kind: "merge",
            body: { probe: true },
            action: "redeem",
            // A split into a market that is not a registered claim market: verifyPlan must refuse it.
            build: async () => ({ market: claim.market, steps: [buildStep(manifest, { id: "split", allowlistId: "gnosisRouter.splitFromBase", args: [unregistered], value: WAD })], context: planContextFor(claim), details: {} }),
          }),
        );
      },
    };
    const { app } = await buildLaneTestApp([probe], h.ctx);
    try {
      const before = await planRows();
      const response = await app.inject({ method: "POST", url: "/probe/plan", headers: { ...testSessionHeaders(ALICE), "content-type": "application/json", "idempotency-key": freshKey() }, payload: "{}" });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().error.message).toMatch(/failed verification/);
      expect(await planRows()).toBe(before);
    } finally {
      await app.close();
    }
  });

  it("two first requests racing on one key store one plan and both return it", async () => {
    fundWallet();
    const key = freshKey();
    const body = { market: MARKET_A.market, amount: WAD.toString() };
    const [first, second] = await Promise.all([postPlan(h, "/api/v1/funding/plans/merge", body, { key }), postPlan(h, "/api/v1/funding/plans/merge", body, { key })]);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().planId).toBe(first.json().planId);
    expect(second.json().plan).toEqual(first.json().plan);
    expect(await keyRows(key)).toEqual([first.json().planId]);
    // Only the request whose insert won writes the audit entry (SEC-OPS-07).
    expect(h.ctx.audit.entries.filter((entry) => entry.subjectId === first.json().planId && entry.action === "funding.plan.created").length).toBe(1);
  });

  it("SEC-OPS-07 a request that loses the insert race returns the winner's plan and writes no audit entry", async () => {
    const claim = await h.ctx.readModel.getClaim(MARKET_A.market);
    if (!claim) throw new Error("claim not seeded");
    const { planId: templateId } = await mergePlan();
    const wire = (await detail(templateId)).json().plan as WireTxPlan;
    const key = freshKey();
    const winnerId = "00000000-0000-4000-8000-00000000beef";
    const probe: RouteModule = {
      name: "funding-race-probe",
      async register(app, ctx) {
        const manifest = manifestOf(ctx.config);
        app.post("/probe/race", { preHandler: app.requireSession }, async (request) =>
          createPlan({
            ctx,
            manifest,
            request,
            route: "funding.raceprobe",
            kind: "merge",
            body: { probe: true },
            action: "redeem",
            // A concurrent request with the same key and body inserts its plan while this one is being built.
            build: async (session) => {
              await insertPlan(ctx.db, {
                id: winnerId,
                userId: session.userId,
                route: "funding.raceprobe",
                key,
                bodyHash: bodyHashOf({ probe: true }),
                kind: "merge",
                market: claim.market,
                account: session.wallet,
                wire,
                details: {},
                now: ctx.clock.now(),
                expiresAt: new Date(ctx.clock.now().getTime() + 3_600_000),
              });
              return { market: claim.market, steps: [...planFromWire(wire).steps], context: planContextFor(claim), details: {} };
            },
          }),
        );
      },
    };
    const { app } = await buildLaneTestApp([probe], h.ctx);
    try {
      const before = h.ctx.audit.entries.length;
      const response = await app.inject({ method: "POST", url: "/probe/race", headers: { ...testSessionHeaders(ALICE), "content-type": "application/json", "idempotency-key": key }, payload: "{}" });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().planId).toBe(winnerId);
      expect(await keyRows(key)).toEqual([winnerId]);
      expect(h.ctx.audit.entries.length).toBe(before);
    } finally {
      await app.close();
    }
  });

  it("the atomic insert on a taken key keeps the winner's plan and steps (ON CONFLICT DO NOTHING)", async () => {
    const key = freshKey();
    const { planId, plan } = await mergePlan({ key });
    const stored = (await detail(planId)).json() as { plan: WireTxPlan; details: unknown };
    const loserId = "00000000-0000-4000-8000-00000000f00d";
    const { stored: result, created } = await insertPlan(h.ctx.db, {
      id: loserId,
      userId: ALICE.userId,
      route: "funding.merge",
      key,
      bodyHash: "0".repeat(64),
      kind: "merge",
      market: MARKET_A.market,
      account: ALICE.wallet,
      wire: stored.plan,
      details: { loser: true },
      now: h.ctx.clock.now(),
      expiresAt: h.ctx.clock.now(),
    });
    expect(created).toBe(false);
    expect(result.planId).toBe(planId);
    expect(result.bodyHash).not.toBe("0".repeat(64));
    expect(result.steps.map((step) => step.id)).toEqual(plan.steps.map((step) => step.id));
    expect(await keyRows(key)).toEqual([planId]);
    const loserSteps = await h.ctx.database.sql.query<{ count: string }>("SELECT count(*)::text AS count FROM funding_plan_steps WHERE plan_id = $1", [loserId]);
    expect(loserSteps[0]?.count).toBe("0");
  });
});

describe("audit entries and freshness-gated expiry (PRD-04 4b, SEC-OPS-07)", () => {
  const entriesFor = (planId: string) => h.ctx.audit.entries.filter((entry) => entry.subjectId === planId);
  /** Only the given plans stay open, so one run's transitions are attributable. */
  const closeOtherPlans = async (): Promise<void> => {
    await h.ctx.database.sql.query("UPDATE funding_plans SET state = 'expired' WHERE state IN ('planned', 'submitted')");
  };

  it("SEC-OPS-07 a NEW {stepId, txHash} hint writes exactly one audit entry; an identical repeat (also concurrent) writes none", async () => {
    const { planId } = await mergePlan();
    const base = entriesFor(planId).length; // the plan.created entry
    const hash = nextHash();
    expect((await submit(planId, "approve-yes", hash)).statusCode).toBe(200);
    expect(entriesFor(planId).slice(base)).toEqual([
      { actorUserId: ALICE.userId, action: "funding.plan.tx_reported", subjectType: "funding_plan", subjectId: planId, details: { stepId: "approve-yes", txHash: hash }, ip: "127.0.0.1" },
    ]);
    expect((await submit(planId, "approve-yes", hash.toUpperCase().replace("0X", "0x"))).statusCode).toBe(200);
    expect(entriesFor(planId).length).toBe(base + 1);
    const concurrent = nextHash();
    const results = await Promise.all([submit(planId, "approve-no", concurrent), submit(planId, "approve-no", concurrent), submit(planId, "approve-no", concurrent)]);
    for (const result of results) expect(result.statusCode).toBe(200);
    expect(entriesFor(planId).filter((entry) => entry.action === "funding.plan.tx_reported").length).toBe(2);
    // The same hash for ANOTHER step is a new {stepId, txHash}.
    expect((await submit(planId, "merge", hash)).statusCode).toBe(200);
    expect(entriesFor(planId).filter((entry) => entry.action === "funding.plan.tx_reported").length).toBe(3);
  });

  it("SEC-OPS-07 a hint for another user's plan or a terminal plan writes no audit entry", async () => {
    const { planId } = await mergePlan();
    const before = h.ctx.audit.entries.length;
    expect((await submit(planId, "approve-yes", nextHash(), BOB)).statusCode).toBe(404);
    expect(h.ctx.audit.entries.length).toBe(before);
    h.ctx.clock.advance(2 * 3_600 * 1000 + 1_000);
    refreshIndexer(h);
    await reconcileOnce(h.ctx);
    expect((await stateOf(planId)).state).toBe("expired");
    const afterExpiry = h.ctx.audit.entries.length;
    expect((await submit(planId, "approve-yes", nextHash())).json().state).toBe("expired");
    expect(h.ctx.audit.entries.length).toBe(afterExpiry);
  });

  it("SEC-OPS-07 confirmed: the winning CAS writes exactly one entry; later runs write none", async () => {
    await closeOtherPlans();
    const { planId, plan } = await mergePlan();
    for (const step of plan.steps) await execute(planId, plan, step.id);
    const before = entriesFor(planId).length;
    await reconcileOnce(h.ctx);
    expect(entriesFor(planId).slice(before)).toEqual([
      { actorUserId: null, action: "funding.plan.confirmed", subjectType: "funding_plan", subjectId: planId, details: { from: "submitted", kind: "merge", steps: 4 }, ip: null },
    ]);
    await reconcileOnce(h.ctx);
    expect(entriesFor(planId).length).toBe(before + 1);
  });

  it("SEC-OPS-07 failed (partial execution) carries the fixed revert reason; expired writes one entry", async () => {
    await closeOtherPlans();
    const partial = await mergePlan();
    await execute(partial.planId, partial.plan, "approve-yes");
    await execute(partial.planId, partial.plan, "approve-no", { status: "0x0" });
    const untouched = await mergePlan();
    await reconcileOnce(h.ctx);
    const before = { partial: entriesFor(partial.planId).length, untouched: entriesFor(untouched.planId).length };
    h.ctx.clock.advance(2 * 3_600 * 1000 + 1_000);
    refreshIndexer(h);
    await reconcileOnce(h.ctx);
    expect(entriesFor(partial.planId).slice(before.partial)).toEqual([
      {
        actorUserId: null,
        action: "funding.plan.failed",
        subjectType: "funding_plan",
        subjectId: partial.planId,
        details: { from: "submitted", kind: "merge", confirmedSteps: 1, steps: 4, revertReasons: [{ stepId: "approve-no", reason: REVERTED_REASON }] },
        ip: null,
      },
    ]);
    expect(entriesFor(untouched.planId).slice(before.untouched)).toEqual([
      { actorUserId: null, action: "funding.plan.expired", subjectType: "funding_plan", subjectId: untouched.planId, details: { from: "planned", kind: "merge", confirmedSteps: 0, steps: 4, revertReasons: [] }, ip: null },
    ]);
    await reconcileOnce(h.ctx);
    expect(entriesFor(partial.planId).length).toBe(before.partial + 1);
    expect(entriesFor(untouched.planId).length).toBe(before.untouched + 1);
  });

  it("SEC-OPS-07 a lost CAS race writes no audit entry (another reconciler moved the plan first)", async () => {
    await closeOtherPlans();
    const { planId, plan } = await mergePlan();
    const hashes: string[] = [];
    for (const step of plan.steps) hashes.push(await execute(planId, plan, step.id));
    const lastHash = hashes.at(-1);
    const original = h.chain.handle;
    h.ctx.chain.setHandler(async (method, params) => {
      // While this run checks the last step, a concurrent run wins the plan's compare-and-set.
      if (method === "eth_getTransactionByHash" && Array.isArray(params) && params[0] === lastHash) {
        await h.ctx.database.sql.query("UPDATE funding_plans SET state = 'confirmed' WHERE id = $1::uuid", [planId]);
      }
      return original(method, params);
    });
    const before = entriesFor(planId).length;
    try {
      await reconcileOnce(h.ctx);
    } finally {
      h.ctx.chain.setHandler(original);
    }
    expect((await stateOf(planId)).state).toBe("confirmed");
    expect(entriesFor(planId).length).toBe(before);
  });

  it("two concurrent runs write one audit entry per transition", async () => {
    await closeOtherPlans();
    const { planId, plan } = await mergePlan();
    for (const step of plan.steps) await execute(planId, plan, step.id);
    const before = entriesFor(planId).length;
    await Promise.all([reconcileOnce(h.ctx), reconcileOnce(h.ctx)]);
    expect((await stateOf(planId)).state).toBe("confirmed");
    expect(entriesFor(planId).slice(before).map((entry) => entry.action)).toEqual(["funding.plan.confirmed"]);
  });

  it("decides expired/failed only while the read model is fresh: a lagging or halted read model keeps the plan for a retry", async () => {
    await closeOtherPlans();
    const { planId } = await mergePlan();
    h.ctx.clock.advance(2 * 3_600 * 1000 + 1_000); // past expires_at + 1 h, read model now lagging
    const before = entriesFor(planId).length;
    await reconcileOnce(h.ctx);
    expect((await stateOf(planId)).state).toBe("planned");
    refreshIndexer(h);
    h.ctx.readModel.setHalted(true);
    try {
      await reconcileOnce(h.ctx);
      expect((await stateOf(planId)).state).toBe("planned");
    } finally {
      h.ctx.readModel.setHalted(false);
    }
    expect(entriesFor(planId).length).toBe(before);
    await reconcileOnce(h.ctx);
    expect((await stateOf(planId)).state).toBe("expired");
  });

  it("a lagging read model still confirms from finalized receipts (confirmation does not depend on freshness)", async () => {
    await closeOtherPlans();
    const { planId, plan } = await mergePlan();
    for (const step of plan.steps) await execute(planId, plan, step.id);
    h.ctx.clock.advance((h.ctx.config.maxIndexerLagSeconds + 60) * 1000);
    await reconcileOnce(h.ctx);
    expect((await stateOf(planId)).state).toBe("confirmed");
  });

  it("decides nothing when finalizedBlock() fails in this run: no confirmation, no expiry; the next run retries", async () => {
    await closeOtherPlans();
    const partial = await mergePlan();
    await execute(partial.planId, partial.plan, "approve-yes");
    const idle = await mergePlan();
    h.ctx.clock.advance(2 * 3_600 * 1000 + 1_000);
    refreshIndexer(h);
    const original = h.chain.handle;
    // A JSON-RPC error code viem does not retry.
    h.ctx.chain.setHandler(async (method, params) => {
      if (method === "eth_getBlockByNumber") throw Object.assign(new Error("upstream down"), { code: -32602 });
      return original(method, params);
    });
    const before = h.ctx.audit.entries.length;
    try {
      await reconcileOnce(h.ctx);
    } finally {
      h.ctx.chain.setHandler(original);
    }
    expect((await stateOf(partial.planId)).state).toBe("submitted");
    expect((await stateOf(partial.planId)).steps.find((step) => step.id === "approve-yes")?.state).toBe("pending");
    expect((await stateOf(idle.planId)).state).toBe("planned");
    expect(h.ctx.audit.entries.length).toBe(before);
    await reconcileOnce(h.ctx);
    expect((await stateOf(partial.planId)).state).toBe("failed");
    expect((await stateOf(idle.planId)).state).toBe("expired");
  });
});
