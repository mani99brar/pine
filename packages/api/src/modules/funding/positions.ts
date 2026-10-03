// A wallet's Algebra positions for one claim market (PRD-04 3.3): public and bounded. The frozen read model has no
// token -> market lookup, so `market` is required; positions are those whose pair is one of the market's outcome
// tokens with sDAI. 20 NFTs are scanned per page and at most the first 200 per wallet (`truncated` beyond).

import { z } from "zod";
import type { DeploymentManifest } from "@pine/shared/deployment";
import type { ClaimRecord } from "@pine/shared/read-model";
import type { Address } from "@pine/shared/types";
import type { AppContext } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { chainReader, type PositionData } from "./chain.js";
import { addressSchema, FanOutLimiter, lower, PUBLIC_ROUTE, requireClaim, TtlCache, type ZodApp } from "./common.js";

export const POSITIONS_PAGE_SIZE = 20;
export const POSITIONS_SCAN_LIMIT = 200;
/** Server cache per (wallet, market, cursor): the route is public and fans out to up to ~45 eth_calls (PRD-04 4a). */
export const POSITIONS_CACHE_TTL_MS = 10_000;
const POSITIONS_CACHE_MAX_ENTRIES = 1_000;
/** Cache misses reading the chain at once per process; the next one is refused with 429 (PRD-04 4b). */
export const POSITIONS_MAX_IN_FLIGHT = 4;
export const POSITIONS_RETRY_AFTER_SECONDS = 2;

export type OutcomeName = "yes" | "no" | "invalid";

/** The outcome a position's pair belongs to (that outcome token with sDAI), or null for any other pair. */
export function outcomeOfPair(claim: ClaimRecord, collateral: Address, token0: Address, token1: Address): OutcomeName | null {
  const pair = [lower(token0), lower(token1)];
  if (!pair.includes(lower(collateral))) return null;
  const other = pair[0] === lower(collateral) ? pair[1] : pair[0];
  if (other === lower(claim.yesToken)) return "yes";
  if (other === lower(claim.noToken)) return "no";
  if (other === lower(claim.invalidToken)) return "invalid";
  return null;
}

export interface PositionItem {
  tokenId: string;
  outcome: OutcomeName;
  token0: Address;
  token1: Address;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  tokensOwed0: string;
  tokensOwed1: string;
}

const toItem = (tokenId: bigint, outcome: OutcomeName, position: PositionData): PositionItem => ({
  tokenId: tokenId.toString(),
  outcome,
  token0: position.token0,
  token1: position.token1,
  tickLower: position.tickLower,
  tickUpper: position.tickUpper,
  liquidity: position.liquidity.toString(),
  tokensOwed0: position.tokensOwed0.toString(),
  tokensOwed1: position.tokensOwed1.toString(),
});

export const positionsQuerySchema = z
  .object({
    market: addressSchema,
    cursor: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,2})$/, "invalid cursor")
      .transform(Number)
      .refine((value) => value < POSITIONS_SCAN_LIMIT && value % POSITIONS_PAGE_SIZE === 0, "invalid cursor")
      .optional(),
  })
  .strict();

export type PositionsResponse = Awaited<ReturnType<typeof readPositions>>;

export async function readPositions(ctx: AppContext, manifest: DeploymentManifest, wallet: Address, market: Address, start: number) {
  const claim = await requireClaim(ctx, manifest, market);
  const reader = await chainReader(ctx, manifest);
  const collateral = manifest.seer.collateralToken;
  const count = await reader.positionCount(wallet);
  const scanEnd = count < BigInt(POSITIONS_SCAN_LIMIT) ? Number(count) : POSITIONS_SCAN_LIMIT;
  const end = Math.min(start + POSITIONS_PAGE_SIZE, scanEnd);
  const items: PositionItem[] = [];
  for (let index = start; index < end; index += 1) {
    const tokenId = await reader.tokenOfOwnerByIndex(wallet, BigInt(index));
    const position = await reader.position(tokenId);
    const outcome = outcomeOfPair(claim, collateral, position.token0, position.token1);
    if (outcome !== null) items.push(toItem(tokenId, outcome, position));
  }
  const [yesPool, noPool, yes, no, invalid] = [
    await reader.poolByPair(claim.yesToken, collateral),
    await reader.poolByPair(claim.noToken, collateral),
    await reader.tokenBalance(claim.yesToken, wallet),
    await reader.tokenBalance(claim.noToken, wallet),
    await reader.tokenBalance(claim.invalidToken, wallet),
  ];
  return {
    wallet,
    market: claim.market,
    block: reader.block.toString(),
    pools: { yes: yesPool, no: noPool },
    positionCount: count.toString(),
    scanned: { from: start, to: end },
    truncated: count > BigInt(POSITIONS_SCAN_LIMIT),
    nextCursor: end < scanEnd ? String(end) : null,
    items,
    balances: { yes: yes.toString(), no: no.toString(), invalid: invalid.toString() },
    notes: [`At most the first ${POSITIONS_SCAN_LIMIT} position NFTs of a wallet are scanned.`, "Third-party liquidity is not shown here; it can appear or be withdrawn at any time."],
  };
}

export function registerPositionRoutes(deps: { app: ZodApp; ctx: AppContext; manifest: DeploymentManifest }): void {
  const { app, ctx, manifest } = deps;
  const cache = new TtlCache<string, PositionsResponse>(POSITIONS_CACHE_TTL_MS, POSITIONS_CACHE_MAX_ENTRIES);
  const limiter = new FanOutLimiter(POSITIONS_MAX_IN_FLIGHT, POSITIONS_RETRY_AFTER_SECONDS);
  app.get(
    "/api/v1/funding/positions/:wallet",
    { config: PUBLIC_ROUTE, schema: { params: z.object({ wallet: addressSchema }).strict(), querystring: positionsQuerySchema } },
    async (request, reply) => {
      const start = request.query.cursor ?? 0;
      if (!Number.isSafeInteger(start)) throw new ApiError("VALIDATION_FAILED", "invalid cursor");
      const key = `${request.params.wallet}|${request.query.market}|${start}`;
      const nowMs = ctx.clock.now().getTime();
      let body = cache.get(key, nowMs);
      if (!body) {
        // Checked after the cache lookup: cached answers are never refused.
        body = await limiter.run(() => readPositions(ctx, manifest, request.params.wallet, request.query.market, start));
        cache.set(key, body, nowMs);
      }
      void reply.header("cache-control", `public, max-age=${POSITIONS_CACHE_TTL_MS / 1000}`);
      return body;
    },
  );
}
