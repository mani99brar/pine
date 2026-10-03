import { releaseSuiteLock } from "./test/lock.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
import { planFromWire, type TxPlan } from "@pine/shared/tx-plan";
import type { AuditEntry } from "../../contracts/app.js";
import { MemoryAuditLog, testSessionHeaders } from "../../contracts/testing.js";
import { flushAudit, settledAudit } from "./audit.js";
import { fundingModule } from "./index.js";
import { LIQUIDITY_MAX_IN_FLIGHT, LIQUIDITY_RETRY_AFTER_SECONDS } from "./liquidity.js";
import { RECONCILE_JOB_NAME, reconcileOnce } from "./reconcile.js";
import { rawInject } from "./test/app.js";
import { ALICE, createHarness, freshKey, MARKET_A, MARKET_B, postPlan, refreshIndexer, seedClaim, WAD, type Harness } from "./test/harness.js";

// PRD-07 section 3 (api-hardening) for the funding module: cooperative abort of funding.reconcile, the step
// compare-and-set re-read, the audit outbox (SEC-OPS-07, with the 3c single-flight and request-path fixes), the liquidity
// route's fan-out cap and its separation from the positions limiter, and the history view.

afterAll(releaseSuiteLock);

const START = new Date("2026-10-01T00:00:00.000Z");
let h: Harness;
let hashCounter = 0;
let testIndex = 0;

const nextHash = (): Hex => keccak256(toHex(`hardening-tx-${(hashCounter += 1)}`));

beforeAll(async () => {
  h = await createHarness();
  seedClaim(h.ctx, { ...MARKET_A });
  seedClaim(h.ctx, { ...MARKET_B });
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  h.ctx.chain.setHandler(h.chain.handle);
  // Each test starts later than the previous one (the 30 s liquidity cache never carries over) with no open plans.
  testIndex += 1;
  h.ctx.clock.set(new Date(START.getTime() + testIndex * 60_000));
  refreshIndexer(h);
  await h.ctx.database.sql.query("UPDATE funding_plans SET state = 'expired' WHERE state IN ('planned', 'submitted')");
  await flushAudit(h.ctx);
});

async function mergePlan(key = freshKey()): Promise<{ planId: string; plan: TxPlan }> {
  for (const token of [MARKET_A.yesToken, MARKET_A.noToken, MARKET_A.invalidToken]) h.chain.setBalance(token, ALICE.wallet, 100n * WAD);
  const response = await postPlan(h, "/api/v1/funding/plans/merge", { market: MARKET_A.market, amount: WAD.toString() }, { key });
  expect(response.statusCode, response.body).toBe(200);
  return { planId: response.json().planId, plan: planFromWire(response.json().plan) };
}

const submit = (planId: string, stepId: string, txHash: string) =>
  h.app.inject({ method: "POST", url: `/api/v1/funding/plans/${planId}/submitted`, headers: { ...testSessionHeaders(ALICE), "content-type": "application/json" }, payload: JSON.stringify({ stepId, txHash }) });

/** Scripts a finalized successful transaction that matches the step exactly and reports it. */
async function execute(planId: string, plan: TxPlan, stepId: string): Promise<Hex> {
  const step = plan.steps.find((item) => item.id === stepId);
  if (!step) throw new Error(`no step ${stepId}`);
  const hash = nextHash();
  h.chain.transactions.set(hash, { receipt: { status: "0x1", blockNumber: h.chain.finalized }, tx: { to: step.to, from: plan.account, input: step.data, value: step.value } });
  expect((await submit(planId, stepId, hash)).statusCode).toBe(200);
  return hash;
}

const planRow = async (planId: string) =>
  (await h.ctx.database.sql.query<{ state: string; reconciled_at: unknown }>("SELECT state, reconciled_at FROM funding_plans WHERE id = $1::uuid", [planId]))[0];
const outbox = async () => (await h.ctx.database.sql.query<{ entry: AuditEntry }>("SELECT entry FROM funding_audit_outbox ORDER BY created_at, id")).map((row) => row.entry);
const reconcileJob = () => fundingModule.jobs!.find((job) => job.name === RECONCILE_JOB_NAME)!;
const runJob = (signal = new AbortController().signal) => reconcileJob().run(h.ctx, signal);
const syntheticEntry = (n: number): AuditEntry => ({ actorUserId: null, action: "funding.plan.confirmed", subjectType: "funding_plan", subjectId: `single-flight-${n}`, details: { n }, ip: null });
const queueSynthetic = (n: number) =>
  h.ctx.database.sql.query("INSERT INTO funding_audit_outbox (id, entry, created_at) VALUES (gen_random_uuid(), $1::jsonb, now())", [JSON.stringify(syntheticEntry(n))]);
const recorded = (planId: string, action?: string) => h.ctx.audit.entries.filter((entry) => entry.subjectId === planId && (action === undefined || entry.action === action));

describe("cooperative abort of the registered funding.reconcile job (PRD-07 sections 3 and 3c)", () => {
  it("an abort before the run starts no plan: no confirmation, no reconciled_at, no receipt read", async () => {
    const first = await mergePlan();
    const second = await mergePlan();
    for (const { planId, plan } of [first, second]) for (const step of plan.steps) await execute(planId, plan, step.id);
    const receipts = vi.fn();
    h.ctx.chain.setHandler(async (method, params) => {
      if (method === "eth_getTransactionReceipt") receipts();
      return h.chain.handle(method, params);
    });
    const controller = new AbortController();
    controller.abort();
    await runJob(controller.signal);
    expect(await planRow(first.planId)).toEqual({ state: "submitted", reconciled_at: null });
    expect(await planRow(second.planId)).toEqual({ state: "submitted", reconciled_at: null });
    expect(receipts).not.toHaveBeenCalled();
    // Positive control: without the abort both are confirmed.
    await runJob();
    expect((await planRow(first.planId))?.state).toBe("confirmed");
    expect((await planRow(second.planId))?.state).toBe("confirmed");
  });

  it("an abort during the first plan finishes that plan and leaves the second untouched", async () => {
    const first = await mergePlan();
    const second = await mergePlan();
    for (const { planId, plan } of [first, second]) for (const step of plan.steps) await execute(planId, plan, step.id);
    const controller = new AbortController();
    // The first scripted chain response of the run (the first plan's first receipt) aborts it, as a shutdown would.
    h.ctx.chain.setHandler(async (method, params) => {
      if (method === "eth_getTransactionReceipt") controller.abort();
      return h.chain.handle(method, params);
    });
    await runJob(controller.signal);
    const rows = [await planRow(first.planId), await planRow(second.planId)];
    expect(rows.filter((row) => row?.state === "confirmed" && row.reconciled_at !== null)).toHaveLength(1);
    expect(rows.filter((row) => row?.state === "submitted" && row.reconciled_at === null)).toHaveLength(1);
  });
});

describe("funding.reconcile re-reads a step whose compare-and-set lost (PRD-07 section 3)", () => {
  it("a step confirmed by another run between read and CAS counts as confirmed: the partial execution is failed, not expired", async () => {
    const { planId, plan } = await mergePlan();
    const hash = await execute(planId, plan, "approve-yes");
    h.ctx.clock.advance(2 * 3_600 * 1000 + 1_000);
    refreshIndexer(h);
    // Injected pre-existing confirmation: another run confirms the step while this one checks the transaction.
    h.ctx.chain.setHandler(async (method, params) => {
      if (method === "eth_getTransactionByHash" && Array.isArray(params) && params[0] === hash) {
        await h.ctx.database.sql.query("UPDATE funding_plan_steps SET state = 'confirmed', confirmed_tx_hash = $1 WHERE plan_id = $2::uuid AND step_id = 'approve-yes'", [hash, planId]);
      }
      return h.chain.handle(method, params);
    });
    await reconcileOnce(h.ctx);
    expect((await planRow(planId))?.state).toBe("failed");
    expect(recorded(planId).filter((entry) => entry.action === "funding.plan.failed" || entry.action === "funding.plan.expired")).toEqual([
      { actorUserId: null, action: "funding.plan.failed", subjectType: "funding_plan", subjectId: planId, details: { from: "submitted", kind: "merge", confirmedSteps: 1, steps: 4, revertReasons: [] }, ip: null },
    ]);
  });
});

describe("SEC-OPS-07 audit outbox (PRD-07 section 3)", () => {
  it("SEC-OPS-07 an audit outage keeps the plan-created entry in the outbox; the next write records it exactly once", async () => {
    vi.spyOn(h.ctx.audit, "record").mockRejectedValueOnce(new Error("audit store down"));
    const { planId } = await mergePlan();
    expect(recorded(planId)).toEqual([]);
    expect(await outbox()).toMatchObject([{ action: "funding.plan.created", subjectId: planId }]);
    const hash = nextHash();
    expect((await submit(planId, "approve-yes", hash)).statusCode).toBe(200);
    expect(recorded(planId).map((entry) => entry.action).sort()).toEqual(["funding.plan.created", "funding.plan.tx_reported"]);
    expect(recorded(planId, "funding.plan.created")[0]).toEqual({
      actorUserId: ALICE.userId,
      action: "funding.plan.created",
      subjectType: "funding_plan",
      subjectId: planId,
      details: { route: "funding.merge", kind: "merge", market: MARKET_A.market, steps: 4 },
      ip: "127.0.0.1",
    });
    expect(await outbox()).toEqual([]);
    await reconcileOnce(h.ctx);
    expect(recorded(planId, "funding.plan.created")).toHaveLength(1);
  });

  it("SEC-OPS-07 a same-key replay flushes an entry left by an outage", async () => {
    vi.spyOn(h.ctx.audit, "record").mockRejectedValueOnce(new Error("audit store down"));
    const key = freshKey();
    const { planId } = await mergePlan(key);
    expect(await outbox()).toHaveLength(1);
    expect((await mergePlan(key)).planId).toBe(planId);
    expect(recorded(planId, "funding.plan.created")).toHaveLength(1);
    expect(await outbox()).toEqual([]);
  });

  it("SEC-OPS-07 a reconcile run with no open plans flushes an entry left by an outage", async () => {
    vi.spyOn(h.ctx.audit, "record").mockRejectedValueOnce(new Error("audit store down"));
    const { planId } = await mergePlan();
    await h.ctx.database.sql.query("UPDATE funding_plans SET state = 'expired' WHERE id = $1::uuid", [planId]);
    expect(await outbox()).toHaveLength(1);
    await reconcileOnce(h.ctx);
    expect(recorded(planId, "funding.plan.created")).toHaveLength(1);
    expect(await outbox()).toEqual([]);
  });

  it("SEC-OPS-07 several pending entries of one plan (created, tx_reported, confirmed) all survive an outage", async () => {
    const record = vi.spyOn(h.ctx.audit, "record").mockRejectedValue(new Error("audit store down"));
    const { planId, plan } = await mergePlan();
    const hashes: Hex[] = [];
    for (const step of plan.steps) hashes.push(await execute(planId, plan, step.id));
    await reconcileOnce(h.ctx);
    expect((await planRow(planId))?.state).toBe("confirmed");
    expect(recorded(planId)).toEqual([]);
    expect((await outbox()).filter((entry) => entry.subjectId === planId)).toHaveLength(6);
    record.mockRestore();
    await reconcileOnce(h.ctx);
    expect(recorded(planId).map((entry) => entry.action).sort()).toEqual([
      "funding.plan.confirmed",
      "funding.plan.created",
      "funding.plan.tx_reported",
      "funding.plan.tx_reported",
      "funding.plan.tx_reported",
      "funding.plan.tx_reported",
    ]);
    expect(recorded(planId, "funding.plan.tx_reported").map((entry) => entry.details.txHash).sort()).toEqual([...hashes].sort());
    expect(recorded(planId, "funding.plan.confirmed")[0]?.details).toEqual({ from: "submitted", kind: "merge", steps: 4 });
    expect(await outbox()).toEqual([]);
  });

  it("SEC-OPS-07 an abort between entries leaves the unrecorded rows in the outbox", async () => {
    const record = vi.spyOn(h.ctx.audit, "record").mockRejectedValue(new Error("audit store down"));
    const { planId } = await mergePlan();
    await submit(planId, "approve-yes", nextHash());
    await submit(planId, "approve-no", nextHash());
    expect(await outbox()).toHaveLength(3);
    const controller = new AbortController();
    const real = MemoryAuditLog.prototype.record;
    record.mockImplementation(async (entry) => {
      await real.call(h.ctx.audit, entry);
      controller.abort();
    });
    await flushAudit(h.ctx, controller.signal);
    expect(recorded(planId)).toHaveLength(1);
    expect(await outbox()).toHaveLength(2);
    record.mockRestore();
    await flushAudit(h.ctx);
    expect(recorded(planId)).toHaveLength(3);
  });

  it("SEC-OPS-07 single-flight: a flush called while one is recording drains again; both entries are recorded once when it resolves", async () => {
    await queueSynthetic(1);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = MemoryAuditLog.prototype.record;
    const record = vi.spyOn(h.ctx.audit, "record").mockImplementation(async (entry) => {
      await gate;
      await real.call(h.ctx.audit, entry);
    });
    const first = flushAudit(h.ctx);
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    // Queued after the first flush read the outbox: only a second drain can see it.
    await queueSynthetic(2);
    const second = flushAudit(h.ctx);
    release();
    await second;
    expect(h.ctx.audit.entries.filter((entry) => entry.subjectId.startsWith("single-flight-")).map((entry) => entry.subjectId)).toEqual(["single-flight-1", "single-flight-2"]);
    expect(await outbox()).toEqual([]);
    await first;
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("SEC-OPS-07 a drain that rejects clears the single-flight entry: the next flush still records the pending entry", async () => {
    await queueSynthetic(3);
    // The audit store fails and the failure path itself throws: the drain rejects once.
    vi.spyOn(h.ctx.audit, "record").mockRejectedValueOnce(new Error("audit store down"));
    vi.spyOn(h.ctx.metrics, "increment").mockImplementationOnce(() => {
      throw new Error("metrics sink down");
    });
    await expect(flushAudit(h.ctx)).rejects.toThrow("metrics sink down");
    expect(await outbox()).toHaveLength(1);
    await flushAudit(h.ctx);
    expect(recorded("single-flight-3")).toEqual([syntheticEntry(3)]);
    expect(await outbox()).toEqual([]);
  });

  it("SEC-OPS-07 an audit store that never resolves does not delay the plan response; the committed row is recorded later", async () => {
    for (const token of [MARKET_A.yesToken, MARKET_A.noToken, MARKET_A.invalidToken]) h.chain.setBalance(token, ALICE.wallet, 100n * WAD);
    let release: () => void = () => {};
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = MemoryAuditLog.prototype.record;
    vi.spyOn(h.ctx.audit, "record").mockImplementation(async (entry) => {
      await stuck;
      await real.call(h.ctx.audit, entry);
    });
    let timer: NodeJS.Timeout | undefined;
    let planId: string;
    try {
      // A raw inject: the harness would otherwise wait for the request's flush.
      const response = await Promise.race([
        rawInject(h.app, {
          method: "POST",
          url: "/api/v1/funding/plans/merge",
          headers: { ...testSessionHeaders(ALICE), "content-type": "application/json", "idempotency-key": freshKey() },
          payload: JSON.stringify({ market: MARKET_A.market, amount: WAD.toString() }),
        }),
        new Promise<"delayed">((resolve) => {
          timer = setTimeout(() => resolve("delayed"), 5_000);
        }),
      ]);
      if (response === "delayed") throw new Error("the plan response waited for the audit store");
      expect(response.statusCode, response.body).toBe(200);
      planId = response.json().planId;
      expect(recorded(planId)).toEqual([]);
      expect(await outbox()).toMatchObject([{ action: "funding.plan.created", subjectId: planId }]);
    } finally {
      clearTimeout(timer);
      release();
    }
    await settledAudit(h.ctx);
    expect(recorded(planId, "funding.plan.created")).toHaveLength(1);
    expect(await outbox()).toEqual([]);
  });

  it("SEC-OPS-07 a failing background flush never fails the response and is logged redacted", async () => {
    vi.spyOn(h.ctx.audit, "record").mockRejectedValueOnce(new Error("audit store down"));
    const increment = h.ctx.metrics.increment.bind(h.ctx.metrics);
    vi.spyOn(h.ctx.metrics, "increment").mockImplementation((name, labels) => {
      if (name === "funding_audit_outbox") throw new Error("metrics sink down token=test-secret-value");
      increment(name, labels);
    });
    const { planId } = await mergePlan();
    const logged = h.logs.lines.filter((line) => line.includes("funding audit flush failed"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("metrics sink down");
    expect(logged[0]).not.toContain("test-secret-value");
    expect(await outbox()).toMatchObject([{ action: "funding.plan.created", subjectId: planId }]);
  });
});

describe("SEC-OPS-07 outbox atomicity: an audited write commits only together with its outbox row (PRD-07 3d)", () => {
  /** Every outbox INSERT fails while `run` runs (a NOT VALID check skips existing rows and refuses every new one). */
  async function withFailingOutbox(run: () => Promise<void>): Promise<void> {
    await h.ctx.database.sql.exec("ALTER TABLE funding_audit_outbox ADD CONSTRAINT outbox_fail CHECK (false) NOT VALID");
    try {
      await run();
    } finally {
      await h.ctx.database.sql.exec("ALTER TABLE funding_audit_outbox DROP CONSTRAINT outbox_fail");
    }
  }
  const plansWithKey = async (key: string) => (await h.ctx.database.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM funding_plans WHERE idempotency_key = $1", [key]))[0]?.n;
  const stepCount = async () => (await h.ctx.database.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM funding_plan_steps"))[0]?.n;
  const txHashesOf = async (planId: string, stepId: string) =>
    (await h.ctx.database.sql.query<{ tx_hashes: string[] }>("SELECT tx_hashes FROM funding_plan_steps WHERE plan_id = $1::uuid AND step_id = $2", [planId, stepId]))[0]?.tx_hashes;

  it("SEC-OPS-07 a plan insert whose outbox INSERT fails is refused and commits no plan and no step", async () => {
    const key = freshKey();
    const steps = await stepCount();
    for (const token of [MARKET_A.yesToken, MARKET_A.noToken, MARKET_A.invalidToken]) h.chain.setBalance(token, ALICE.wallet, 100n * WAD);
    await withFailingOutbox(async () => {
      const response = await postPlan(h, "/api/v1/funding/plans/merge", { market: MARKET_A.market, amount: WAD.toString() }, { key });
      expect(response.statusCode, response.body).toBe(500);
    });
    expect(await plansWithKey(key)).toBe(0);
    expect(await stepCount()).toBe(steps);
    expect(await outbox()).toEqual([]);
    // Positive control: the same key then creates the plan and its entry is recorded.
    const { planId } = await mergePlan(key);
    expect(await plansWithKey(key)).toBe(1);
    expect(recorded(planId, "funding.plan.created")).toHaveLength(1);
  });

  it("SEC-OPS-07 a tx-hash hint whose outbox INSERT fails is refused: no hash appended, the plan stays planned", async () => {
    const { planId } = await mergePlan();
    const hash = nextHash();
    await withFailingOutbox(async () => {
      expect((await submit(planId, "approve-yes", hash)).statusCode).toBe(500);
    });
    expect(await txHashesOf(planId, "approve-yes")).toEqual([]);
    expect((await planRow(planId))?.state).toBe("planned");
    expect(recorded(planId, "funding.plan.tx_reported")).toEqual([]);
    // Positive control: the same hint afterwards is appended and audited once.
    expect((await submit(planId, "approve-yes", hash)).statusCode).toBe(200);
    expect(await txHashesOf(planId, "approve-yes")).toEqual([hash]);
    expect(recorded(planId, "funding.plan.tx_reported")).toHaveLength(1);
  });

  it("SEC-OPS-07 a confirmed transition whose outbox INSERT fails is not committed; the next run confirms and audits it", async () => {
    const { planId, plan } = await mergePlan();
    for (const step of plan.steps) await execute(planId, plan, step.id);
    await withFailingOutbox(() => reconcileOnce(h.ctx));
    expect((await planRow(planId))?.state).toBe("submitted");
    expect(recorded(planId, "funding.plan.confirmed")).toEqual([]);
    expect(await outbox()).toEqual([]);
    await reconcileOnce(h.ctx);
    expect((await planRow(planId))?.state).toBe("confirmed");
    expect(recorded(planId, "funding.plan.confirmed")).toHaveLength(1);
  });

  it("SEC-OPS-07 an expired transition whose outbox INSERT fails is not committed; the next run expires and audits it", async () => {
    const { planId } = await mergePlan();
    h.ctx.clock.advance(2 * 3_600 * 1000 + 1_000);
    refreshIndexer(h);
    await withFailingOutbox(() => reconcileOnce(h.ctx));
    expect((await planRow(planId))?.state).toBe("planned");
    expect(recorded(planId, "funding.plan.expired")).toEqual([]);
    await reconcileOnce(h.ctx);
    expect((await planRow(planId))?.state).toBe("expired");
    expect(recorded(planId, "funding.plan.expired")).toHaveLength(1);
  });
});

describe("GET /api/v1/funding/history shows the reconciled state (PRD-07 section 3)", () => {
  it("items carry the reconciled plan state, step states and confirmedTxHash", async () => {
    const full = await mergePlan();
    const fullHashes: Record<string, Hex> = {};
    for (const step of full.plan.steps) fullHashes[step.id] = await execute(full.planId, full.plan, step.id);
    const partial = await mergePlan();
    const partialHash = await execute(partial.planId, partial.plan, "approve-yes");
    await reconcileOnce(h.ctx);
    h.ctx.clock.advance(2 * 3_600 * 1000 + 1_000);
    refreshIndexer(h);
    await reconcileOnce(h.ctx);
    const history = await h.app.inject({ method: "GET", url: "/api/v1/funding/history?limit=50", headers: testSessionHeaders(ALICE) });
    expect(history.statusCode).toBe(200);
    const items = history.json().items as { planId: string; state: string; steps: { id: string; state: string; txHashes: string[]; confirmedTxHash: string | null }[] }[];
    const fullItem = items.find((item) => item.planId === full.planId);
    expect(fullItem?.state).toBe("confirmed");
    expect(fullItem?.steps.map((step) => [step.id, step.state, step.confirmedTxHash])).toEqual(full.plan.steps.map((step) => [step.id, "confirmed", fullHashes[step.id]]));
    const partialItem = items.find((item) => item.planId === partial.planId);
    expect(partialItem?.state).toBe("failed");
    expect(partialItem?.steps.map((step) => [step.id, step.state, step.confirmedTxHash])).toEqual(
      partial.plan.steps.map((step) => (step.id === "approve-yes" ? [step.id, "confirmed", partialHash] : [step.id, "pending", null])),
    );
    expect(partialItem?.steps.find((step) => step.id === "approve-yes")?.txHashes).toEqual([partialHash]);
  });
});

describe("GET /api/v1/markets/:market/liquidity fan-out cap (PRD-07 section 3)", () => {
  it("caps concurrent cache misses at 4: a 5th is 429 RATE_LIMITED at once, never queued, and caches nothing", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = 0;
    h.ctx.chain.setHandler(async (method, params) => {
      if (method === "eth_call") {
        waiting += 1;
        await gate;
        waiting -= 1;
      }
      return h.chain.handle(method, params);
    });
    const get = (market: string) => h.app.inject({ method: "GET", url: `/api/v1/markets/${market}/liquidity` });
    const inFlight = [1, 2, 3, 4].map(() => get(MARKET_A.market));
    await vi.waitFor(() => expect(waiting).toBe(4));
    const rpcBefore = h.chain.rpcCount;
    const refused = await get(MARKET_B.market);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("RATE_LIMITED");
    expect(refused.headers["retry-after"]).toBe(String(LIQUIDITY_RETRY_AFTER_SECONDS));
    // Refused before any chain read, and nothing is waiting for a slot.
    expect(h.chain.rpcCount).toBe(rpcBefore);
    expect(waiting).toBe(4);
    release();
    expect((await Promise.all(inFlight)).map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    // The refused market was not cached: the next request reads the chain and is served.
    const served = await get(MARKET_B.market);
    expect(served.statusCode).toBe(200);
    expect(h.chain.rpcCount).toBeGreaterThan(rpcBefore);
    expect(served.json().market).toBe(MARKET_B.market);
    expect(LIQUIDITY_MAX_IN_FLIGHT).toBe(4);
  });
});

describe("the liquidity and positions routes have separate fan-out limiters (PRD-07 3c)", () => {
  const liquidity = (market: string) => h.app.inject({ method: "GET", url: `/api/v1/markets/${market}/liquidity` });
  const positions = (n: number) => h.app.inject({ method: "GET", url: `/api/v1/funding/positions/0x${n.toString(16).padStart(40, "0")}?market=${MARKET_A.market}` });

  /** Parks the next `count` RPC calls (each request's first) until release(); later calls pass through. */
  function holdNextRpcCalls(count: number): { held(): number; release(): void } {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    h.ctx.chain.setHandler(async (method, params) => {
      if (held < count) {
        held += 1;
        await gate;
      }
      return h.chain.handle(method, params);
    });
    return { held: () => held, release };
  }

  it("four liquidity misses holding every liquidity slot leave the positions route its own slot", async () => {
    const parked = holdNextRpcCalls(LIQUIDITY_MAX_IN_FLIGHT);
    try {
      const inFlight = [1, 2, 3, 4].map(() => liquidity(MARKET_A.market));
      await vi.waitFor(() => expect(parked.held()).toBe(4));
      expect((await liquidity(MARKET_B.market)).statusCode).toBe(429);
      const served = await positions(0xf1);
      expect(served.statusCode, served.body).toBe(200);
      parked.release();
      expect((await Promise.all(inFlight)).map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    } finally {
      parked.release();
    }
  });

  it("four positions misses holding every positions slot leave the liquidity route its own slot", async () => {
    const parked = holdNextRpcCalls(4);
    try {
      const inFlight = [1, 2, 3, 4].map((n) => positions(0xf10 + n));
      await vi.waitFor(() => expect(parked.held()).toBe(4));
      expect((await positions(0xf20)).statusCode).toBe(429);
      const served = await liquidity(MARKET_B.market);
      expect(served.statusCode, served.body).toBe(200);
      expect(served.json().market).toBe(MARKET_B.market);
      parked.release();
      expect((await Promise.all(inFlight)).map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    } finally {
      parked.release();
    }
  });
});
