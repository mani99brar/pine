// YES sell-ladder funding plan (PRD-04 3.2, ADR D8): splitFromBase (unless the wallet already holds S YES), an exact
// YES approval to the position manager, optional pool creation/initialisation strictly outside the range on the
// YES-cheaper side, and a single-sided YES mint to the account. No re-pricing swaps: an existing pool priced on the
// wrong side of the ladder is refused with an explanation.

import { z } from "zod";
import type { DeploymentManifest } from "@pine/shared/deployment";
import type { JsonValue } from "@pine/shared/canonical";
import type { ClaimRecord } from "@pine/shared/read-model";
import { buildStep, type TxStep } from "@pine/shared/tx-plan";
import type { Address } from "@pine/shared/types";
import type { AppContext } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { chainReader } from "./chain.js";
import {
  addressSchema,
  C7_DISCLOSURES,
  FUNDING_PLAN_LIMITS,
  isoSeconds,
  isUintString,
  LADDER_MIN_TIME_BEFORE_DEADLINE,
  lower,
  MAX_LADDER_PRICE_WAD,
  MIN_LADDER_PRICE_WAD,
  MINUTE,
  NEW_POOL_TICK_SPACING,
  nowSeconds,
  planContextFor,
  PRICE_LABEL,
  requireClaim,
  uintStringSchema,
  type ZodApp,
} from "./common.js";
import { assertClaimIntegrity } from "./integrity.js";
import {
  formatWad,
  isYesOnlySide,
  ladderRange,
  maxLossIfYes,
  minusSlippage,
  outcomePriceWad,
  parseDecimalWad,
  RangeCollapsedError,
  sharesAfterMargin,
  sharesToAssetsCeil,
  sharesToAssetsFloor,
  WAD,
  type LadderRange,
} from "./math.js";
import { createPlan, type BuiltPlan } from "./store.js";

export const LADDER_ROUTE = "funding.ladder";
/** Mint deadline: now + 20 minutes (PRD-04 3.2 step 5). */
export const MINT_DEADLINE_SECONDS = 20 * MINUTE;

/** Gas units measured on Gnosis (docs/research/liquidity-amm.md section 5); approve is not measured there. */
export const GAS_UNITS = { split: 550_000n, approve: 60_000n, createPool: 6_800_000n, mint: 400_000n } as const;
/** Reference gas price for the cost estimate: 1 gwei (many wallets pay it; the base fee is far lower). */
export const REFERENCE_GAS_PRICE_WEI = 1_000_000_000n;
/** Algebra rounding can leave a few wei of the exact approval unspent (operator clarification 5). */
export const MAX_RESIDUAL_ALLOWANCE_WEI = 10n;

const priceField = z.string().max(40).regex(/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,18})?$/, "must be a decimal string with at most 18 fractional digits");

export const ladderBodySchema = z
  .object({
    market: addressSchema,
    budgetWei: uintStringSchema,
    lowerPrice: priceField,
    upperPrice: priceField,
    // SEC-LEGAL-03 (PRD-04 4a): the figures the user accepted. maxLossIfYesShares is in sDAI share base units.
    riskAcknowledgement: z.object({ budgetWei: uintStringSchema, maxLossIfYesShares: uintStringSchema }).strict(),
  })
  .strict()
  .superRefine((body, issue) => {
    // zod 4 runs this even when a field failed its regex: never BigInt() an unchecked string.
    const budget = isUintString(body.budgetWei) ? BigInt(body.budgetWei) : null;
    if (budget === null) issue.addIssue({ code: "custom", path: ["budgetWei"], message: "must be a base-10 unsigned integer string" });
    else if (budget <= 0n) issue.addIssue({ code: "custom", path: ["budgetWei"], message: "must be positive" });
    else if (budget > FUNDING_PLAN_LIMITS.maxTotalValueWei) issue.addIssue({ code: "custom", path: ["budgetWei"], message: "exceeds the 10,000 xDAI plan limit" });
    const low = parseDecimalWad(body.lowerPrice);
    const high = parseDecimalWad(body.upperPrice);
    if (low === null || low < MIN_LADDER_PRICE_WAD) issue.addIssue({ code: "custom", path: ["lowerPrice"], message: "must be at least 0.01" });
    if (high === null || high > MAX_LADDER_PRICE_WAD) issue.addIssue({ code: "custom", path: ["upperPrice"], message: "must be at most 0.95" });
    if (low !== null && high !== null && !(low < high)) issue.addIssue({ code: "custom", path: ["upperPrice"], message: "must be above lowerPrice" });
    // Both strings passed the canonical integer regex (no leading zeros), so string equality is numeric equality.
    const acknowledged = body.riskAcknowledgement as { budgetWei?: unknown } | undefined;
    if (isUintString(acknowledged?.budgetWei) && isUintString(body.budgetWei) && acknowledged.budgetWei !== body.budgetWei) {
      issue.addIssue({ code: "custom", path: ["riskAcknowledgement", "budgetWei"], message: "must equal budgetWei" });
    }
  });

export type LadderBody = z.output<typeof ladderBodySchema>;

/** Fee configuration of new Swapr v3 pools (docs/research/liquidity-amm.md 2.3), hundredths of a bip. */
const FEE_RANGE = { minFee: 100, maxFee: 15_000, governanceMaxFee: 65_535 } as const;

function refuse(message: string): never {
  throw new ApiError("UNPROCESSABLE", message);
}

/** Phase and moderation gate (PRD-04 3.2 step 1): evidence_open with at least 1 hour left, not hidden or blocked. */
export async function assertLadderOpen(ctx: AppContext, claim: ClaimRecord): Promise<void> {
  const now = nowSeconds(ctx);
  if (!(now < claim.evidenceDeadline - LADDER_MIN_TIME_BEFORE_DEADLINE)) {
    refuse(`Funding ladders are offered only while evidence is open and at least 1 hour before the evidence deadline (${isoSeconds(claim.evidenceDeadline)})`);
  }
  const moderated = await ctx.moderation.states("claim", [claim.market]);
  if (moderated.size > 0) refuse("This claim is hidden or blocked by moderation; funding is not offered");
}

/**
 * SEC-LEGAL-03 (PRD-04 4a): refuses the plan (409 with the freshly computed figures) when the computed maximum loss if
 * YES resolves exceeds what the user acknowledged; a smaller loss (favourable drift) is accepted. ApiError carries no
 * data field, so the figures are returned as issues whose message is the value.
 */
export function assertRiskAcknowledged(body: LadderBody, computed: { lossShares: bigint; lossXdai: bigint; sets: bigint; range: LadderRange }): void {
  const acknowledged = BigInt(body.riskAcknowledgement.maxLossIfYesShares);
  if (computed.lossShares <= acknowledged) return;
  const figures: [string, string][] = [
    ["maxLossIfYesShares", computed.lossShares.toString()],
    ["maxLossIfYesXdaiWei", computed.lossXdai.toString()],
    ["budgetWei", body.budgetWei],
    ["sets", computed.sets.toString()],
    ["finalLowerPrice", formatWad(computed.range.finalLowerPriceWad)],
    ["finalUpperPrice", formatWad(computed.range.finalUpperPriceWad)],
  ];
  throw new ApiError(
    "CONFLICT",
    `The maximum loss if YES resolves is now ${computed.lossShares} sDAI share base units (${computed.lossXdai} xDAI wei), above the acknowledged ` +
      `${acknowledged}. Review the figures and acknowledge again.`,
    { issues: figures.map(([name, value]) => ({ path: ["riskAcknowledgement", "computed", name], message: value })) },
  );
}

export async function buildLadder(ctx: AppContext, manifest: DeploymentManifest, account: Address, body: LadderBody, now: Date): Promise<BuiltPlan> {
  const claim = await requireClaim(ctx, manifest, body.market);
  await assertLadderOpen(ctx, claim);
  await assertClaimIntegrity(ctx, claim, manifest);

  const budget = BigInt(body.budgetWei);
  const lowerPriceWad = parseDecimalWad(body.lowerPrice);
  const upperPriceWad = parseDecimalWad(body.upperPrice);
  if (lowerPriceWad === null || upperPriceWad === null) throw new ApiError("VALIDATION_FAILED", "Invalid price");

  const reader = await chainReader(ctx, manifest);
  const yes = lower(claim.yesToken);
  const collateral = lower(manifest.seer.collateralToken);
  const yesIsToken0 = yes < collateral;
  const [token0, token1] = yesIsToken0 ? [yes, collateral] : [collateral, yes];

  const shares = await reader.previewDeposit(budget);
  const sets = sharesAfterMargin(shares);
  const amountMin = minusSlippage(sets);
  if (sets <= 0n || amountMin <= 0n) throw new ApiError("VALIDATION_FAILED", "The budget is too small to fund a ladder", { issues: [{ path: ["budgetWei"], message: "too small" }] });

  // Pool state at the pinned block.
  const pool = await reader.poolByPair(yes, collateral);
  let poolAction: "create" | "initialise" | "existing" = "create";
  let tickSpacing = NEW_POOL_TICK_SPACING;
  let currentFee: number | null = null;
  let cooldown: number | null = null;
  let current: { sqrtPriceX96: bigint; tick: number } | null = null;
  if (pool !== null) {
    const state = await reader.globalState(pool);
    tickSpacing = await reader.tickSpacing(pool);
    cooldown = await reader.liquidityCooldown(pool);
    currentFee = state.fee;
    if (state.sqrtPriceX96 === 0n) {
      poolAction = "initialise";
    } else {
      poolAction = "existing";
      current = { sqrtPriceX96: state.sqrtPriceX96, tick: state.tick };
    }
  }

  let range: LadderRange;
  try {
    range = ladderRange({ yesIsToken0, lowerPriceWad, upperPriceWad, tickSpacing });
  } catch (error) {
    if (error instanceof RangeCollapsedError) {
      throw new ApiError("VALIDATION_FAILED", `The price range is narrower than one tick spacing (${tickSpacing}); widen it`, { issues: [{ path: ["upperPrice"], message: "range narrower than one tick spacing" }] });
    }
    throw error;
  }

  if (current !== null && !isYesOnlySide({ yesIsToken0, currentTick: current.tick, sqrtPriceX96: current.sqrtPriceX96, range })) {
    const price = outcomePriceWad(current.sqrtPriceX96, yesIsToken0);
    // YES dearer than the whole ladder: at or above tickUpper when YES = token0, below tickLower when YES = token1.
    const aboveRange = yesIsToken0 ? current.tick >= range.tickUpper : current.tick < range.tickLower;
    const lowerText = formatWad(range.finalLowerPriceWad);
    const upperText = formatWad(range.finalUpperPriceWad);
    refuse(
      `The existing YES/sDAI pool trades YES at ${price === null ? "an unknown price" : formatWad(price)} sDAI, ` +
        (aboveRange ? `above the ladder's upper price ${upperText} sDAI` : `inside the ladder's range ${lowerText} to ${upperText} sDAI`) +
        `. A YES-only ladder needs the pool price below its lower price ${lowerText} sDAI; Pine never re-prices pools with swaps. ` +
        "Choose a range above the current price (at most 0.95) or fund through another venue.",
    );
  }

  const yesBalance = await reader.tokenBalance(yes, account);
  const includeSplit = yesBalance < sets;
  const assetsPerShare = await reader.convertToAssets(WAD);

  const deadline = BigInt(Math.floor(now.getTime() / 1000) + MINT_DEADLINE_SECONDS);
  const steps: TxStep[] = [];
  if (includeSplit) steps.push(buildStep(manifest, { id: "split", allowlistId: "gnosisRouter.splitFromBase", args: [claim.market], value: budget }));
  steps.push(
    buildStep(manifest, {
      id: "approve-yes",
      allowlistId: "outcomeToken.approve",
      to: yes,
      args: [manifest.amm.positionManager, sets],
      dependsOn: includeSplit ? ["split"] : [],
    }),
  );
  if (poolAction !== "existing") {
    steps.push(buildStep(manifest, { id: "create-pool", allowlistId: "positionManager.createAndInitializePoolIfNecessary", args: [token0, token1, range.initialSqrtPriceX96] }));
  }
  const mintDepends = ["approve-yes", ...(poolAction !== "existing" ? ["create-pool"] : [])];
  steps.push(
    buildStep(manifest, {
      id: "mint-yes",
      allowlistId: "positionManager.mint",
      args: [
        {
          token0,
          token1,
          tickLower: range.tickLower,
          tickUpper: range.tickUpper,
          amount0Desired: yesIsToken0 ? sets : 0n,
          amount1Desired: yesIsToken0 ? 0n : sets,
          amount0Min: yesIsToken0 ? amountMin : 0n,
          amount1Min: yesIsToken0 ? 0n : amountMin,
          recipient: account,
          deadline,
        },
      ],
      dependsOn: mintDepends,
    }),
  );

  const lossShares = maxLossIfYes({ sets, yesIsToken0, sqrtPriceLowerX96: range.sqrtPriceLowerX96, sqrtPriceUpperX96: range.sqrtPriceUpperX96 });
  const lossXdai = sharesToAssetsCeil(lossShares, assetsPerShare);
  assertRiskAcknowledged(body, { lossShares, lossXdai, sets, range });
  const gasUnits = (includeSplit ? GAS_UNITS.split : 0n) + GAS_UNITS.approve + (poolAction !== "existing" ? GAS_UNITS.createPool : 0n) + GAS_UNITS.mint;
  const remainder = shares - sets;

  const details: JsonValue = {
    kind: "ladder",
    market: claim.market,
    block: reader.block.toString(),
    yesToken: yes,
    collateralToken: collateral,
    orientation: { yesIsToken0, token0, token1, poolPrice: yesIsToken0 ? "sDAI per YES" : "YES per sDAI" },
    pool: { address: pool, action: poolAction, tickSpacing, initialSqrtPriceX96: poolAction === "existing" ? null : range.initialSqrtPriceX96.toString() },
    budgetWei: budget.toString(),
    sharesPreview: shares.toString(),
    sets: sets.toString(),
    remainderShares: remainder.toString(),
    splitIncluded: includeSplit,
    yesBalance: yesBalance.toString(),
    requested: { lowerPrice: body.lowerPrice, upperPrice: body.upperPrice },
    range: {
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      lowerPrice: formatWad(range.finalLowerPriceWad),
      upperPrice: formatWad(range.finalUpperPriceWad),
      note: "Ticks are rounded inward to the tick spacing, so the ladder never sells below the requested lower price or above the requested upper price.",
    },
    mint: { amountYes: sets.toString(), amountYesMin: amountMin.toString(), deadline: Number(deadline), recipient: account },
    maxLossIfYes: {
      sdai: lossShares.toString(),
      xdai: lossXdai.toString(),
      formula: "S x (1 - sqrt(p_a x p_b)) with p_a, p_b the YES prices of the final ticks, plus gas; swap fees earned reduce it slightly",
    },
    lossIfNoOrInvalid: {
      statement: "Gas only: the NO and INVALID tokens of the split stay in the wallet and redeem for the collateral if NO or Invalid resolves.",
      remainderShares: remainder.toString(),
      remainderXdai: sharesToAssetsFloor(remainder, assetsPerShare).toString(),
      remainderNote: "The 10 bps interest-accrual margin is not minted; it stays in the wallet as full sets (YES, NO and INVALID).",
    },
    gasEstimate: {
      units: gasUnits.toString(),
      referenceGasPriceWei: REFERENCE_GAS_PRICE_WEI.toString(),
      costWeiAtReference: (gasUnits * REFERENCE_GAS_PRICE_WEI).toString(),
      note: "Estimate from measured Gnosis transactions; the wallet sets the actual gas price.",
    },
    fees: {
      currentFee,
      minFee: FEE_RANGE.minFee,
      maxFee: FEE_RANGE.maxFee,
      governanceMaxFee: FEE_RANGE.governanceMaxFee,
      unit: "hundredths of a basis point",
      note: "Algebra fees are dynamic (0.01% to 1.5% under the current factory configuration); governance can raise them up to 6.55%. 10% of fees go to the Swapr vault.",
    },
    withdrawability: {
      liquidityCooldownSeconds: cooldown,
      statement:
        "The position NFT is withdrawable by its owner at any time, subject to the pool's liquidityCooldown() after the last liquidity added " +
        `(${cooldown === null ? "read once the pool exists" : `currently ${cooldown} s`}; governance can raise it to 1 day). Liquidity is not a bounty and nothing locks it.`,
    },
    riskAcknowledgement: {
      budgetWei: body.riskAcknowledgement.budgetWei,
      maxLossIfYesShares: body.riskAcknowledgement.maxLossIfYesShares,
      computedMaxLossIfYesShares: lossShares.toString(),
      acknowledgedAt: now.toISOString(),
      rule: "The plan is offered only when the computed maximum loss if YES resolves (sDAI share base units) does not exceed the acknowledged value. Fees are dynamic and disclosed as a range only.",
    },
    residualAllowance: `Approval is exactly S; Algebra rounding can leave up to ${MAX_RESIDUAL_ALLOWANCE_WEI} wei of YES allowance to the position manager unspent.`,
    priceLabel: PRICE_LABEL,
    disclosures: [...C7_DISCLOSURES],
  };
  return { market: claim.market, steps, context: planContextFor(claim), details };
}

export function registerLadderRoutes(deps: { app: ZodApp; ctx: AppContext; manifest: DeploymentManifest }): void {
  const { app, ctx, manifest } = deps;
  app.post("/api/v1/funding/plans/ladder", { preHandler: app.requireSession, schema: { body: ladderBodySchema } }, async (request) => {
    const body = request.body;
    return createPlan({
      ctx,
      manifest,
      request,
      route: LADDER_ROUTE,
      kind: "ladder",
      body: {
        market: body.market,
        budgetWei: body.budgetWei,
        lowerPrice: body.lowerPrice,
        upperPrice: body.upperPrice,
        riskAcknowledgement: { budgetWei: body.riskAcknowledgement.budgetWei, maxLossIfYesShares: body.riskAcknowledgement.maxLossIfYesShares },
      },
      action: "fund_market",
      build: (session, _planId, now) => buildLadder(ctx, manifest, lower(session.wallet), body, now),
    });
  });
}
