import { releaseSuiteLock } from "./test/lock.js";
import { afterAll, describe, expect, it } from "vitest";
import {
  alignDown,
  alignUp,
  amountsForLiquidity,
  ceilTick,
  floorTick,
  formatWad,
  getSqrtRatioAtTick,
  isYesOnlySide,
  ladderRange,
  MAX_SQRT_RATIO,
  MAX_TICK,
  maxLossIfYes,
  MIN_SQRT_RATIO,
  MIN_TICK,
  minusSlippage,
  outcomePriceWad,
  parseDecimalWad,
  Q192,
  ratio,
  RangeCollapsedError,
  sharesAfterMargin,
  WAD,
} from "./math.js";

afterAll(releaseSuiteLock);

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const price = (tick: number) => getSqrtRatioAtTick(tick) ** 2n; // x 2^192
/** YES price (wad-scaled rational num/den) at a pool tick for an orientation, compared exactly via cross-multiplication. */
const yesPriceAtLeast = (tick: number, yesIsToken0: boolean, wad: bigint): boolean =>
  yesIsToken0 ? price(tick) * WAD >= wad * Q192 : Q192 * WAD >= wad * price(tick);
const yesPriceAtMost = (tick: number, yesIsToken0: boolean, wad: bigint): boolean =>
  yesIsToken0 ? price(tick) * WAD <= wad * Q192 : Q192 * WAD <= wad * price(tick);

describe("TickMath", () => {
  it("matches the canonical boundary values", () => {
    expect(getSqrtRatioAtTick(0)).toBe(1n << 96n);
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(MIN_SQRT_RATIO);
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(MAX_SQRT_RATIO);
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow(RangeError);
    expect(() => getSqrtRatioAtTick(0.5)).toThrow(RangeError);
  });

  it("agrees with 1.0001^(tick/2) for every bit of the tick", () => {
    const random = prng(7);
    const ticks = [...Array.from({ length: 20 }, (_, bit) => 1 << bit).flatMap((tick) => [tick, -tick]), ...Array.from({ length: 300 }, () => Math.round((random() * 2 - 1) * 800_000))];
    for (const tick of ticks.filter((value) => Math.abs(value) <= MAX_TICK)) {
      const expected = Math.pow(1.0001, tick / 2);
      const actual = Number(getSqrtRatioAtTick(tick)) / 2 ** 96;
      expect(Math.abs(actual / expected - 1)).toBeLessThan(1e-10);
    }
  });

  it("is strictly increasing", () => {
    for (let tick = -1_000; tick < 1_000; tick += 7) expect(getSqrtRatioAtTick(tick + 1)).toBeGreaterThan(getSqrtRatioAtTick(tick));
  });
});

describe("tick selection", () => {
  it("ceilTick/floorTick are exact for 0.5 (ln 0.5 / ln 1.0001 = -6931.8)", () => {
    expect(ceilTick(ratio(1n, 2n))).toBe(-6931);
    expect(floorTick(ratio(1n, 2n))).toBe(-6932);
    expect(ceilTick(ratio(1n, 1n))).toBe(0);
    expect(floorTick(ratio(1n, 1n))).toBe(0);
  });

  it("property: ceilTick is the smallest tick at or above the price and floorTick the largest at or below", () => {
    const random = prng(11);
    for (let index = 0; index < 300; index += 1) {
      const wad = BigInt(Math.floor(random() * 99 * 1e15) + 1e15) * 10n ** 3n; // 0.001 .. 100
      const target = ratio(wad, WAD);
      const up = ceilTick(target);
      const down = floorTick(target);
      expect(price(up) * WAD >= wad * Q192).toBe(true);
      expect(price(up - 1) * WAD < wad * Q192).toBe(true);
      expect(price(down) * WAD <= wad * Q192).toBe(true);
      expect(price(down + 1) * WAD > wad * Q192).toBe(true);
    }
  });

  it("aligns inward for negative and positive ticks", () => {
    expect(alignUp(-6931, 60)).toBe(-6900);
    expect(alignDown(-6931, 60)).toBe(-6960);
    expect(alignUp(513, 60)).toBe(540);
    expect(alignDown(16095, 60)).toBe(16080);
    expect(Object.is(alignUp(-1, 60), 0)).toBe(true);
  });
});

describe("ladder range (PRD-04 3.2 step 3)", () => {
  it("YES = token0: [ceilTick(lower), floorTick(upper)] aligned inward (hand-computed for 0.20..0.95)", () => {
    const range = ladderRange({ yesIsToken0: true, lowerPriceWad: 2n * 10n ** 17n, upperPriceWad: 95n * 10n ** 16n, tickSpacing: 60 });
    // ln(0.2)/ln(1.0001) = -16095.18 -> ceil -16095 -> aligned up -16080; ln(0.95)/ln(1.0001) = -512.96 -> floor -513 -> aligned down -540.
    expect([range.tickLower, range.tickUpper]).toEqual([-16_080, -540]);
    expect(range.initialSqrtPriceX96).toBe(getSqrtRatioAtTick(-16_080) - 1n);
    // 1.0001^-16080 = 0.200303892057..., 1.0001^-540 = 0.947434664401... (bc -l)
    expect(formatWad(range.finalLowerPriceWad).slice(0, 14)).toBe("0.200303892057");
    expect(formatWad(range.finalUpperPriceWad).slice(0, 14)).toBe("0.947434664401");
  });

  it("YES = token1: [ceilTick(1/upper), floorTick(1/lower)] aligned inward (hand-computed for 0.20..0.95)", () => {
    const range = ladderRange({ yesIsToken0: false, lowerPriceWad: 2n * 10n ** 17n, upperPriceWad: 95n * 10n ** 16n, tickSpacing: 60 });
    // ln(1/0.95)/ln(1.0001) = 512.96 -> ceil 513 -> aligned up 540; ln(5)/ln(1.0001) = 16095.18 -> floor 16095 -> aligned down 16080.
    expect([range.tickLower, range.tickUpper]).toEqual([540, 16_080]);
    expect(range.initialSqrtPriceX96).toBe(getSqrtRatioAtTick(16_080) + 1n);
    expect(formatWad(range.finalLowerPriceWad).slice(0, 14)).toBe("0.200303892057");
    expect(formatWad(range.finalUpperPriceWad).slice(0, 14)).toBe("0.947434664401");
  });

  for (const yesIsToken0 of [true, false]) {
    it(`property (YES = token${yesIsToken0 ? 0 : 1}): the range never exceeds the requested prices and the initial price makes the mint YES-only`, () => {
      const random = prng(yesIsToken0 ? 21 : 22);
      let checked = 0;
      for (let index = 0; index < 400; index += 1) {
        const a = BigInt(Math.floor(random() * 94 * 1e6) + 1e6) * 10n ** 10n; // 0.01 .. 0.95
        const b = BigInt(Math.floor(random() * 94 * 1e6) + 1e6) * 10n ** 10n;
        if (a === b) continue;
        const [lowerPriceWad, upperPriceWad] = a < b ? [a, b] : [b, a];
        const tickSpacing = [1, 10, 60, 200][index % 4] ?? 60;
        let range;
        try {
          range = ladderRange({ yesIsToken0, lowerPriceWad, upperPriceWad, tickSpacing });
        } catch (error) {
          expect(error).toBeInstanceOf(RangeCollapsedError);
          continue;
        }
        checked += 1;
        expect(Math.abs(range.tickLower % tickSpacing)).toBe(0);
        expect(Math.abs(range.tickUpper % tickSpacing)).toBe(0);
        expect(range.tickLower).toBeLessThan(range.tickUpper);
        // YES prices of the final ticks lie inside [lower, upper].
        const [cheapTick, dearTick] = yesIsToken0 ? [range.tickLower, range.tickUpper] : [range.tickUpper, range.tickLower];
        expect(yesPriceAtLeast(cheapTick, yesIsToken0, lowerPriceWad)).toBe(true);
        expect(yesPriceAtMost(dearTick, yesIsToken0, upperPriceWad)).toBe(true);
        expect(range.finalLowerPriceWad).toBeGreaterThanOrEqual(lowerPriceWad);
        expect(range.finalUpperPriceWad).toBeLessThanOrEqual(upperPriceWad);
        // Single-sidedness: the initial price is strictly outside the range on the YES-cheaper side.
        if (yesIsToken0) expect(range.initialSqrtPriceX96).toBeLessThan(range.sqrtPriceLowerX96);
        else expect(range.initialSqrtPriceX96).toBeGreaterThan(range.sqrtPriceUpperX96);
        const initialTick = yesIsToken0 ? range.tickLower - 1 : range.tickUpper;
        expect(isYesOnlySide({ yesIsToken0, currentTick: initialTick, sqrtPriceX96: range.initialSqrtPriceX96, range })).toBe(true);
        // ...and the YES price there is cheaper than the ladder's lowest offer.
        const initialYesPrice = outcomePriceWad(range.initialSqrtPriceX96, yesIsToken0);
        expect(initialYesPrice).not.toBeNull();
        expect((initialYesPrice ?? range.finalLowerPriceWad + 1n) <= range.finalLowerPriceWad).toBe(true);
      }
      expect(checked).toBeGreaterThan(300);
    });
  }

  it("refuses a range narrower than one tick spacing (operator clarification 4)", () => {
    expect(() => ladderRange({ yesIsToken0: true, lowerPriceWad: 500_000_000_000_000_000n, upperPriceWad: 501_000_000_000_000_000n, tickSpacing: 60 })).toThrow(RangeCollapsedError);
    expect(() => ladderRange({ yesIsToken0: false, lowerPriceWad: 500_000_000_000_000_000n, upperPriceWad: 501_000_000_000_000_000n, tickSpacing: 60 })).toThrow(RangeCollapsedError);
  });

  it("isYesOnlySide rejects a pool priced at or inside the range", () => {
    const range = ladderRange({ yesIsToken0: true, lowerPriceWad: 5n * 10n ** 17n, upperPriceWad: 98n * 10n ** 16n, tickSpacing: 60 });
    expect(isYesOnlySide({ yesIsToken0: true, currentTick: range.tickLower, sqrtPriceX96: range.sqrtPriceLowerX96, range })).toBe(false);
    expect(isYesOnlySide({ yesIsToken0: true, currentTick: range.tickLower - 1, sqrtPriceX96: range.sqrtPriceLowerX96 - 1n, range })).toBe(true);
    const flipped = ladderRange({ yesIsToken0: false, lowerPriceWad: 5n * 10n ** 17n, upperPriceWad: 98n * 10n ** 16n, tickSpacing: 60 });
    expect(isYesOnlySide({ yesIsToken0: false, currentTick: flipped.tickUpper - 1, sqrtPriceX96: flipped.sqrtPriceUpperX96 - 1n, range: flipped })).toBe(false);
    expect(isYesOnlySide({ yesIsToken0: false, currentTick: flipped.tickUpper, sqrtPriceX96: flipped.sqrtPriceUpperX96, range: flipped })).toBe(true);
  });
});

describe("share margin and slippage (PRD-04 3.2 steps 2 and 5)", () => {
  it("S = shares - ceil(shares x 10 / 10000)", () => {
    expect(sharesAfterMargin(80n * WAD)).toBe(79_920_000_000_000_000_000n);
    expect(sharesAfterMargin(1_001n)).toBe(1_001n - 2n); // ceil(1.001) = 2
    expect(sharesAfterMargin(1_000n)).toBe(999n);
    expect(sharesAfterMargin(1n)).toBe(0n);
    expect(sharesAfterMargin(0n)).toBe(0n);
  });

  it("mint minimum = S - S x 50 / 10000", () => {
    expect(minusSlippage(79_920_000_000_000_000_000n)).toBe(79_520_400_000_000_000_000n);
    expect(minusSlippage(10_000n)).toBe(9_950n);
    expect(minusSlippage(199n)).toBe(199n);
  });
});

describe("maximum loss if YES resolves (PRD-04 3.2 step 6)", () => {
  const sets = 79_920_000_000_000_000_000n;
  // Hand-computed with bc -l (scale=60): S x (1 - 1.0001^((tickLower + tickUpper) / 2)) over the final ticks.
  const cases = [
    { lower: 5n * 10n ** 17n, upper: 98n * 10n ** 16n, ticks: [-6_900, -240], expected: 23_993_183_762_836_505_250n },
    { lower: 2n * 10n ** 17n, upper: 95n * 10n ** 16n, ticks: [-16_080, -540], expected: 45_104_326_212_657_766_192n },
  ];
  for (const item of cases) {
    for (const yesIsToken0 of [true, false]) {
      it(`matches the hand-computed value for [${formatWad(item.lower)}, ${formatWad(item.upper)}] with YES = token${yesIsToken0 ? 0 : 1}`, () => {
        const range = ladderRange({ yesIsToken0, lowerPriceWad: item.lower, upperPriceWad: item.upper, tickSpacing: 60 });
        expect(yesIsToken0 ? [range.tickLower, range.tickUpper] : [-range.tickUpper, -range.tickLower]).toEqual(item.ticks);
        const loss = maxLossIfYes({ sets, yesIsToken0, sqrtPriceLowerX96: range.sqrtPriceLowerX96, sqrtPriceUpperX96: range.sqrtPriceUpperX96 });
        // TickMath rounds sqrt prices up by < 1e-11 relative; the reported loss is rounded up, never understated.
        const difference = loss - item.expected;
        expect(difference < 0n ? -difference : difference).toBeLessThan(10n ** 9n);
      });
    }
  }

  it("is zero when the ladder sells at par and S at most for a near-zero price", () => {
    const one = getSqrtRatioAtTick(0);
    expect(maxLossIfYes({ sets, yesIsToken0: true, sqrtPriceLowerX96: one, sqrtPriceUpperX96: one })).toBe(0n);
    const tiny = getSqrtRatioAtTick(MIN_TICK);
    expect(maxLossIfYes({ sets, yesIsToken0: true, sqrtPriceLowerX96: tiny, sqrtPriceUpperX96: tiny })).toBe(sets);
  });
});

describe("prices and amounts", () => {
  it("outcome price from sqrtPriceX96 in both orders; null when uninitialised", () => {
    const half = getSqrtRatioAtTick(-6_932); // ~0.49999
    const asToken0 = outcomePriceWad(half, true);
    const asToken1 = outcomePriceWad(half, false);
    expect(asToken0).not.toBeNull();
    expect(Number(asToken0) / 1e18).toBeCloseTo(0.5, 3);
    expect(Number(asToken1) / 1e18).toBeCloseTo(2, 3);
    expect(outcomePriceWad(0n, true)).toBeNull();
  });

  it("amountsForLiquidity follows the current tick (below / inside / above the range)", () => {
    const base = { tickLower: -600, tickUpper: 600, liquidity: 10n ** 20n };
    const below = amountsForLiquidity({ ...base, currentTick: -700, sqrtPriceX96: getSqrtRatioAtTick(-700) });
    expect(below.amount1).toBe(0n);
    expect(below.amount0).toBeGreaterThan(0n);
    const above = amountsForLiquidity({ ...base, currentTick: 600, sqrtPriceX96: getSqrtRatioAtTick(600) });
    expect(above.amount0).toBe(0n);
    expect(above.amount1).toBeGreaterThan(0n);
    const inside = amountsForLiquidity({ ...base, currentTick: 0, sqrtPriceX96: getSqrtRatioAtTick(0) });
    expect(inside.amount0).toBeGreaterThan(0n);
    expect(inside.amount1).toBeGreaterThan(0n);
  });

  it("parses and formats decimal strings without floating point", () => {
    expect(parseDecimalWad("0.01")).toBe(10n ** 16n);
    expect(parseDecimalWad("0.950000000000000001")).toBe(950_000_000_000_000_001n);
    expect(parseDecimalWad("1e-2")).toBeNull();
    expect(parseDecimalWad("0.1234567890123456789")).toBeNull();
    expect(parseDecimalWad("-1")).toBeNull();
    expect(formatWad(1_259_870_628_000_000_000n)).toBe("1.259870628");
    expect(formatWad(0n)).toBe("0");
  });
});
