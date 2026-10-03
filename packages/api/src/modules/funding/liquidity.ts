// Market liquidity state (PRD-04 3.1): YES and NO pools against sDAI, spot prices in sDAI and xDAI, and executable
// depth from the Algebra Quoter, all read at one pinned block. Public and cookie-free; cached per market for 30 s, and
// cache misses are capped by the route's own fan-out limiter (PRD-07 section 3).

import { z } from "zod";
import type { DeploymentManifest } from "@pine/shared/deployment";
import type { ClaimRecord } from "@pine/shared/read-model";
import type { Address } from "@pine/shared/types";
import type { AppContext } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { chainReader, type ChainReader } from "./chain.js";
import { addressSchema, FanOutLimiter, PRICE_LABEL, PUBLIC_ROUTE, requireClaim, TtlCache, XDAI, type ZodApp } from "./common.js";
import { formatWad, outcomePriceWad, sharesToAssetsFloor, WAD } from "./math.js";

/** Depth probes: buying 1, 10 and 100 xDAI worth of the outcome (PRD-04 3.1). */
export const DEPTH_PROBES_XDAI: readonly bigint[] = [1n * XDAI, 10n * XDAI, 100n * XDAI];
export const LIQUIDITY_CACHE_TTL_MS = 30_000;
const LIQUIDITY_CACHE_MAX_ENTRIES = 1_000;
/** Concurrent cache misses that may fan out to RPC (per process, this route only); the next one is refused with 429. */
export const LIQUIDITY_MAX_IN_FLIGHT = 4;
export const LIQUIDITY_RETRY_AFTER_SECONDS = 2;

export interface DepthQuote {
  xdaiIn: string;
  sdaiIn: string;
  outcomeOut: string | null;
  /** sDAI per outcome token paid on average, decimal. */
  averagePriceSdai: string | null;
  /** (average price / spot price - 1) in basis points, rounded down. */
  priceImpactBps: number | null;
  /** Fee the quoter applied, hundredths of a bip. */
  fee: number | null;
  reason: string | null;
}

export interface OutcomeLiquidity {
  outcome: "yes" | "no";
  token: Address;
  pool: Address | null;
  reason: string | null;
  sqrtPriceX96: string | null;
  tick: number | null;
  /** globalState().fee: hundredths of a bip; stale relative to the next swap's fee. */
  fee: number | null;
  liquidity: string | null;
  priceSdai: string | null;
  priceXdai: string | null;
  depth: DepthQuote[];
}

export interface LiquidityResponse {
  market: Address;
  block: string;
  collateralToken: Address;
  /** xDAI per sDAI (sDAI.convertToAssets(1e18)), decimal. */
  sdaiToXdai: string;
  priceLabel: string;
  outcomes: OutcomeLiquidity[];
  notes: string[];
}

/** Price impact of a quote: priceImpactBps = floor(avg * 10000 / spot) - 10000. */
export function priceImpactBps(averagePriceWad: bigint, spotPriceWad: bigint): number | null {
  if (spotPriceWad <= 0n) return null;
  return Number((averagePriceWad * 10_000n) / spotPriceWad - 10_000n);
}

/**
 * Parses one quoter probe: sDAI in, outcome out. Average price = sdaiIn / outcomeOut (wad, rounded up: never
 * understates what a buyer pays).
 */
export function depthQuote(xdaiIn: bigint, sdaiIn: bigint, quote: { amountOut: bigint; fee: number } | null, spotPriceWad: bigint | null): DepthQuote {
  if (quote === null || quote.amountOut === 0n) {
    return { xdaiIn: xdaiIn.toString(), sdaiIn: sdaiIn.toString(), outcomeOut: quote ? "0" : null, averagePriceSdai: null, priceImpactBps: null, fee: quote?.fee ?? null, reason: "no executable liquidity for this size" };
  }
  const average = (sdaiIn * WAD + quote.amountOut - 1n) / quote.amountOut;
  return {
    xdaiIn: xdaiIn.toString(),
    sdaiIn: sdaiIn.toString(),
    outcomeOut: quote.amountOut.toString(),
    averagePriceSdai: formatWad(average),
    priceImpactBps: spotPriceWad === null ? null : priceImpactBps(average, spotPriceWad),
    fee: quote.fee,
    reason: null,
  };
}

async function outcomeLiquidity(reader: ChainReader, manifest: DeploymentManifest, outcome: "yes" | "no", token: Address, assetsPerShare: bigint): Promise<OutcomeLiquidity> {
  const collateral = manifest.seer.collateralToken;
  const empty = { sqrtPriceX96: null, tick: null, fee: null, liquidity: null, priceSdai: null, priceXdai: null };
  const pool = await reader.poolByPair(token, collateral);
  if (pool === null) return { outcome, token, pool: null, reason: "no pool exists for this outcome token and sDAI", ...empty, depth: [] };
  const [state, liquidity] = await Promise.all([reader.globalState(pool), reader.poolLiquidity(pool)]);
  const outcomeIsToken0 = token.toLowerCase() < collateral.toLowerCase();
  const spot = outcomePriceWad(state.sqrtPriceX96, outcomeIsToken0);
  const base = { outcome, token, pool, sqrtPriceX96: state.sqrtPriceX96.toString(), tick: state.tick, fee: state.fee, liquidity: liquidity.toString() };
  if (spot === null) return { ...base, reason: "the pool exists but is not initialised", priceSdai: null, priceXdai: null, depth: [] };
  const depth: DepthQuote[] = [];
  for (const xdaiIn of DEPTH_PROBES_XDAI) {
    const sdaiIn = (xdaiIn * WAD) / assetsPerShare;
    depth.push(depthQuote(xdaiIn, sdaiIn, sdaiIn > 0n ? await reader.quoteExactInputSingle(collateral, token, sdaiIn) : null, spot));
  }
  return { ...base, reason: null, priceSdai: formatWad(spot), priceXdai: formatWad(sharesToAssetsFloor(spot, assetsPerShare)), depth };
}

export async function readLiquidity(ctx: AppContext, manifest: DeploymentManifest, claim: ClaimRecord): Promise<LiquidityResponse> {
  const reader = await chainReader(ctx, manifest);
  const assetsPerShare = await reader.convertToAssets(WAD);
  if (assetsPerShare <= 0n) throw new ApiError("UPSTREAM_UNAVAILABLE", "Chain data could not be read; try again shortly");
  const yes = await outcomeLiquidity(reader, manifest, "yes", claim.yesToken, assetsPerShare);
  const no = await outcomeLiquidity(reader, manifest, "no", claim.noToken, assetsPerShare);
  return {
    market: claim.market,
    block: reader.block.toString(),
    collateralToken: manifest.seer.collateralToken,
    sdaiToXdai: formatWad(assetsPerShare),
    priceLabel: PRICE_LABEL,
    outcomes: [yes, no],
    notes: [
      "Depth quotes come from the Algebra Quoter at the pinned block and include the dynamic fee of the next swap; they change with every trade.",
      "Fees are dynamic (0.01% to 1.5% under the current factory configuration; governance can raise them).",
      "Third-party liquidity in these pools can appear or be withdrawn at any time.",
    ],
  };
}

export function registerLiquidityRoutes(deps: { app: ZodApp; ctx: AppContext; manifest: DeploymentManifest }): void {
  const { app, ctx, manifest } = deps;
  // Per-market cache, bounded in size, expiring by ctx.clock.
  const cache = new TtlCache<Address, LiquidityResponse>(LIQUIDITY_CACHE_TTL_MS, LIQUIDITY_CACHE_MAX_ENTRIES);
  const limiter = new FanOutLimiter(LIQUIDITY_MAX_IN_FLIGHT, LIQUIDITY_RETRY_AFTER_SECONDS);
  app.get(
    "/api/v1/markets/:market/liquidity",
    { config: PUBLIC_ROUTE, schema: { params: z.object({ market: addressSchema }).strict() } },
    async (request, reply) => {
      const market = request.params.market;
      const nowMs = ctx.clock.now().getTime();
      let body = cache.get(market, nowMs);
      if (!body) {
        const claim = await requireClaim(ctx, manifest, market);
        // Checked after the cache lookup: cached answers are never refused; a refused miss caches nothing.
        body = await limiter.run(() => readLiquidity(ctx, manifest, claim));
        cache.set(market, body, nowMs);
      }
      void reply.header("cache-control", `public, max-age=${LIQUIDITY_CACHE_TTL_MS / 1000}`);
      return body;
    },
  );
}
