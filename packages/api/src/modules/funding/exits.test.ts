import { releaseSuiteLock } from "./test/lock.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import type { ConditionResolutionEvent } from "@pine/shared/chain-events";
import type { TxPlan } from "@pine/shared/tx-plan";
import type { Address, Hex32 } from "@pine/shared/types";
import { amountsForLiquidity, getSqrtRatioAtTick, minusSlippage } from "./math.js";
import { ALICE, BOB, createHarness, decodeAndVerify, freshKey, lowerAddresses, MARKET_A, MARKET_B, postPlan, refreshIndexer, ROUTER, SDAI, seedClaim, WAD, type Harness } from "./test/harness.js";

afterAll(releaseSuiteLock);

const POOL: Address = "0x000000000000000000000000000000000000a001";
const UINT128_MAX = (1n << 128n) - 1n;
const START = new Date("2026-10-01T00:00:00.000Z");
let h: Harness;
let claimA: ReturnType<typeof seedClaim>;
let claimB: ReturnType<typeof seedClaim>;
let block = 3_000n;

const ids = (plan: TxPlan) => plan.steps.map((step) => step.id);
const stepArgs = (plan: TxPlan, id: string) => lowerAddresses(plan.steps.find((step) => step.id === id)?.args);

function resolve(conditionId: Hex32, payoutNumerators: bigint[]): void {
  block += 1n;
  const event: ConditionResolutionEvent = {
    kind: "ConditionResolution",
    chainId: 100,
    address: "0xceafdd6bc0bef976fdcd1112955828e00543c0ce",
    blockNumber: block,
    blockHash: keccak256(toHex(`resolution-${block}`)) as Hex32,
    blockTimestamp: 1_790_812_800,
    transactionHash: keccak256(toHex(`resolution-tx-${block}`)) as Hex32,
    logIndex: 0,
    conditionId,
    oracle: "0xc260adfac11f97c001dc143d2a4f45b98e0f2d6c",
    ctfQuestionId: keccak256(toHex(`ctf-${conditionId}`)) as Hex32,
    outcomeSlotCount: 3,
    payoutNumerators,
  };
  h.ctx.readModel.apply([event]);
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
  h.chain.pools.clear();
  h.chain.poolStates.clear();
  h.chain.balances.clear();
  h.chain.positions.clear();
  h.ctx.compliance.blockedActions.clear();
});

describe("withdraw plan (PRD-04 3.3)", () => {
  const WITHDRAW = "/api/v1/funding/plans/withdraw";

  function setup(position: Partial<{ owner: Address; liquidity: bigint; tokensOwed0: bigint; tokensOwed1: bigint; token: Address }> = {}, poolTick = 0) {
    h.chain.addPool(POOL, { token0: MARKET_A.yesToken, token1: SDAI, sqrtPriceX96: getSqrtRatioAtTick(poolTick), tick: poolTick, fee: 100, liquidity: 10n ** 20n, tickSpacing: 60, cooldown: 0 });
    h.chain.positions.set(42n, {
      owner: position.owner ?? ALICE.wallet,
      token0: position.token ?? MARKET_A.yesToken,
      token1: SDAI,
      tickLower: -600,
      tickUpper: 600,
      liquidity: position.liquidity ?? 10n ** 20n,
      tokensOwed0: position.tokensOwed0 ?? 0n,
      tokensOwed1: position.tokensOwed1 ?? 0n,
    });
  }

  it("decreases all liquidity with mins from a fresh quote (50 bps), collects to the account with max amounts, then burns", async () => {
    setup();
    const response = await postPlan(h, WITHDRAW, { market: MARKET_A.market, tokenId: "42" });
    expect(response.statusCode, response.body).toBe(200);
    const json = response.json();
    const plan = decodeAndVerify(h, json.plan, claimA);
    expect(ids(plan)).toEqual(["decrease", "collect", "burn"]);
    const expected = amountsForLiquidity({ currentTick: 0, sqrtPriceX96: getSqrtRatioAtTick(0), tickLower: -600, tickUpper: 600, liquidity: 10n ** 20n });
    expect(stepArgs(plan, "decrease")).toEqual([
      { tokenId: 42n, liquidity: 10n ** 20n, amount0Min: minusSlippage(expected.amount0), amount1Min: minusSlippage(expected.amount1), deadline: BigInt(START.getTime() / 1000 + 1_200) },
    ]);
    expect(stepArgs(plan, "collect")).toEqual([{ tokenId: 42n, recipient: ALICE.wallet, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX }]);
    expect(stepArgs(plan, "burn")).toEqual([42n]);
    expect(json.details.statement).toMatch(/liquidityCooldown\(\) is currently 0/);
    expect(h.ctx.compliance.calls.at(-1)?.action).toBe("redeem");
  });

  it("only collects and burns when no liquidity is left; only burns an empty NFT", async () => {
    setup({ liquidity: 0n, tokensOwed0: 5n });
    expect(ids(decodeAndVerify(h, (await postPlan(h, WITHDRAW, { market: MARKET_A.market, tokenId: "42" })).json().plan, claimA))).toEqual(["collect", "burn"]);
    setup({ liquidity: 0n });
    expect(ids(decodeAndVerify(h, (await postPlan(h, WITHDRAW, { market: MARKET_A.market, tokenId: "42" })).json().plan, claimA))).toEqual(["burn"]);
  });

  it("refuses a position the session wallet does not own (ownerOf by eth_call)", async () => {
    setup({ owner: BOB.wallet });
    const response = await postPlan(h, WITHDRAW, { market: MARKET_A.market, tokenId: "42" });
    expect(response.statusCode).toBe(403);
    expect((await postPlan(h, WITHDRAW, { market: MARKET_A.market, tokenId: "43" })).statusCode).toBe(404);
  });

  it("refuses a position whose pair is not this claim market's outcome token with sDAI", async () => {
    setup({ token: "0x5000000000000000000000000000000000000001" });
    expect((await postPlan(h, WITHDRAW, { market: MARKET_A.market, tokenId: "42" })).statusCode).toBe(422);
    setup();
    // The same position against another registered market is refused too.
    expect((await postPlan(h, WITHDRAW, { market: MARKET_B.market, tokenId: "42" })).statusCode).toBe(422);
  });

  it("requires {market, tokenId}: a body without market is VALIDATION_FAILED and reads nothing (PRD-04 4a)", async () => {
    setup();
    h.chain.calls.length = 0;
    const response = await postPlan(h, WITHDRAW, { tokenId: "42" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_FAILED");
    expect((await postPlan(h, WITHDRAW, { market: MARKET_A.market })).statusCode).toBe(400);
    expect(h.chain.calls).toEqual([]);
  });

  it("states a non-zero liquidityCooldown", async () => {
    setup();
    const state = h.chain.poolStates.get(POOL);
    if (state) state.cooldown = 86_400;
    const json = (await postPlan(h, WITHDRAW, { market: MARKET_A.market, tokenId: "42" })).json();
    expect(json.details.statement).toMatch(/86400 s/);
  });
});

describe("merge plan (PRD-04 3.3)", () => {
  const MERGE = "/api/v1/funding/plans/merge";

  it("three exact approvals to the GnosisRouter consumed by mergeToBase", async () => {
    for (const token of [MARKET_A.yesToken, MARKET_A.noToken, MARKET_A.invalidToken]) h.chain.setBalance(token, ALICE.wallet, 5n * WAD);
    const response = await postPlan(h, MERGE, { market: MARKET_A.market, amount: (2n * WAD).toString() });
    expect(response.statusCode, response.body).toBe(200);
    const plan = decodeAndVerify(h, response.json().plan, claimA);
    expect(ids(plan)).toEqual(["approve-yes", "approve-no", "approve-invalid", "merge"]);
    for (const [id, token] of [["approve-yes", MARKET_A.yesToken], ["approve-no", MARKET_A.noToken], ["approve-invalid", MARKET_A.invalidToken]] as const) {
      const step = plan.steps.find((item) => item.id === id);
      expect(step?.to).toBe(token);
      expect(lowerAddresses(step?.args)).toEqual([ROUTER, 2n * WAD]);
    }
    expect(stepArgs(plan, "merge")).toEqual([MARKET_A.market, 2n * WAD]);
    expect(response.json().details.expectedXdai).toBe((25n * WAD / 10n).toString());
  });

  it("refuses when any outcome balance is short, and validates the amount", async () => {
    h.chain.setBalance(MARKET_A.yesToken, ALICE.wallet, 5n * WAD);
    h.chain.setBalance(MARKET_A.noToken, ALICE.wallet, 5n * WAD);
    const short = await postPlan(h, MERGE, { market: MARKET_A.market, amount: WAD.toString() });
    expect(short.statusCode).toBe(422);
    expect(short.json().error.message).toMatch(/invalid/);
    expect((await postPlan(h, MERGE, { market: MARKET_A.market, amount: "0" })).statusCode).toBe(400);
    expect((await postPlan(h, MERGE, { market: MARKET_A.market, amount: (10n ** 30n + 1n).toString() })).statusCode).toBe(400);
  });

  it("SEC-LEGAL-01 compliance refusal returns no plan", async () => {
    h.ctx.compliance.blockedActions.add("redeem");
    expect((await postPlan(h, MERGE, { market: MARKET_A.market, amount: WAD.toString() })).statusCode).toBe(451);
  });
});

describe("redeem plan (PRD-04 3.3)", () => {
  const REDEEM = "/api/v1/funding/plans/redeem";

  it("is refused before ConditionResolution", async () => {
    const response = await postPlan(h, REDEEM, { market: MARKET_B.market });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toMatch(/not resolved/);
  });

  it("approves exactly the winning tokens held and redeems them to xDAI", async () => {
    resolve(claimA.conditionId, [1n, 0n, 0n]);
    h.chain.setBalance(MARKET_A.yesToken, ALICE.wallet, 3n * WAD);
    h.chain.setBalance(MARKET_A.noToken, ALICE.wallet, 9n * WAD);
    const response = await postPlan(h, REDEEM, { market: MARKET_A.market });
    expect(response.statusCode, response.body).toBe(200);
    const plan = decodeAndVerify(h, response.json().plan, claimA);
    expect(ids(plan)).toEqual(["approve-yes", "redeem"]);
    expect(stepArgs(plan, "approve-yes")).toEqual([ROUTER, 3n * WAD]);
    expect(stepArgs(plan, "redeem")).toEqual([MARKET_A.market, [0n], [3n * WAD]]);
    expect(response.json().details.expectedSdai).toBe((3n * WAD).toString());
  });

  it("an Invalid resolution pays only the INVALID token; nothing held is refused", async () => {
    resolve(claimB.conditionId, [0n, 0n, 1n]);
    h.chain.setBalance(MARKET_B.yesToken, ALICE.wallet, 3n * WAD);
    expect((await postPlan(h, REDEEM, { market: MARKET_B.market })).statusCode).toBe(422);
    h.chain.setBalance(MARKET_B.invalidToken, ALICE.wallet, WAD);
    const plan = decodeAndVerify(h, (await postPlan(h, REDEEM, { market: MARKET_B.market }, { key: freshKey() })).json().plan, claimB);
    expect(stepArgs(plan, "redeem")).toEqual([MARKET_B.market, [2n], [WAD]]);
    expect(plan.steps[0]?.to).toBe(MARKET_B.invalidToken);
  });
});

describe("exit plans: per-kind expiry, readiness and compliance (PRD-04 section 1)", () => {
  const routes = [
    ["withdraw", "/api/v1/funding/plans/withdraw", { market: MARKET_A.market, tokenId: "42" }],
    ["merge", "/api/v1/funding/plans/merge", { market: MARKET_A.market, amount: WAD.toString() }],
    ["redeem", "/api/v1/funding/plans/redeem", { market: MARKET_A.market }],
  ] as const;

  async function planCount(): Promise<number> {
    const rows = await h.ctx.database.sql.query<{ count: string }>("SELECT count(*)::text AS count FROM funding_plans");
    return Number(rows[0]?.count ?? "0");
  }

  beforeEach(async () => {
    h.ctx.readModel.setHalted(false);
    h.chain.addPool(POOL, { token0: MARKET_A.yesToken, token1: SDAI, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, fee: 100, liquidity: 10n ** 20n, tickSpacing: 60, cooldown: 0 });
    h.chain.positions.set(42n, { owner: ALICE.wallet, token0: MARKET_A.yesToken, token1: SDAI, tickLower: -600, tickUpper: 600, liquidity: 10n ** 20n, tokensOwed0: 0n, tokensOwed1: 0n });
    for (const token of [MARKET_A.yesToken, MARKET_A.noToken, MARKET_A.invalidToken]) h.chain.setBalance(token, ALICE.wallet, 5n * WAD);
    if (!(await h.ctx.readModel.getConditionResolution(claimA.conditionId))) resolve(claimA.conditionId, [1n, 0n, 0n]);
  });

  it("expires_at = created + 20 min for withdraw and created + 1 h for merge and redeem", async () => {
    const lifetimes: Record<string, number> = { withdraw: 20 * 60, merge: 3_600, redeem: 3_600 };
    for (const [kind, path, body] of routes) {
      const response = await postPlan(h, path, body);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().kind).toBe(kind);
      expect(new Date(response.json().expiresAt).getTime() - START.getTime(), kind).toBe((lifetimes[kind] ?? 0) * 1000);
    }
  });

  for (const [kind, path, body] of routes) {
    it(`SEC-IDX-07 ${kind}: NOT_READY when the read model is halted or stale; no plan is stored`, async () => {
      const before = await planCount();
      h.ctx.readModel.setHalted(true);
      const halted = await postPlan(h, path, body);
      expect(halted.statusCode).toBe(503);
      expect(halted.json().error.code).toBe("NOT_READY");
      h.ctx.readModel.setHalted(false);
      h.ctx.clock.advance((h.ctx.config.maxIndexerLagSeconds + 60) * 1000);
      expect((await postPlan(h, path, body)).json().error.code).toBe("NOT_READY");
      expect(await planCount()).toBe(before);
    });

    it(`SEC-LEGAL-01 ${kind}: compliance is asked for "redeem" and a refusal returns no plan`, async () => {
      const before = await planCount();
      h.ctx.compliance.blockedActions.add("redeem");
      expect((await postPlan(h, path, body)).statusCode).toBe(451);
      expect(h.ctx.compliance.calls.at(-1)?.action).toBe("redeem");
      expect(await planCount()).toBe(before);
    });
  }
});

describe("malformed integer fields are 400, never 500 (zod 4 runs refinements after a failed regex)", () => {
  const MALFORMED = ["abc", "1.5", "-1", "", `1${"0".repeat(78)}`];
  const cases = [
    ["merge amount", "/api/v1/funding/plans/merge", (value: string) => ({ market: MARKET_A.market, amount: value })],
    ["withdraw tokenId", "/api/v1/funding/plans/withdraw", (value: string) => ({ market: MARKET_A.market, tokenId: value })],
  ] as const;

  for (const [name, path, bodyOf] of cases) {
    it(`${name}: "abc", "1.5", "-1", "" and 79 digits are VALIDATION_FAILED with or without a session; no plan is stored`, async () => {
      const before = Number((await h.ctx.database.sql.query<{ count: string }>("SELECT count(*)::text AS count FROM funding_plans"))[0]?.count ?? "0");
      for (const value of MALFORMED) {
        const signedIn = await postPlan(h, path, bodyOf(value));
        expect(signedIn.statusCode, value).toBe(400);
        expect(signedIn.json().error.code, value).toBe("VALIDATION_FAILED");
        const anonymous = await h.app.inject({ method: "POST", url: path, headers: { "content-type": "application/json", "idempotency-key": freshKey() }, payload: JSON.stringify(bodyOf(value)) });
        expect(anonymous.statusCode, value).toBe(400);
      }
      const after = Number((await h.ctx.database.sql.query<{ count: string }>("SELECT count(*)::text AS count FROM funding_plans"))[0]?.count ?? "0");
      expect(after).toBe(before);
    });
  }
});
