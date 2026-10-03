// Fixed-point price, tick and amount math for the funding lane (docs/research/liquidity-amm.md sections 2, 3 and 7).
// Every amount is a bigint. Floating point is used in exactly one place: a first guess of a tick from a price
// (Math.log), which is then corrected and verified with integer comparisons against TickMath, so the chosen ticks are
// exact. Prices are rationals (num/den) or 18-decimal fixed point ("wad").

export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;
export const WAD = 10n ** 18n;
export const BPS = 10_000n;
export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;
export const MIN_SQRT_RATIO = 4_295_128_739n;
export const MAX_SQRT_RATIO = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;
const UINT256_MAX = (1n << 256n) - 1n;

/** Algebra / Uniswap v3 TickMath.getSqrtRatioAtTick, bit for bit (Q64.96, rounded up). */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new RangeError("tick out of range");
  const absTick = BigInt(Math.abs(tick));
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const factors: readonly [bigint, bigint][] = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, factor] of factors) if ((absTick & bit) !== 0n) ratio = (ratio * factor) >> 128n;
  if (tick > 0) ratio = UINT256_MAX / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** A positive rational number num/den. */
export interface Ratio {
  num: bigint;
  den: bigint;
}

export const ratio = (num: bigint, den: bigint): Ratio => {
  if (num <= 0n || den <= 0n) throw new RangeError("ratio must be positive");
  return { num, den };
};

export const invert = (value: Ratio): Ratio => ({ num: value.den, den: value.num });

/** Pool price at a tick (token1 per token0, raw units) is sqrt^2 / 2^192; compares it with a rational exactly. */
const priceAtLeast = (tick: number, target: Ratio): boolean => {
  const sqrt = getSqrtRatioAtTick(tick);
  return sqrt * sqrt * target.den >= target.num * Q192;
};
const priceAtMost = (tick: number, target: Ratio): boolean => {
  const sqrt = getSqrtRatioAtTick(tick);
  return sqrt * sqrt * target.den <= target.num * Q192;
};

function estimateTick(target: Ratio): number {
  const guess = Math.log(Number(target.num) / Number(target.den)) / Math.log(1.0001);
  if (!Number.isFinite(guess)) throw new RangeError("price out of range");
  return Math.min(MAX_TICK, Math.max(MIN_TICK, Math.round(guess)));
}

const MAX_CORRECTION_STEPS = 64;

/** Smallest tick whose TickMath price is >= target (integer-verified). */
export function ceilTick(target: Ratio): number {
  let tick = estimateTick(target);
  for (let step = 0; step < MAX_CORRECTION_STEPS && tick > MIN_TICK && priceAtLeast(tick - 1, target); step += 1) tick -= 1;
  for (let step = 0; step < MAX_CORRECTION_STEPS && !priceAtLeast(tick, target); step += 1) {
    if (tick >= MAX_TICK) throw new RangeError("price above the largest tick");
    tick += 1;
  }
  if (!priceAtLeast(tick, target) || (tick > MIN_TICK && priceAtLeast(tick - 1, target))) throw new RangeError("tick search did not converge");
  return tick;
}

/** Largest tick whose TickMath price is <= target (integer-verified). */
export function floorTick(target: Ratio): number {
  let tick = estimateTick(target);
  for (let step = 0; step < MAX_CORRECTION_STEPS && tick < MAX_TICK && priceAtMost(tick + 1, target); step += 1) tick += 1;
  for (let step = 0; step < MAX_CORRECTION_STEPS && !priceAtMost(tick, target); step += 1) {
    if (tick <= MIN_TICK) throw new RangeError("price below the smallest tick");
    tick -= 1;
  }
  if (!priceAtMost(tick, target) || (tick < MAX_TICK && priceAtMost(tick + 1, target))) throw new RangeError("tick search did not converge");
  return tick;
}

const floorDiv = (a: number, b: number): number => Math.floor(a / b);
/** Smallest multiple of spacing >= tick. */
export const alignUp = (tick: number, spacing: number): number => -floorDiv(-tick, spacing) * spacing + 0;
/** Largest multiple of spacing <= tick. */
export const alignDown = (tick: number, spacing: number): number => floorDiv(tick, spacing) * spacing + 0;

export class RangeCollapsedError extends Error {
  constructor() {
    super("the price range is narrower than one tick spacing");
    this.name = "RangeCollapsedError";
  }
}

export interface LadderRange {
  tickLower: number;
  tickUpper: number;
  sqrtPriceLowerX96: bigint;
  sqrtPriceUpperX96: bigint;
  /** Initial pool price strictly outside the range on the YES-cheaper side (single-sided YES mint). */
  initialSqrtPriceX96: bigint;
  /** YES price (sDAI per YES) at the final ticks, wad, rounded toward the inside of the requested range. */
  finalLowerPriceWad: bigint;
  finalUpperPriceWad: bigint;
}

/**
 * The YES sell ladder over [lower, upper] (sDAI per YES, wad). YES = token0: pool price is sDAI per YES, range
 * [ceilTick(lower), floorTick(upper)]; YES = token1: pool price is YES per sDAI, range [ceilTick(1/upper),
 * floorTick(1/lower)]. Ticks are aligned inward to the spacing, so the range never exceeds the requested prices.
 */
export function ladderRange(input: { yesIsToken0: boolean; lowerPriceWad: bigint; upperPriceWad: bigint; tickSpacing: number }): LadderRange {
  const { yesIsToken0, lowerPriceWad, upperPriceWad, tickSpacing } = input;
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0 || tickSpacing > 16_384) throw new RangeError("invalid tick spacing");
  if (!(lowerPriceWad > 0n && lowerPriceWad < upperPriceWad)) throw new RangeError("lower price must be positive and below the upper price");
  const lower = ratio(lowerPriceWad, WAD);
  const upper = ratio(upperPriceWad, WAD);
  // Bounds in pool-price terms (token1 per token0).
  const poolLow = yesIsToken0 ? lower : invert(upper);
  const poolHigh = yesIsToken0 ? upper : invert(lower);
  const tickLower = alignUp(ceilTick(poolLow), tickSpacing);
  const tickUpper = alignDown(floorTick(poolHigh), tickSpacing);
  if (tickLower >= tickUpper) throw new RangeCollapsedError();
  if (tickLower < MIN_TICK || tickUpper > MAX_TICK) throw new RangeError("range outside the tick bounds");
  // Integer verification of the inward rounding (never trust the float estimate).
  if (!priceAtLeast(tickLower, poolLow) || !priceAtMost(tickUpper, poolHigh)) throw new Error("tick range exceeds the requested prices");
  const sqrtPriceLowerX96 = getSqrtRatioAtTick(tickLower);
  const sqrtPriceUpperX96 = getSqrtRatioAtTick(tickUpper);
  const initialSqrtPriceX96 = yesIsToken0 ? sqrtPriceLowerX96 - 1n : sqrtPriceUpperX96 + 1n;
  const finalLowerPriceWad = yesIsToken0 ? ceilDiv(sqrtPriceLowerX96 * sqrtPriceLowerX96 * WAD, Q192) : ceilDiv(Q192 * WAD, sqrtPriceUpperX96 * sqrtPriceUpperX96);
  const finalUpperPriceWad = yesIsToken0 ? (sqrtPriceUpperX96 * sqrtPriceUpperX96 * WAD) / Q192 : (Q192 * WAD) / (sqrtPriceLowerX96 * sqrtPriceLowerX96);
  return { tickLower, tickUpper, sqrtPriceLowerX96, sqrtPriceUpperX96, initialSqrtPriceX96, finalLowerPriceWad, finalUpperPriceWad };
}

/**
 * Whether a pool at (tick, sqrtPrice) makes a mint over [tickLower, tickUpper] YES-only. Algebra decides by the
 * current tick: below the range the position is token0 only, at or above tickUpper token1 only.
 */
export function isYesOnlySide(input: { yesIsToken0: boolean; currentTick: number; sqrtPriceX96: bigint; range: Pick<LadderRange, "tickLower" | "tickUpper" | "sqrtPriceLowerX96" | "sqrtPriceUpperX96"> }): boolean {
  const { yesIsToken0, currentTick, sqrtPriceX96, range } = input;
  if (yesIsToken0) return currentTick < range.tickLower && sqrtPriceX96 < range.sqrtPriceLowerX96;
  return currentTick >= range.tickUpper && sqrtPriceX96 >= range.sqrtPriceUpperX96;
}

/** Price of the outcome token in collateral (wad) from a pool's sqrt price; null for an uninitialised pool. */
export function outcomePriceWad(sqrtPriceX96: bigint, outcomeIsToken0: boolean): bigint | null {
  if (sqrtPriceX96 <= 0n) return null;
  const squared = sqrtPriceX96 * sqrtPriceX96;
  return outcomeIsToken0 ? (squared * WAD) / Q192 : (Q192 * WAD) / squared;
}

export const ceilDiv = (a: bigint, b: bigint): bigint => {
  if (b <= 0n || a < 0n) throw new RangeError("ceilDiv expects a >= 0 and b > 0");
  return a === 0n ? 0n : (a - 1n) / b + 1n;
};

/** S = shares - ceil(shares * 10 / 10000): the 10 bps interest-accrual margin (decisions; PRD-04 3.2 step 2). */
export const SHARE_MARGIN_BPS = 10n;
export const sharesAfterMargin = (shares: bigint): bigint => shares - ceilDiv(shares * SHARE_MARGIN_BPS, BPS);

/** Mint and withdraw minimums: amount - amount * 50 / 10000 (50 bps slippage). */
export const SLIPPAGE_BPS = 50n;
export const minusSlippage = (amount: bigint): bigint => amount - (amount * SLIPPAGE_BPS) / BPS;

/**
 * Maximum loss if YES resolves, S * (1 - sqrt(p_a * p_b)) with p_a, p_b the YES prices of the final ticks, in sDAI
 * base units. The proceeds term is rounded down, so the reported loss is never understated.
 */
export function maxLossIfYes(input: { sets: bigint; yesIsToken0: boolean; sqrtPriceLowerX96: bigint; sqrtPriceUpperX96: bigint }): bigint {
  const { sets, yesIsToken0, sqrtPriceLowerX96: a, sqrtPriceUpperX96: b } = input;
  // YES = token0: p_a * p_b = (a^2 b^2) / 2^384, sqrt = a b / 2^192. YES = token1: prices invert, sqrt = 2^192 / (a b).
  const proceeds = yesIsToken0 ? (sets * a * b) / Q192 : (sets * Q192) / (a * b);
  return proceeds >= sets ? 0n : sets - proceeds;
}

/** Converts sDAI shares to xDAI with a convertToAssets(1e18) rate, rounding up (losses are never understated). */
export const sharesToAssetsCeil = (shares: bigint, assetsPerShareWad: bigint): bigint => ceilDiv(shares * assetsPerShareWad, WAD);
export const sharesToAssetsFloor = (shares: bigint, assetsPerShareWad: bigint): bigint => (shares * assetsPerShareWad) / WAD;

// LiquidityAmounts (rounding down, as burn pays out).
export function amount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [low, high] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  return ((liquidity << 96n) * (high - low)) / high / low;
}

export function amount1ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [low, high] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  return (liquidity * (high - low)) / Q96;
}

/** Token amounts a position's liquidity is worth at the current price, decided by the current tick as Algebra does. */
export function amountsForLiquidity(input: { currentTick: number; sqrtPriceX96: bigint; tickLower: number; tickUpper: number; liquidity: bigint }): { amount0: bigint; amount1: bigint } {
  const sqrtA = getSqrtRatioAtTick(input.tickLower);
  const sqrtB = getSqrtRatioAtTick(input.tickUpper);
  if (input.currentTick < input.tickLower) return { amount0: amount0ForLiquidity(sqrtA, sqrtB, input.liquidity), amount1: 0n };
  if (input.currentTick < input.tickUpper) {
    const price = input.sqrtPriceX96 < sqrtA ? sqrtA : input.sqrtPriceX96 > sqrtB ? sqrtB : input.sqrtPriceX96;
    return { amount0: amount0ForLiquidity(price, sqrtB, input.liquidity), amount1: amount1ForLiquidity(sqrtA, price, input.liquidity) };
  }
  return { amount0: 0n, amount1: amount1ForLiquidity(sqrtA, sqrtB, input.liquidity) };
}

// Decimal strings at the API edge.
const DECIMAL = /^(0|[1-9][0-9]{0,40})(?:\.([0-9]{1,18}))?$/;

/** Parses a non-negative decimal string with at most 18 fractional digits into wad; null when malformed. */
export function parseDecimalWad(text: string): bigint | null {
  const match = DECIMAL.exec(text);
  if (!match) return null;
  const whole = BigInt(match[1] ?? "0");
  const fraction = (match[2] ?? "").padEnd(18, "0");
  return whole * WAD + BigInt(fraction);
}

/** Formats wad as a decimal string without trailing zeros. */
export function formatWad(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / WAD;
  const fraction = (abs % WAD).toString().padStart(18, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
