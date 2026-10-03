import { releaseSuiteLock } from "./test/lock.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Address } from "@pine/shared/types";
import { depthQuote, priceImpactBps } from "./liquidity.js";
import { createHarness, MARKET_A, MARKET_B, refreshIndexer, SDAI, seedClaim, WAD, type Harness } from "./test/harness.js";

afterAll(releaseSuiteLock);

const POOL_YES: Address = "0x000000000000000000000000000000000000a001";
const POOL_NO: Address = "0x000000000000000000000000000000000000b002";
const START = new Date("2026-10-01T00:00:00.000Z");
let h: Harness;
let testIndex = 0;

const get = (market: string) => h.app.inject({ method: "GET", url: `/api/v1/markets/${market}/liquidity` });

beforeAll(async () => {
  h = await createHarness();
  seedClaim(h.ctx, { ...MARKET_A });
  seedClaim(h.ctx, { ...MARKET_B });
});

afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  // Each test starts a minute later than the previous one, so the 30 s cache never carries over between tests.
  testIndex += 1;
  h.ctx.clock.set(new Date(START.getTime() + testIndex * 60_000));
  refreshIndexer(h);
  h.chain.pools.clear();
  h.chain.poolStates.clear();
  h.chain.calls.length = 0;
  h.chain.failTransport = false;
  h.chain.quote = () => null;
});

describe("quoter depth parsing", () => {
  it("average price is sDAI in / outcome out (rounded up) and impact is relative to spot, in bps", () => {
    const quote = depthQuote(WAD, 8n * 10n ** 17n, { amountOut: 3n * WAD, fee: 3_488 }, 25n * 10n ** 16n);
    expect(quote).toEqual({ xdaiIn: WAD.toString(), sdaiIn: "800000000000000000", outcomeOut: "3000000000000000000", averagePriceSdai: "0.266666666666666667", priceImpactBps: 666, fee: 3_488, reason: null });
    expect(depthQuote(WAD, 1n, null, 1n).reason).toMatch(/no executable liquidity/);
    expect(depthQuote(WAD, 1n, { amountOut: 0n, fee: 100 }, 1n).outcomeOut).toBe("0");
    expect(priceImpactBps(WAD, WAD)).toBe(0);
    expect(priceImpactBps(WAD, 0n)).toBeNull();
  });
});

describe("GET /api/v1/markets/:market/liquidity (PRD-04 3.1)", () => {
  it("reports null pools with a reason when none exist", async () => {
    const response = await get(MARKET_A.market);
    expect(response.statusCode, response.body).toBe(200);
    const json = response.json();
    expect(json.outcomes.map((item: { outcome: string; pool: unknown; reason: string }) => [item.outcome, item.pool, item.reason])).toEqual([
      ["yes", null, "no pool exists for this outcome token and sDAI"],
      ["no", null, "no pool exists for this outcome token and sDAI"],
    ]);
    expect(json.sdaiToXdai).toBe("1.25");
    expect(json.priceLabel).toMatch(/Not a probability that the code is correct/);
  });

  it("reads globalState, liquidity, spot prices in sDAI and xDAI and quoter depth at one pinned block (YES = token0)", async () => {
    // sqrtPriceX96 = 2^95 -> price token1/token0 = 1/4: YES (token0) costs 0.25 sDAI.
    h.chain.addPool(POOL_YES, { token0: MARKET_A.yesToken, token1: SDAI, sqrtPriceX96: 1n << 95n, tick: -13_863, fee: 2_959, liquidity: 5n * WAD, tickSpacing: 60, cooldown: 0 });
    h.chain.addPool(POOL_NO, { token0: MARKET_A.noToken, token1: SDAI, sqrtPriceX96: 0n, tick: 0, fee: 100, liquidity: 0n, tickSpacing: 60, cooldown: 0 });
    h.chain.quote = (tokenIn, tokenOut, amountIn) => {
      if (tokenIn !== SDAI || tokenOut !== MARKET_A.yesToken) return null;
      if (amountIn > 10n * WAD) return null; // the 100 xDAI probe exhausts the pool
      return { amountOut: (amountIn * 30n) / 8n, fee: 3_488 };
    };
    const json = (await get(MARKET_A.market)).json();
    const [yes, no] = json.outcomes;
    expect(yes).toMatchObject({ pool: POOL_YES, sqrtPriceX96: (1n << 95n).toString(), tick: -13_863, fee: 2_959, liquidity: (5n * WAD).toString(), priceSdai: "0.25", priceXdai: "0.3125", reason: null });
    expect(yes.depth.map((item: { xdaiIn: string }) => item.xdaiIn)).toEqual([WAD, 10n * WAD, 100n * WAD].map(String));
    expect(yes.depth[0]).toMatchObject({ sdaiIn: "800000000000000000", outcomeOut: "3000000000000000000", averagePriceSdai: "0.266666666666666667", priceImpactBps: 666, fee: 3_488 });
    expect(yes.depth[2]).toMatchObject({ outcomeOut: null, averagePriceSdai: null, reason: "no executable liquidity for this size" });
    expect(no).toMatchObject({ pool: POOL_NO, reason: "the pool exists but is not initialised", priceSdai: null, depth: [] });
    expect(json.block).toBe("5000");
    expect(new Set(h.chain.calls.map((call) => call.block))).toEqual(new Set(["0x1388"]));
  });

  it("inverts the price when the outcome is token1", async () => {
    // NO of market B sorts above sDAI: pool price = NO per sDAI = 4 at sqrt 2^97, so NO costs 0.25 sDAI.
    h.chain.addPool(POOL_NO, { token0: SDAI, token1: MARKET_B.noToken, sqrtPriceX96: 1n << 97n, tick: 13_862, fee: 100, liquidity: WAD, tickSpacing: 60, cooldown: 0 });
    const json = (await get(MARKET_B.market)).json();
    expect(json.outcomes[1]).toMatchObject({ outcome: "no", priceSdai: "0.25", priceXdai: "0.3125" });
    expect(json.outcomes[1].depth.every((item: { reason: string | null }) => item.reason !== null)).toBe(true);
  });

  it("caches per market for 30 s (no chain reads inside the window)", async () => {
    const first = await get(MARKET_B.market);
    const reads = h.chain.rpcCount;
    h.ctx.clock.advance(29_000);
    const cached = await get(MARKET_B.market);
    expect(cached.json()).toEqual(first.json());
    expect(h.chain.rpcCount).toBe(reads);
    expect(cached.headers["cache-control"]).toBe("public, max-age=30");
    h.ctx.clock.advance(1_000);
    await get(MARKET_B.market);
    expect(h.chain.rpcCount).toBeGreaterThan(reads);
  });

  it("is public (no session needed) and unknown markets are NOT_FOUND", async () => {
    expect((await get("0x0000000000000000000000000000000000dead01")).statusCode).toBe(404);
    expect((await get("not-an-address")).statusCode).toBe(400);
  });

  it("RPC failures are UPSTREAM_UNAVAILABLE without leaking the RPC URL", async () => {
    h.ctx.clock.advance(60_000);
    h.chain.failTransport = true;
    h.logs.lines.length = 0;
    const response = await get(MARKET_A.market);
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toMatch(/secret-key|rpc\.example/);
    expect(h.logs.text()).toMatch(/UPSTREAM_UNAVAILABLE/);
    expect(h.logs.text()).not.toMatch(/secret-key|rpc\.example|ECONNREFUSED/);
  });
});
