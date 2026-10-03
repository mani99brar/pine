import { releaseSuiteLock } from "./test/lock.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildStep, newPlan, verifyPlan, type TxPlan } from "@pine/shared/tx-plan";
import type { Address } from "@pine/shared/types";
import { testSessionHeaders } from "../../contracts/testing.js";
import { FUNDING_PLAN_LIMITS, manifestOf, planContextFor } from "./common.js";
import { getSqrtRatioAtTick } from "./math.js";
import { ALICE, BOB, createHarness, decodeAndVerify, freshKey, lowerAddresses, MARKET_A, MARKET_B, NPM, postPlan, refreshIndexer, SDAI, seedClaim, WAD, type Harness } from "./test/harness.js";

afterAll(releaseSuiteLock);

const LADDER = "/api/v1/funding/plans/ladder";
const BUDGET = 100n * WAD; // previewDeposit at 1.25 xDAI/sDAI = 80 sDAI
const SETS = 79_920_000_000_000_000_000n; // 80 - ceil(80 x 10 / 10000)
const SETS_MIN = 79_520_400_000_000_000_000n; // S - S x 50 / 10000
const LOSS_HAND = 24_825_784_262_892_005_726n; // bc: S x (1 - 1.0001^-3720), ticks [-6900, -540]
const POOL_A: Address = "0x000000000000000000000000000000000000a001";
const POOL_B: Address = "0x000000000000000000000000000000000000b001";
const START = new Date("2026-10-01T00:00:00.000Z");

let h: Harness;
let claimA: ReturnType<typeof seedClaim>;
let claimB: ReturnType<typeof seedClaim>;

/** Acknowledges a loss larger than any ladder of these tests can have, unless a test overrides riskAcknowledgement. */
const ACK_ANY = (10n ** 24n).toString();
const body = (market: Address, overrides: Record<string, unknown> = {}) => {
  const base: Record<string, unknown> = { market, budgetWei: BUDGET.toString(), lowerPrice: "0.5", upperPrice: "0.95", ...overrides };
  return { riskAcknowledgement: { budgetWei: base.budgetWei, maxLossIfYesShares: ACK_ANY }, ...base };
};

const stepOf = (plan: TxPlan, id: string) => {
  const step = plan.steps.find((item) => item.id === id);
  if (!step) throw new Error(`missing step ${id}`);
  return { ...step, args: lowerAddresses(step.args) };
};

interface MintParams {
  token0: string;
  token1: string;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: string;
  deadline: bigint;
}

async function planCount(): Promise<number> {
  const rows = await h.ctx.database.sql.query<{ count: string }>("SELECT count(*)::text AS count FROM funding_plans");
  return Number(rows[0]?.count ?? "0");
}

beforeAll(async () => {
  h = await createHarness();
  claimA = seedClaim(h.ctx, { ...MARKET_A });
  claimB = seedClaim(h.ctx, { ...MARKET_B });
});

afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  h.ctx.clock.set(START);
  refreshIndexer(h);
  h.ctx.readModel.setHalted(false);
  h.chain.pools.clear();
  h.chain.poolStates.clear();
  h.chain.balances.clear();
  h.chain.failTransport = false;
  h.chain.calls.length = 0;
  h.ctx.compliance.blockedActions.clear();
  h.ctx.compliance.blockedWallets.clear();
  h.ctx.compliance.termsMissing.clear();
  h.ctx.moderation.items.clear();
  delete h.ctx.quotas.limits.plans_per_day;
});

describe("ladder plan: pool states and orientation (PRD-04 3.2)", () => {
  it("missing pool, YES = token0: split, exact approval, create at getSqrtRatioAtTick(tickLower) - 1, YES-only mint to the account", async () => {
    const response = await postPlan(h, LADDER, body(MARKET_A.market));
    expect(response.statusCode, response.body).toBe(200);
    const json = response.json();
    const plan = decodeAndVerify(h, json.plan, claimA);
    expect(plan.steps.map((step) => step.id)).toEqual(["split", "approve-yes", "create-pool", "mint-yes"]);
    expect(plan.account).toBe(ALICE.wallet);
    expect(stepOf(plan, "split").value).toBe(BUDGET);
    expect(stepOf(plan, "split").args).toEqual([MARKET_A.market]);
    expect(stepOf(plan, "approve-yes").to).toBe(MARKET_A.yesToken);
    expect(stepOf(plan, "approve-yes").args).toEqual([NPM, SETS]);
    expect(stepOf(plan, "create-pool").args).toEqual([MARKET_A.yesToken, SDAI, getSqrtRatioAtTick(-6_900) - 1n]);
    const mint = stepOf(plan, "mint-yes").args[0] as MintParams;
    expect(mint.token0).toBe(MARKET_A.yesToken);
    expect(mint.token1).toBe(SDAI);
    expect([mint.tickLower, mint.tickUpper]).toEqual([-6_900, -540]);
    expect([mint.amount0Desired, mint.amount1Desired, mint.amount0Min, mint.amount1Min]).toEqual([SETS, 0n, SETS_MIN, 0n]);
    expect(mint.recipient.toLowerCase()).toBe(ALICE.wallet);
    expect(mint.deadline).toBe(BigInt(START.getTime() / 1000 + 20 * 60));
    expect(stepOf(plan, "mint-yes").dependsOn).toEqual(["approve-yes", "create-pool"]);

    expect(json.details.sets).toBe(SETS.toString());
    expect(json.details.sharesPreview).toBe((80n * WAD).toString());
    expect(json.details.remainderShares).toBe((80n * WAD - SETS).toString());
    expect(json.details.pool.action).toBe("create");
    const loss = BigInt(json.details.maxLossIfYes.sdai);
    expect(loss - LOSS_HAND < 10n ** 9n && LOSS_HAND - loss < 10n ** 9n).toBe(true);
    expect(BigInt(json.details.maxLossIfYes.xdai)).toBe((loss * 125n + 99n) / 100n);
    expect(json.details.range).toMatchObject({ tickLower: -6_900, tickUpper: -540 });
    expect(json.details.residualAllowance).toMatch(/10 wei/);
    // Every disclosure field of PRD-04 3.2 step 6 (PRD-04 4a), hand-computed:
    // gas = split 550,000 + approve 60,000 + createPool 6,800,000 + mint 400,000 = 7,810,000 units, at 1 gwei 0.00781 xDAI.
    expect(json.details.gasEstimate).toMatchObject({ units: "7810000", referenceGasPriceWei: "1000000000", costWeiAtReference: "7810000000000000" });
    // Loss if NO or Invalid: gas only; the 10 bps remainder (80 - 79.92 = 0.08 sDAI = 0.1 xDAI at 1.25) stays as full sets.
    expect(json.details.lossIfNoOrInvalid).toMatchObject({ remainderShares: "80000000000000000", remainderXdai: "100000000000000000" });
    expect(json.details.lossIfNoOrInvalid.statement).toMatch(/^Gas only/);
    expect(json.details.lossIfNoOrInvalid.remainderNote).toMatch(/10 bps/);
    // Fee range only (no pool yet, so no current fee): 0.01% .. 1.5%, governance maximum 6.5535%, hundredths of a bip.
    expect(json.details.fees).toMatchObject({ currentFee: null, minFee: 100, maxFee: 15_000, governanceMaxFee: 65_535, unit: "hundredths of a basis point" });
    expect(json.details.fees.note).toMatch(/dynamic/);
    expect(json.details.withdrawability.liquidityCooldownSeconds).toBeNull();
    expect(json.details.disclosures).toHaveLength(5);
    expect(json.details.withdrawability.statement).toMatch(/liquidityCooldown/);
    expect(json.details.disclosures.join(" ")).toMatch(/Liquidity is not a bounty/);
    expect(json.details.priceLabel).toMatch(/Not a probability/);
    expect(json.state).toBe("planned");
    expect(new Date(json.expiresAt).getTime() - START.getTime()).toBe(20 * 60 * 1000);
    // Every chain read of the request was pinned to one block.
    expect(new Set(h.chain.calls.map((call) => call.block))).toEqual(new Set(["0x1388"]));
  });

  it("missing pool, YES = token1: range [ceilTick(1/upper), floorTick(1/lower)], created at getSqrtRatioAtTick(tickUpper) + 1", async () => {
    const response = await postPlan(h, LADDER, body(MARKET_B.market));
    expect(response.statusCode, response.body).toBe(200);
    const json = response.json();
    const plan = decodeAndVerify(h, json.plan, claimB);
    expect(stepOf(plan, "create-pool").args).toEqual([SDAI, MARKET_B.yesToken, getSqrtRatioAtTick(6_900) + 1n]);
    const mint = stepOf(plan, "mint-yes").args[0] as MintParams;
    expect([mint.token0, mint.token1]).toEqual([SDAI, MARKET_B.yesToken]);
    expect([mint.tickLower, mint.tickUpper]).toEqual([540, 6_900]);
    expect([mint.amount0Desired, mint.amount1Desired, mint.amount0Min, mint.amount1Min]).toEqual([0n, SETS, 0n, SETS_MIN]);
    const loss = BigInt(json.details.maxLossIfYes.sdai);
    expect(loss - LOSS_HAND < 10n ** 9n && LOSS_HAND - loss < 10n ** 9n).toBe(true);
    expect(json.details.orientation.yesIsToken0).toBe(false);
  });

  it("existing but uninitialised pool (price 0) is initialised by the plan, with the pool's own tick spacing", async () => {
    h.chain.addPool(POOL_A, { token0: MARKET_A.yesToken, token1: SDAI, sqrtPriceX96: 0n, tick: 0, fee: 100, liquidity: 0n, tickSpacing: 200, cooldown: 0 });
    const json = (await postPlan(h, LADDER, body(MARKET_A.market))).json();
    const plan = decodeAndVerify(h, json.plan, claimA);
    const mint = stepOf(plan, "mint-yes").args[0] as MintParams;
    // ceilTick(0.5) = -6931 -> aligned up to -6800; floorTick(0.95) = -513 -> aligned down to -600.
    expect([mint.tickLower, mint.tickUpper]).toEqual([-6_800, -600]);
    expect(stepOf(plan, "create-pool").args).toEqual([MARKET_A.yesToken, SDAI, getSqrtRatioAtTick(-6_800) - 1n]);
    expect(json.details.pool).toMatchObject({ address: POOL_A, action: "initialise", tickSpacing: 200 });
  });

  it("existing pool priced below the range (YES = token0): no pool step, mint depends on the approval only", async () => {
    h.chain.addPool(POOL_A, { token0: MARKET_A.yesToken, token1: SDAI, sqrtPriceX96: getSqrtRatioAtTick(-7_000), tick: -7_000, fee: 2_959, liquidity: 10n ** 18n, tickSpacing: 60, cooldown: 0 });
    const json = (await postPlan(h, LADDER, body(MARKET_A.market))).json();
    const plan = decodeAndVerify(h, json.plan, claimA);
    expect(plan.steps.map((step) => step.id)).toEqual(["split", "approve-yes", "mint-yes"]);
    expect(stepOf(plan, "mint-yes").dependsOn).toEqual(["approve-yes"]);
    expect(json.details.pool.action).toBe("existing");
    expect(json.details.fees).toMatchObject({ currentFee: 2_959, minFee: 100, maxFee: 15_000, governanceMaxFee: 65_535 });
    // No pool step: split 550,000 + approve 60,000 + mint 400,000.
    expect(json.details.gasEstimate).toMatchObject({ units: "1010000", costWeiAtReference: "1010000000000000" });
    expect(json.details.withdrawability.liquidityCooldownSeconds).toBe(0);
  });

  it("existing pool priced above the range (YES = token1) is correctly priced", async () => {
    h.chain.addPool(POOL_B, { token0: SDAI, token1: MARKET_B.yesToken, sqrtPriceX96: getSqrtRatioAtTick(7_000), tick: 7_000, fee: 100, liquidity: 0n, tickSpacing: 60, cooldown: 3_600 });
    const json = (await postPlan(h, LADDER, body(MARKET_B.market))).json();
    const plan = decodeAndVerify(h, json.plan, claimB);
    expect(plan.steps.map((step) => step.id)).toEqual(["split", "approve-yes", "mint-yes"]);
    expect(json.details.withdrawability.statement).toMatch(/currently 3600 s/);
  });

  it("refuses a mispriced existing pool (price inside the range) with an explanation; no plan is stored", async () => {
    const before = await planCount();
    h.chain.addPool(POOL_A, { token0: MARKET_A.yesToken, token1: SDAI, sqrtPriceX96: getSqrtRatioAtTick(-5_108), tick: -5_108, fee: 100, liquidity: 10n ** 18n, tickSpacing: 60, cooldown: 0 });
    const response = await postPlan(h, LADDER, body(MARKET_A.market));
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("UNPROCESSABLE");
    expect(response.json().error.message).toMatch(/never re-prices pools/);
    expect(response.json().error.message).toMatch(/ 0\.6\d* sDAI, inside the ladder's range/);
    expect(await planCount()).toBe(before);
  });

  it("refuses a mispriced existing pool for YES = token1 (YES priced inside the range)", async () => {
    const before = await planCount();
    h.chain.addPool(POOL_B, { token0: SDAI, token1: MARKET_B.yesToken, sqrtPriceX96: getSqrtRatioAtTick(6_000), tick: 6_000, fee: 100, liquidity: 0n, tickSpacing: 60, cooldown: 0 });
    const response = await postPlan(h, LADDER, body(MARKET_B.market));
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toMatch(/inside the ladder's range/);
    expect(await planCount()).toBe(before);
  });

  // Coverage P1 of markets-002: a pool priced OUTSIDE the range on the wrong side (YES dearer than upperPrice).
  // Range [0.5, 0.95] -> YES = token0 ticks [-6900, -540]; YES = token1 ticks [540, 6900].
  const wrongSide = [
    // YES = token0: pool price is sDAI per YES; tick -200 is YES at ~0.98 sDAI, above tickUpper -540.
    { name: "YES = token0, YES at ~0.98 (tick -200 >= tickUpper -540)", market: MARKET_A, pool: POOL_A, token0: MARKET_A.yesToken, token1: SDAI, tick: -200 },
    // Exactly at tickUpper: Algebra treats the position as token1-only (sDAI), never YES-only.
    { name: "YES = token0, pool exactly at tickUpper -540", market: MARKET_A, pool: POOL_A, token0: MARKET_A.yesToken, token1: SDAI, tick: -540 },
    // YES = token1: pool price is YES per sDAI; tick 200 is YES at ~0.98 sDAI, below tickLower 540.
    { name: "YES = token1, YES at ~0.98 (tick 200 < tickLower 540)", market: MARKET_B, pool: POOL_B, token0: SDAI, token1: MARKET_B.yesToken, tick: 200 },
    { name: "YES = token1, pool one tick below tickLower (539)", market: MARKET_B, pool: POOL_B, token0: SDAI, token1: MARKET_B.yesToken, tick: 539 },
  ] as const;
  for (const item of wrongSide) {
    it(`refuses an existing pool priced on the wrong side, outside the range: ${item.name}; no plan is stored`, async () => {
      const before = await planCount();
      h.chain.addPool(item.pool, { token0: item.token0, token1: item.token1, sqrtPriceX96: getSqrtRatioAtTick(item.tick), tick: item.tick, fee: 100, liquidity: 10n ** 18n, tickSpacing: 60, cooldown: 0 });
      const response = await postPlan(h, LADDER, body(item.market.market));
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().error.code).toBe("UNPROCESSABLE");
      expect(response.json().error.message).toMatch(/above the ladder's upper price 0\.94\d* sDAI/);
      expect(response.json().error.message).toMatch(/never re-prices pools with swaps/);
      expect(await planCount()).toBe(before);
      // A refused build never reaches a swap: the only chain reads are views (no quoter, no swap simulation).
      expect(h.chain.calls.map((call) => call.functionName)).not.toContain("quoteExactInputSingle");
    });
  }

  it("accepts the YES = token1 pool exactly at tickUpper 6900 (YES-only) and YES = token0 one tick below tickLower", async () => {
    h.chain.addPool(POOL_B, { token0: SDAI, token1: MARKET_B.yesToken, sqrtPriceX96: getSqrtRatioAtTick(6_900), tick: 6_900, fee: 100, liquidity: 0n, tickSpacing: 60, cooldown: 0 });
    expect((await postPlan(h, LADDER, body(MARKET_B.market))).statusCode).toBe(200);
    h.chain.addPool(POOL_A, { token0: MARKET_A.yesToken, token1: SDAI, sqrtPriceX96: getSqrtRatioAtTick(-6_901), tick: -6_901, fee: 100, liquidity: 0n, tickSpacing: 60, cooldown: 0 });
    expect((await postPlan(h, LADDER, body(MARKET_A.market))).statusCode).toBe(200);
  });

  it("refuses a range narrower than one tick spacing with VALIDATION_FAILED (operator clarification 4)", async () => {
    const response = await postPlan(h, LADDER, body(MARKET_A.market, { lowerPrice: "0.5", upperPrice: "0.501" }));
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_FAILED");
    expect(response.json().error.message).toMatch(/narrower than one tick spacing/);
  });
});

describe("risk acknowledgement (SEC-LEGAL-03, PRD-04 4a)", () => {
  const withAck = (maxLossIfYesShares: string, overrides: Record<string, unknown> = {}) =>
    body(MARKET_A.market, { riskAcknowledgement: { budgetWei: BUDGET.toString(), maxLossIfYesShares }, ...overrides });

  async function computedLoss(): Promise<bigint> {
    const response = await postPlan(h, LADDER, body(MARKET_A.market));
    expect(response.statusCode, response.body).toBe(200);
    return BigInt(response.json().details.maxLossIfYes.sdai);
  }

  it("SEC-LEGAL-03 accepts an acknowledged maximum loss equal to or above the computed one (favourable drift is fine)", async () => {
    const loss = await computedLoss();
    // Hand-computed S x (1 - 1.0001^-3720) over the final ticks [-6900, -540].
    expect(loss - LOSS_HAND < 10n ** 9n && LOSS_HAND - loss < 10n ** 9n).toBe(true);
    for (const acknowledged of [loss, loss + 1n, 2n * loss]) {
      const response = await postPlan(h, LADDER, withAck(acknowledged.toString()));
      expect(response.statusCode, acknowledged.toString()).toBe(200);
      expect(response.json().details.maxLossIfYes.sdai).toBe(loss.toString());
    }
  });

  it("SEC-LEGAL-03 refuses with 409 and the freshly computed figures when the computed loss exceeds the acknowledged one; nothing is stored", async () => {
    const loss = await computedLoss();
    const before = await planCount();
    const key = freshKey();
    const response = await postPlan(h, LADDER, withAck((loss - 1n).toString()), { key });
    expect(response.statusCode).toBe(409);
    const error = response.json().error;
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain(`now ${loss} sDAI share base units`);
    expect(error.message).toContain(`acknowledged ${loss - 1n}`);
    const figures = Object.fromEntries((error.issues as { path: string[]; message: string }[]).map((issue) => [issue.path.join("."), issue.message]));
    expect(figures).toEqual({
      "riskAcknowledgement.computed.maxLossIfYesShares": loss.toString(),
      "riskAcknowledgement.computed.maxLossIfYesXdaiWei": ((loss * 125n + 99n) / 100n).toString(),
      "riskAcknowledgement.computed.budgetWei": BUDGET.toString(),
      "riskAcknowledgement.computed.sets": SETS.toString(),
      "riskAcknowledgement.computed.finalLowerPrice": expect.stringMatching(/^0\.501/),
      "riskAcknowledgement.computed.finalUpperPrice": expect.stringMatching(/^0\.947/),
    });
    expect(await planCount()).toBe(before);
    // Nothing was stored under the key, so the client can acknowledge the fresh figures with the same key.
    const retry = await postPlan(h, LADDER, withAck(loss.toString()), { key });
    expect(retry.statusCode, retry.body).toBe(200);
  });

  it("SEC-LEGAL-03 the acknowledgement is required: missing, a budget other than the request's, malformed values or an acknowledged fee are VALIDATION_FAILED", async () => {
    const before = await planCount();
    const { riskAcknowledgement: _omitted, ...withoutAck } = body(MARKET_A.market);
    const cases: [string, unknown][] = [
      ["missing", withoutAck],
      ["other budget", withAck(ACK_ANY, { riskAcknowledgement: { budgetWei: (BUDGET - 1n).toString(), maxLossIfYesShares: ACK_ANY } })],
      ["fees acknowledged", withAck(ACK_ANY, { riskAcknowledgement: { budgetWei: BUDGET.toString(), maxLossIfYesShares: ACK_ANY, feesBps: "50" } })],
      ["not an object", withAck(ACK_ANY, { riskAcknowledgement: "yes" })],
      ...["abc", "1.5", "-1", "", "0x10", `1${"0".repeat(78)}`].map((value): [string, unknown] => [`maxLossIfYesShares ${JSON.stringify(value)}`, withAck(value)]),
    ];
    for (const [name, payload] of cases) {
      const response = await postPlan(h, LADDER, payload);
      expect(response.statusCode, name).toBe(400);
      expect(response.json().error.code, name).toBe("VALIDATION_FAILED");
    }
    const otherBudget = await postPlan(h, LADDER, withAck(ACK_ANY, { riskAcknowledgement: { budgetWei: (BUDGET - 1n).toString(), maxLossIfYesShares: ACK_ANY } }));
    expect(JSON.stringify(otherBudget.json().error.issues)).toMatch(/riskAcknowledgement/);
    expect(await planCount()).toBe(before);
  });

  it("SEC-LEGAL-03 stores the acknowledgement with the plan and binds it into the idempotency body hash", async () => {
    const loss = await computedLoss();
    const key = freshKey();
    const acknowledged = (loss + 5n).toString();
    const response = await postPlan(h, LADDER, withAck(acknowledged), { key });
    expect(response.statusCode, response.body).toBe(200);
    const expected = { budgetWei: BUDGET.toString(), maxLossIfYesShares: acknowledged, computedMaxLossIfYesShares: loss.toString(), acknowledgedAt: START.toISOString() };
    expect(response.json().details.riskAcknowledgement).toMatchObject(expected);
    const rows = await h.ctx.database.sql.query<{ ack: Record<string, unknown> }>("SELECT details->'riskAcknowledgement' AS ack FROM funding_plans WHERE id = $1::uuid", [response.json().planId]);
    expect(rows[0]?.ack).toMatchObject(expected);
    // A different acknowledgement under the same key is a different request body.
    const conflict = await postPlan(h, LADDER, withAck(loss.toString()), { key });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.message).toMatch(/different request body/);
  });
});

describe("splitFromBase and exact approvals (SEC-TX)", () => {
  it("omits splitFromBase when the YES balance already covers S, so a fresh plan never splits twice", async () => {
    h.chain.setBalance(MARKET_A.yesToken, ALICE.wallet, SETS);
    const plan = decodeAndVerify(h, (await postPlan(h, LADDER, body(MARKET_A.market))).json().plan, claimA);
    expect(plan.steps.map((step) => step.id)).toEqual(["approve-yes", "create-pool", "mint-yes"]);
    expect(stepOf(plan, "approve-yes").dependsOn).toEqual([]);
    expect(plan.steps.reduce((sum, step) => sum + step.value, 0n)).toBe(0n);
  });

  it("keeps splitFromBase when the YES balance is one wei short of S", async () => {
    h.chain.setBalance(MARKET_A.yesToken, ALICE.wallet, SETS - 1n);
    const plan = decodeAndVerify(h, (await postPlan(h, LADDER, body(MARKET_A.market))).json().plan, claimA);
    expect(plan.steps[0]?.id).toBe("split");
  });

  it("SEC-TX-03 the approval equals the mint amount exactly; a larger approval or another recipient fails verifyPlan", async () => {
    const plan = decodeAndVerify(h, (await postPlan(h, LADDER, body(MARKET_A.market))).json().plan, claimA);
    const approve = stepOf(plan, "approve-yes");
    const mint = stepOf(plan, "mint-yes").args[0] as MintParams;
    expect(approve.args[1]).toBe(mint.amount0Desired);
    const manifest = manifestOf(h.ctx.config);
    const context = planContextFor({ ...claimA } as never);
    const rebuild = (approval: bigint, recipient: string) =>
      newPlan(manifest, plan.planId, plan.account, [
        buildStep(manifest, { id: "approve-yes", allowlistId: "outcomeToken.approve", to: MARKET_A.yesToken, args: [NPM, approval] }),
        buildStep(manifest, { id: "mint-yes", allowlistId: "positionManager.mint", args: [{ ...mint, recipient }] }),
      ]);
    expect(() => verifyPlan(rebuild(SETS, plan.account), manifest, context, FUNDING_PLAN_LIMITS)).not.toThrow();
    expect(() => verifyPlan(rebuild(SETS + 1n, plan.account), manifest, context, FUNDING_PLAN_LIMITS)).toThrow(/approval amount is not consumed exactly/);
    expect(() => verifyPlan(rebuild(SETS, BOB.wallet), manifest, context, FUNDING_PLAN_LIMITS)).toThrow(/recipient must be the plan account/);
  });

  it("SEC-TX-01 binds the plan to the session wallet, never to a client-supplied account", async () => {
    const response = await postPlan(h, LADDER, { ...body(MARKET_A.market), account: BOB.wallet });
    expect(response.statusCode).toBe(400);
    const own = (await postPlan(h, LADDER, body(MARKET_A.market), { session: BOB })).json();
    const plan = decodeAndVerify(h, own.plan, claimA);
    expect(plan.account).toBe(BOB.wallet);
    expect((stepOf(plan, "mint-yes").args[0] as MintParams).recipient.toLowerCase()).toBe(BOB.wallet);
  });
});

describe("idempotency (SEC-TX-08)", () => {
  it("same key and body return the stored plan unchanged and consume one quota unit", async () => {
    const key = freshKey();
    const usedBefore = h.ctx.quotas.used.get(`${ALICE.userId}:plans_per_day`) ?? 0;
    const first = await postPlan(h, LADDER, body(MARKET_A.market), { key });
    h.ctx.clock.advance(5_000);
    refreshIndexer(h);
    h.chain.setBalance(MARKET_A.yesToken, ALICE.wallet, SETS); // chain state changed: a rebuild would differ
    const second = await postPlan(h, LADDER, body(MARKET_A.market), { key });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(h.ctx.quotas.used.get(`${ALICE.userId}:plans_per_day`)).toBe(usedBefore + 1);
  });

  it("same key with a different body is 409 CONFLICT", async () => {
    const key = freshKey();
    expect((await postPlan(h, LADDER, body(MARKET_A.market), { key })).statusCode).toBe(200);
    const conflict = await postPlan(h, LADDER, body(MARKET_A.market, { upperPrice: "0.9" }), { key });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("CONFLICT");
  });

  it("keys are scoped per user: another user's identical key is a separate plan", async () => {
    const key = freshKey();
    const alice = (await postPlan(h, LADDER, body(MARKET_A.market), { key })).json();
    const bob = (await postPlan(h, LADDER, body(MARKET_A.market), { key, session: BOB })).json();
    expect(bob.planId).not.toBe(alice.planId);
  });

  it("a missing or malformed Idempotency-Key is 400 and stores nothing", async () => {
    const before = await planCount();
    expect((await postPlan(h, LADDER, body(MARKET_A.market), { key: null })).statusCode).toBe(400);
    expect((await postPlan(h, LADDER, body(MARKET_A.market), { key: "bad key!" })).statusCode).toBe(400);
    expect((await postPlan(h, LADDER, body(MARKET_A.market), { key: "k".repeat(65) })).statusCode).toBe(400);
    expect(await planCount()).toBe(before);
  });

  it("QUOTA_EXCEEDED never leaves a stored plan", async () => {
    const before = await planCount();
    h.ctx.quotas.limits.plans_per_day = h.ctx.quotas.used.get(`${ALICE.userId}:plans_per_day`) ?? 0;
    const response = await postPlan(h, LADDER, body(MARKET_A.market));
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("QUOTA_EXCEEDED");
    expect(await planCount()).toBe(before);
  });
});

describe("createOrReplayPlan order and audit (PRD-04 4b, SEC-OPS-07)", () => {
  const created = () => h.ctx.audit.entries.filter((entry) => entry.action === "funding.plan.created");
  const usedQuota = () => h.ctx.quotas.used.get(`${ALICE.userId}:plans_per_day`) ?? 0;

  it("SEC-OPS-07 a stored plan writes exactly one redacted audit entry (actor, plan id, route, kind, market, step count, IP); a same-key replay writes none", async () => {
    const key = freshKey();
    const before = created().length;
    const first = await postPlan(h, LADDER, body(MARKET_A.market), { key });
    expect(first.statusCode, first.body).toBe(200);
    const entries = created().slice(before);
    expect(entries).toEqual([
      {
        actorUserId: ALICE.userId,
        action: "funding.plan.created",
        subjectType: "funding_plan",
        subjectId: first.json().planId,
        details: { route: "funding.ladder", kind: "ladder", market: MARKET_A.market, steps: 4 },
        ip: "127.0.0.1",
      },
    ]);
    const replay = await postPlan(h, LADDER, body(MARKET_A.market), { key });
    expect(replay.json().planId).toBe(first.json().planId);
    expect(created().length).toBe(before + 1);
  });

  it("SEC-OPS-07 a refused request (409 different body, NOT_READY, QUOTA_EXCEEDED) writes no audit entry", async () => {
    const key = freshKey();
    expect((await postPlan(h, LADDER, body(MARKET_A.market), { key })).statusCode).toBe(200);
    const before = h.ctx.audit.entries.length;
    expect((await postPlan(h, LADDER, body(MARKET_A.market, { upperPrice: "0.9" }), { key })).statusCode).toBe(409);
    h.ctx.readModel.setHalted(true);
    expect((await postPlan(h, LADDER, body(MARKET_A.market))).statusCode).toBe(503);
    h.ctx.readModel.setHalted(false);
    h.ctx.quotas.limits.plans_per_day = usedQuota();
    expect((await postPlan(h, LADDER, body(MARKET_A.market))).statusCode).toBe(429);
    expect(h.ctx.audit.entries.length).toBe(before);
  });

  it("a same-key replay is answered from the store while the read model is halted: no quota, no chain read", async () => {
    const key = freshKey();
    const first = await postPlan(h, LADDER, body(MARKET_A.market), { key });
    expect(first.statusCode).toBe(200);
    h.ctx.readModel.setHalted(true);
    const used = usedQuota();
    const rpc = h.chain.rpcCount;
    const replay = await postPlan(h, LADDER, body(MARKET_A.market), { key });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(usedQuota()).toBe(used);
    expect(h.chain.rpcCount).toBe(rpc);
    // A new key is refused while halted, and the refusal burns no quota.
    const fresh = await postPlan(h, LADDER, body(MARKET_A.market));
    expect(fresh.json().error.code).toBe("NOT_READY");
    expect(usedQuota()).toBe(used);
  });

  it("an exhausted plans_per_day quota is refused before any chain read and stores nothing", async () => {
    const before = await planCount();
    h.ctx.quotas.limits.plans_per_day = usedQuota();
    const rpc = h.chain.rpcCount;
    const response = await postPlan(h, LADDER, body(MARKET_A.market));
    expect(response.json().error.code).toBe("QUOTA_EXCEEDED");
    expect(h.chain.rpcCount).toBe(rpc);
    expect(h.chain.calls).toEqual([]);
    expect(await planCount()).toBe(before);
  });
});

describe("gates: readiness, compliance, phase, moderation, input bounds", () => {
  it("NOT_READY when the read model is halted or stale", async () => {
    h.ctx.readModel.setHalted(true);
    const halted = await postPlan(h, LADDER, body(MARKET_A.market));
    expect(halted.statusCode).toBe(503);
    expect(halted.json().error.code).toBe("NOT_READY");
    h.ctx.readModel.setHalted(false);
    h.ctx.clock.advance((h.ctx.config.maxIndexerLagSeconds + 60) * 1000);
    const stale = await postPlan(h, LADDER, body(MARKET_A.market));
    expect(stale.json().error.code).toBe("NOT_READY");
  });

  it("SEC-LEGAL-01 SEC-LEGAL-02 SEC-LEGAL-03 compliance refusals (blocked action, blocked wallet, missing terms) return no plan", async () => {
    const before = await planCount();
    h.ctx.compliance.blockedActions.add("fund_market");
    expect((await postPlan(h, LADDER, body(MARKET_A.market))).statusCode).toBe(451);
    h.ctx.compliance.blockedActions.clear();
    h.ctx.compliance.blockedWallets.add(ALICE.wallet);
    expect((await postPlan(h, LADDER, body(MARKET_A.market))).statusCode).toBe(451);
    h.ctx.compliance.blockedWallets.clear();
    h.ctx.compliance.termsMissing.add(ALICE.userId);
    const terms = await postPlan(h, LADDER, body(MARKET_A.market));
    expect(terms.json().error.code).toBe("TERMS_REQUIRED");
    expect(await planCount()).toBe(before);
    expect(h.ctx.compliance.calls.at(-1)?.action).toBe("fund_market");
  });

  it("requires a session", async () => {
    const response = await h.app.inject({ method: "POST", url: LADDER, headers: { "content-type": "application/json", "idempotency-key": freshKey() }, payload: JSON.stringify(body(MARKET_A.market)) });
    expect(response.statusCode).toBe(401);
  });

  it("is offered until 1 hour before the evidence deadline, not at it", async () => {
    const deadline = claimA.document.evidence.evidenceDeadline;
    h.ctx.clock.set(new Date((deadline - 3_601) * 1000));
    refreshIndexer(h);
    expect((await postPlan(h, LADDER, body(MARKET_A.market))).statusCode).toBe(200);
    h.ctx.clock.set(new Date((deadline - 3_600) * 1000));
    refreshIndexer(h);
    const late = await postPlan(h, LADDER, body(MARKET_A.market));
    expect(late.statusCode).toBe(422);
    expect(late.json().error.message).toMatch(/1 hour before the evidence deadline/);
  });

  it("refuses hidden or blocked claims", async () => {
    h.ctx.moderation.set("claim", MARKET_A.market, "hide", "spam");
    expect((await postPlan(h, LADDER, body(MARKET_A.market))).statusCode).toBe(422);
    h.ctx.moderation.items.clear();
    h.ctx.moderation.set("claim", MARKET_A.market, "block", "illegal");
    expect((await postPlan(h, LADDER, body(MARKET_A.market))).statusCode).toBe(422);
  });

  it("unknown market is NOT_FOUND", async () => {
    const response = await postPlan(h, LADDER, body("0x0000000000000000000000000000000000dead01"));
    expect(response.statusCode).toBe(404);
  });

  it("validates price bounds [0.01, 0.95], ordering, the 10,000 xDAI limit and unknown fields", async () => {
    const bad = [
      { lowerPrice: "0.009" },
      { upperPrice: "0.951" },
      { lowerPrice: "0.6", upperPrice: "0.6" },
      { lowerPrice: "0.7", upperPrice: "0.6" },
      { lowerPrice: "1e-1" },
      { budgetWei: "0" },
      { budgetWei: (10_000n * WAD + 1n).toString() },
      { budgetWei: "-5" },
      { salt: "0x01" },
    ];
    for (const overrides of bad) {
      const response = await postPlan(h, LADDER, body(MARKET_A.market, overrides));
      expect(response.statusCode, JSON.stringify(overrides)).toBe(400);
    }
  });

  it("malformed budgetWei (\"abc\", \"1.5\", \"-1\", \"\", 79 digits) is 400 VALIDATION_FAILED, never 500, with or without a session", async () => {
    const before = await planCount();
    for (const budgetWei of ["abc", "1.5", "-1", "", `1${"0".repeat(78)}`]) {
      const signedIn = await postPlan(h, LADDER, body(MARKET_A.market, { budgetWei }));
      expect(signedIn.statusCode, budgetWei).toBe(400);
      expect(signedIn.json().error.code, budgetWei).toBe("VALIDATION_FAILED");
      const anonymous = await h.app.inject({
        method: "POST",
        url: LADDER,
        headers: { "content-type": "application/json", "idempotency-key": freshKey() },
        payload: JSON.stringify(body(MARKET_A.market, { budgetWei })),
      });
      expect(anonymous.statusCode, budgetWei).toBe(400);
    }
    expect(await planCount()).toBe(before);
  });

  it("a budget too small to leave S > 0 after the margin is refused", async () => {
    const response = await postPlan(h, LADDER, body(MARKET_A.market, { budgetWei: "1" }));
    expect(response.statusCode).toBe(400);
  });

  it("RPC failures are UPSTREAM_UNAVAILABLE without leaking the RPC URL to the response or the logs", async () => {
    h.logs.lines.length = 0;
    const before = await planCount();
    h.chain.failTransport = true;
    const response = await postPlan(h, LADDER, body(MARKET_A.market));
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toMatch(/secret-key|rpc\.example/);
    expect(h.logs.text()).toMatch(/UPSTREAM_UNAVAILABLE/);
    expect(h.logs.text()).not.toMatch(/secret-key|rpc\.example|ECONNREFUSED/);
    expect(await planCount()).toBe(before);
  });

  it("is JSON-only: a multipart body (core registers @fastify/multipart) is refused and stores nothing", async () => {
    const before = await planCount();
    const boundary = "----pine-funding-test";
    const payload = [`--${boundary}`, 'Content-Disposition: form-data; name="market"', "", MARKET_A.market, `--${boundary}--`, ""].join("\r\n");
    const response = await h.app.inject({
      method: "POST",
      url: LADDER,
      headers: { ...testSessionHeaders(ALICE), "idempotency-key": freshKey(), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(await planCount()).toBe(before);
  });
});
