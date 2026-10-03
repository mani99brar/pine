// Exit plans (PRD-04 3.3): withdraw a position (decreaseLiquidity, collect to the account, burn), merge full sets back
// to xDAI, and redeem winning outcome tokens after resolution. verifyPlan binds no tokenId, so the module checks
// `ownerOf(tokenId) == account` and that the position's pool pairs a registered claim market's outcome token with sDAI.

import { z } from "zod";
import type { JsonValue } from "@pine/shared/canonical";
import type { DeploymentManifest } from "@pine/shared/deployment";
import { buildStep, type TxStep } from "@pine/shared/tx-plan";
import type { Address } from "@pine/shared/types";
import type { AppContext } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { chainReader } from "./chain.js";
import { addressSchema, C7_DISCLOSURES, FUNDING_PLAN_LIMITS, isUintString, lower, MINUTE, planContextFor, requireClaim, uintStringSchema, type ZodApp } from "./common.js";
import { amountsForLiquidity, minusSlippage, sharesToAssetsFloor, WAD } from "./math.js";
import { outcomeOfPair } from "./positions.js";
import { createPlan, type BuiltPlan } from "./store.js";

export const WITHDRAW_ROUTE = "funding.withdraw";
export const MERGE_ROUTE = "funding.merge";
export const REDEEM_ROUTE = "funding.redeem";
export const WITHDRAW_DEADLINE_SECONDS = 20 * MINUTE;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_LIMIT = 1n << 256n;

const positiveAmount = uintStringSchema.refine((value) => {
  if (!isUintString(value)) return false;
  const amount = BigInt(value);
  return amount > 0n && amount <= FUNDING_PLAN_LIMITS.maxApprovalAmount;
}, "must be positive and at most 10^30");

export const withdrawBodySchema = z
  .object({
    market: addressSchema,
    tokenId: uintStringSchema.refine((value) => isUintString(value) && BigInt(value) < UINT256_LIMIT, "out of range"),
  })
  .strict();
export const mergeBodySchema = z.object({ market: addressSchema, amount: positiveAmount }).strict();
export const redeemBodySchema = z.object({ market: addressSchema }).strict();

function refuse(message: string): never {
  throw new ApiError("UNPROCESSABLE", message);
}

export async function buildWithdraw(ctx: AppContext, manifest: DeploymentManifest, account: Address, body: z.output<typeof withdrawBodySchema>, now: Date): Promise<BuiltPlan> {
  const claim = await requireClaim(ctx, manifest, body.market);
  const tokenId = BigInt(body.tokenId);
  const reader = await chainReader(ctx, manifest);
  const owner = await reader.ownerOf(tokenId);
  if (owner === null) throw new ApiError("NOT_FOUND", "Position not found");
  if (owner !== lower(account)) throw new ApiError("FORBIDDEN", "This position is not owned by your wallet");
  const position = await reader.position(tokenId);
  const outcome = outcomeOfPair(claim, manifest.seer.collateralToken, position.token0, position.token1);
  if (outcome === null) refuse("This position does not pair an outcome token of this claim market with sDAI");
  const pool = await reader.poolByPair(position.token0, position.token1);
  if (pool === null) refuse("No Algebra pool exists for this position's pair");
  const [state, cooldown] = [await reader.globalState(pool), await reader.liquidityCooldown(pool)];
  if (position.liquidity === 0n && position.tokensOwed0 === 0n && position.tokensOwed1 === 0n) {
    // Nothing left to withdraw: only the empty NFT remains.
    const steps = [buildStep(manifest, { id: "burn", allowlistId: "positionManager.burn", args: [tokenId] })];
    return { market: claim.market, steps, context: planContextFor(claim), details: { kind: "withdraw", tokenId: tokenId.toString(), outcome, pool, expected: null, liquidityCooldownSeconds: cooldown } };
  }
  const expected = amountsForLiquidity({ currentTick: state.tick, sqrtPriceX96: state.sqrtPriceX96, tickLower: position.tickLower, tickUpper: position.tickUpper, liquidity: position.liquidity });
  const deadline = BigInt(Math.floor(now.getTime() / 1000) + WITHDRAW_DEADLINE_SECONDS);
  const steps: TxStep[] = [];
  if (position.liquidity > 0n) {
    steps.push(
      buildStep(manifest, {
        id: "decrease",
        allowlistId: "positionManager.decreaseLiquidity",
        args: [{ tokenId, liquidity: position.liquidity, amount0Min: minusSlippage(expected.amount0), amount1Min: minusSlippage(expected.amount1), deadline }],
      }),
    );
  }
  steps.push(
    buildStep(manifest, {
      id: "collect",
      allowlistId: "positionManager.collect",
      args: [{ tokenId, recipient: account, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX }],
      dependsOn: position.liquidity > 0n ? ["decrease"] : [],
    }),
  );
  steps.push(buildStep(manifest, { id: "burn", allowlistId: "positionManager.burn", args: [tokenId], dependsOn: ["collect"] }));
  const details: JsonValue = {
    kind: "withdraw",
    tokenId: tokenId.toString(),
    outcome,
    pool,
    block: reader.block.toString(),
    liquidity: position.liquidity.toString(),
    expected: { amount0: expected.amount0.toString(), amount1: expected.amount1.toString(), plusFeesOwed: { amount0: position.tokensOwed0.toString(), amount1: position.tokensOwed1.toString() } },
    minimums: { amount0: minusSlippage(expected.amount0).toString(), amount1: minusSlippage(expected.amount1).toString(), slippageBps: 50 },
    deadline: Number(deadline),
    liquidityCooldownSeconds: cooldown,
    statement:
      cooldown > 0
        ? `The pool's liquidityCooldown() is ${cooldown} s: removing liquidity reverts until that long after the position's last liquidity addition.`
        : "The pool's liquidityCooldown() is currently 0; governance can raise it to 1 day.",
  };
  return { market: claim.market, steps, context: planContextFor(claim), details };
}

export async function buildMerge(ctx: AppContext, manifest: DeploymentManifest, account: Address, body: z.output<typeof mergeBodySchema>): Promise<BuiltPlan> {
  const claim = await requireClaim(ctx, manifest, body.market);
  const amount = BigInt(body.amount);
  const reader = await chainReader(ctx, manifest);
  const tokens: [string, Address][] = [
    ["yes", lower(claim.yesToken)],
    ["no", lower(claim.noToken)],
    ["invalid", lower(claim.invalidToken)],
  ];
  const short: string[] = [];
  for (const [name, token] of tokens) if ((await reader.tokenBalance(token, account)) < amount) short.push(name);
  if (short.length > 0) refuse(`Merging needs ${amount} of each outcome token; the wallet holds less ${short.join(", ")}`);
  const steps: TxStep[] = tokens.map(([name, token]) =>
    buildStep(manifest, { id: `approve-${name}`, allowlistId: "outcomeToken.approve", to: token, args: [manifest.seer.gnosisRouter, amount] }),
  );
  steps.push(buildStep(manifest, { id: "merge", allowlistId: "gnosisRouter.mergeToBase", args: [claim.market, amount], dependsOn: tokens.map(([name]) => `approve-${name}`) }));
  const assetsPerShare = await reader.convertToAssets(WAD);
  const details: JsonValue = {
    kind: "merge",
    market: claim.market,
    block: reader.block.toString(),
    amount: amount.toString(),
    expectedXdai: sharesToAssetsFloor(amount, assetsPerShare).toString(),
    statement: "Merging returns one sDAI per full set (YES + NO + INVALID), paid out as xDAI by the GnosisRouter. Use it to recover from a partially executed ladder.",
  };
  return { market: claim.market, steps, context: planContextFor(claim), details };
}

export async function buildRedeem(ctx: AppContext, manifest: DeploymentManifest, account: Address, body: z.output<typeof redeemBodySchema>): Promise<BuiltPlan> {
  const claim = await requireClaim(ctx, manifest, body.market);
  const resolution = await ctx.readModel.getConditionResolution(claim.conditionId);
  if (!resolution) refuse("The market's condition is not resolved yet; redemption opens after ConditionResolution");
  if (resolution.payoutNumerators.length !== 3) refuse("Unexpected payout vector for this market");
  const denominator = resolution.payoutNumerators.reduce((sum, value) => sum + value, 0n);
  if (denominator <= 0n) refuse("Unexpected payout vector for this market");
  const reader = await chainReader(ctx, manifest);
  const tokens: Address[] = [lower(claim.yesToken), lower(claim.noToken), lower(claim.invalidToken)];
  const names = ["yes", "no", "invalid"] as const;
  const indexes: bigint[] = [];
  const amounts: bigint[] = [];
  const steps: TxStep[] = [];
  let payout = 0n;
  for (let index = 0; index < 3; index += 1) {
    const numerator = resolution.payoutNumerators[index] ?? 0n;
    const token = tokens[index];
    if (numerator === 0n || token === undefined) continue;
    const balance = await reader.tokenBalance(token, account);
    if (balance === 0n) continue;
    indexes.push(BigInt(index));
    amounts.push(balance);
    payout += (balance * numerator) / denominator;
    steps.push(buildStep(manifest, { id: `approve-${names[index]}`, allowlistId: "outcomeToken.approve", to: token, args: [manifest.seer.gnosisRouter, balance] }));
  }
  if (indexes.length === 0) refuse("The wallet holds no winning outcome tokens of this market");
  steps.push(buildStep(manifest, { id: "redeem", allowlistId: "gnosisRouter.redeemToBase", args: [claim.market, indexes, amounts], dependsOn: steps.map((step) => step.id) }));
  const assetsPerShare = await reader.convertToAssets(WAD);
  const details: JsonValue = {
    kind: "redeem",
    market: claim.market,
    block: reader.block.toString(),
    payoutNumerators: resolution.payoutNumerators.map(String),
    outcomes: indexes.map((index, position) => ({ index: Number(index), outcome: names[Number(index)] ?? "unknown", amount: (amounts[position] ?? 0n).toString() })),
    expectedSdai: payout.toString(),
    expectedXdai: sharesToAssetsFloor(payout, assetsPerShare).toString(),
    disclosures: [...C7_DISCLOSURES],
  };
  return { market: claim.market, steps, context: planContextFor(claim), details };
}

export function registerExitRoutes(deps: { app: ZodApp; ctx: AppContext; manifest: DeploymentManifest }): void {
  const { app, ctx, manifest } = deps;
  app.post("/api/v1/funding/plans/withdraw", { preHandler: app.requireSession, schema: { body: withdrawBodySchema } }, async (request) => {
    const body = request.body;
    return createPlan({
      ctx,
      manifest,
      request,
      route: WITHDRAW_ROUTE,
      kind: "withdraw",
      body: { market: body.market, tokenId: body.tokenId },
      action: "redeem",
      build: (session, _planId, now) => buildWithdraw(ctx, manifest, lower(session.wallet), body, now),
    });
  });
  app.post("/api/v1/funding/plans/merge", { preHandler: app.requireSession, schema: { body: mergeBodySchema } }, async (request) => {
    const body = request.body;
    return createPlan({
      ctx,
      manifest,
      request,
      route: MERGE_ROUTE,
      kind: "merge",
      body: { market: body.market, amount: body.amount },
      action: "redeem",
      build: (session) => buildMerge(ctx, manifest, lower(session.wallet), body),
    });
  });
  app.post("/api/v1/funding/plans/redeem", { preHandler: app.requireSession, schema: { body: redeemBodySchema } }, async (request) => {
    const body = request.body;
    return createPlan({
      ctx,
      manifest,
      request,
      route: REDEEM_ROUTE,
      kind: "redeem",
      body: { market: body.market },
      action: "redeem",
      build: (session) => buildRedeem(ctx, manifest, lower(session.wallet), body),
    });
  });
}
