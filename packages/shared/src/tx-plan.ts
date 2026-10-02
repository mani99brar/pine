// FROZEN. Non-custodial transaction plans (SEC-TX-01..12): the only shape in which the API proposes transactions.
//
// A plan is a list of calls the user's own wallet will send. The API builds plans with buildStep(); the frontend
// (and every API test) re-verifies them with verifyPlan() from its own copy of this file before any wallet prompt.
// verifyPlan enforces, independently of whoever built the plan:
//   - chain binding and the deployment-manifest hash;
//   - an allowlist of (target, function) pairs: nothing else can appear;
//   - calldata equals the re-encoding of the declared function and args, byte for byte;
//   - value policy: zero for non-payable entries, > 0 for payable ones, and the plan's total value <= the user's limit;
//   - exact approvals: every approve(spender, amount) is consumed exactly by later steps of the same plan
//     (no residual allowance, no unlimited approvals, spenders only from the manifest);
//   - funds go to the user: recipients in mint/collect equal the plan account;
//   - market / question / outcome-token arguments refer to registered claims supplied by the caller's own lookup.
// No signature requests other than transactions exist in this model (no permits, Permit2, eth_sign, 7702).

import { encodeFunctionData, getAddress, type Abi, type AbiFunction, type Hex } from "viem";
import { claimRegistryAbi, evidenceRegistryAbi } from "./abi/generated.js";
import { erc20Abi, klerosHomeProxyAbi, realityV3Abi, seerGnosisRouterAbi, seerRealityProxyAbi } from "./abi/external.js";
import { algebraPositionManagerAbi } from "./abi/algebra.js";
import { deploymentHash, type DeploymentManifest } from "./deployment.js";
import type { Address, Hex32 } from "./types.js";

export type StaticTarget =
  | "claimRegistry"
  | "evidenceRegistry"
  | "gnosisRouter"
  | "collateralToken"
  | "positionManager"
  | "realitio"
  | "realityProxy"
  | "klerosHomeProxy";

export interface AllowlistEntry {
  id: string;
  target: { kind: "static"; key: StaticTarget } | { kind: "outcomeToken" };
  abi: Abi;
  functionName: string;
  value: "zero" | "positive";
  /** For approve(): the manifest targets allowed as spender. */
  spenders?: StaticTarget[];
}

const entry = (id: string, target: AllowlistEntry["target"], abi: Abi, functionName: string, value: "zero" | "positive" = "zero", spenders?: StaticTarget[]): AllowlistEntry =>
  spenders ? { id, target, abi, functionName, value, spenders } : { id, target, abi, functionName, value };

/** The complete allowlist (v1). Adding an entry is a frozen-contract change that needs an ADR. */
export const TX_ALLOWLIST: readonly AllowlistEntry[] = [
  entry("claimRegistry.createClaim", { kind: "static", key: "claimRegistry" }, claimRegistryAbi, "createClaim"),
  entry("evidenceRegistry.commitEvidence", { kind: "static", key: "evidenceRegistry" }, evidenceRegistryAbi, "commitEvidence"),
  entry("evidenceRegistry.revealEvidence", { kind: "static", key: "evidenceRegistry" }, evidenceRegistryAbi, "revealEvidence"),
  entry("evidenceRegistry.publishEvidence", { kind: "static", key: "evidenceRegistry" }, evidenceRegistryAbi, "publishEvidence"),
  entry("gnosisRouter.splitFromBase", { kind: "static", key: "gnosisRouter" }, seerGnosisRouterAbi, "splitFromBase", "positive"),
  entry("gnosisRouter.splitPosition", { kind: "static", key: "gnosisRouter" }, seerGnosisRouterAbi, "splitPosition"),
  entry("gnosisRouter.mergeToBase", { kind: "static", key: "gnosisRouter" }, seerGnosisRouterAbi, "mergeToBase"),
  entry("gnosisRouter.redeemToBase", { kind: "static", key: "gnosisRouter" }, seerGnosisRouterAbi, "redeemToBase"),
  entry("collateralToken.approve", { kind: "static", key: "collateralToken" }, erc20Abi, "approve", "zero", ["gnosisRouter", "positionManager"]),
  entry("outcomeToken.approve", { kind: "outcomeToken" }, erc20Abi, "approve", "zero", ["gnosisRouter", "positionManager"]),
  entry("positionManager.createAndInitializePoolIfNecessary", { kind: "static", key: "positionManager" }, algebraPositionManagerAbi, "createAndInitializePoolIfNecessary"),
  entry("positionManager.mint", { kind: "static", key: "positionManager" }, algebraPositionManagerAbi, "mint"),
  entry("positionManager.decreaseLiquidity", { kind: "static", key: "positionManager" }, algebraPositionManagerAbi, "decreaseLiquidity"),
  entry("positionManager.collect", { kind: "static", key: "positionManager" }, algebraPositionManagerAbi, "collect"),
  entry("positionManager.burn", { kind: "static", key: "positionManager" }, algebraPositionManagerAbi, "burn"),
  entry("realitio.submitAnswer", { kind: "static", key: "realitio" }, realityV3Abi, "submitAnswer", "positive"),
  entry("realitio.fundAnswerBounty", { kind: "static", key: "realitio" }, realityV3Abi, "fundAnswerBounty", "positive"),
  entry("realitio.claimWinnings", { kind: "static", key: "realitio" }, realityV3Abi, "claimWinnings"),
  entry("realitio.withdraw", { kind: "static", key: "realitio" }, realityV3Abi, "withdraw"),
  entry("realitio.reopenQuestion", { kind: "static", key: "realitio" }, realityV3Abi, "reopenQuestion"),
  entry("realityProxy.resolve", { kind: "static", key: "realityProxy" }, seerRealityProxyAbi, "resolve"),
  entry("klerosHomeProxy.handleNotifiedRequest", { kind: "static", key: "klerosHomeProxy" }, klerosHomeProxyAbi, "handleNotifiedRequest"),
  entry("klerosHomeProxy.handleRejectedRequest", { kind: "static", key: "klerosHomeProxy" }, klerosHomeProxyAbi, "handleRejectedRequest"),
  entry("klerosHomeProxy.reportArbitrationAnswer", { kind: "static", key: "klerosHomeProxy" }, klerosHomeProxyAbi, "reportArbitrationAnswer"),
];

const ALLOWLIST = new Map(TX_ALLOWLIST.map((item) => [item.id, item]));

export interface TxStep {
  /** Unique within the plan, e.g. "create", "split", "approve-yes", "mint-yes". */
  id: string;
  allowlistId: string;
  chainId: number;
  to: Address;
  data: Hex;
  /** Native value in wei. */
  value: bigint;
  /** The exact arguments `data` encodes (re-encoded by the verifier; also the source of any display). */
  args: readonly unknown[];
  /** Step ids that must be confirmed before this one is sent. */
  dependsOn: string[];
}

export interface TxPlan {
  version: 1;
  /** Idempotency key of the plan (uuid); the API persists the plan's state machine under it. */
  planId: string;
  chainId: number;
  /** The wallet that will send every step; recipients of funds must equal it. */
  account: Address;
  deploymentHash: Hex32;
  steps: TxStep[];
}

/** Registered markets the plan may reference, from the caller's own lookup (registry/read model/chain reads). */
export interface PlanContext {
  /** market (lowercase) -> wrapped outcome token addresses in outcome-index order (Yes, No, Invalid). */
  markets: ReadonlyMap<Address, readonly Address[]>;
  /** Reality question ids (lowercase) of registered claims (including reopened replacements). */
  questionIds: ReadonlySet<Hex32>;
}

export interface PlanLimits {
  /** Upper bound on the sum of native value over all steps (the user's spending limit). */
  maxTotalValueWei: bigint;
  /** Upper bound on every single approval amount. */
  maxApprovalAmount: bigint;
}

export class PlanVerificationError extends Error {
  constructor(readonly stepId: string | null, message: string) {
    super(stepId ? `step ${stepId}: ${message}` : message);
    this.name = "PlanVerificationError";
  }
}

const lower = (value: string): Address => value.toLowerCase() as Address;
const UINT128_MAX = (1n << 128n) - 1n;

function resolveStatic(manifest: DeploymentManifest, key: StaticTarget): Address {
  switch (key) {
    case "claimRegistry":
      return lower(manifest.pine.claimRegistry);
    case "evidenceRegistry":
      return lower(manifest.pine.evidenceRegistry);
    case "gnosisRouter":
      return lower(manifest.seer.gnosisRouter);
    case "collateralToken":
      return lower(manifest.seer.collateralToken);
    case "positionManager":
      return lower(manifest.amm.positionManager);
    case "realitio":
      return lower(manifest.seer.realitio);
    case "realityProxy":
      return lower(manifest.seer.realityProxy);
    case "klerosHomeProxy":
      return lower(manifest.kleros.homeProxy);
  }
}

function functionAbi(item: AllowlistEntry): AbiFunction {
  const found = item.abi.find((part): part is AbiFunction => part.type === "function" && part.name === item.functionName);
  if (!found) throw new Error(`Allowlist entry ${item.id} has no ABI for ${item.functionName}`);
  return found;
}

/** Builds one step. `to` is required only for outcome-token targets (validated by verifyPlan). */
export function buildStep(
  manifest: DeploymentManifest,
  input: { id: string; allowlistId: string; args: readonly unknown[]; value?: bigint; to?: Address; dependsOn?: string[] },
): TxStep {
  const item = ALLOWLIST.get(input.allowlistId);
  if (!item) throw new PlanVerificationError(input.id, `unknown allowlist id ${input.allowlistId}`);
  const to = item.target.kind === "static" ? resolveStatic(manifest, item.target.key) : input.to ? lower(input.to) : null;
  if (!to) throw new PlanVerificationError(input.id, "outcome-token steps need an explicit target");
  const data = encodeFunctionData({ abi: [functionAbi(item)], functionName: item.functionName, args: input.args as never });
  return { id: input.id, allowlistId: item.id, chainId: manifest.chainId, to, data, value: input.value ?? 0n, args: input.args, dependsOn: input.dependsOn ?? [] };
}

export function newPlan(manifest: DeploymentManifest, planId: string, account: Address, steps: TxStep[]): TxPlan {
  return { version: 1, planId, chainId: manifest.chainId, account: lower(account), deploymentHash: deploymentHash(manifest), steps };
}

interface Pull {
  token: Address;
  spender: Address;
  amount: bigint;
}

/** Throws PlanVerificationError on the first violation. Returns the total native value of the plan. */
export function verifyPlan(plan: TxPlan, manifest: DeploymentManifest, context: PlanContext, limits: PlanLimits): bigint {
  if (plan.version !== 1) throw new PlanVerificationError(null, "unsupported plan version");
  if (plan.chainId !== manifest.chainId) throw new PlanVerificationError(null, "plan chain does not match the deployment");
  if (plan.deploymentHash !== deploymentHash(manifest)) throw new PlanVerificationError(null, "plan was built for a different deployment manifest");
  if (plan.steps.length === 0 || plan.steps.length > 16) throw new PlanVerificationError(null, "a plan has 1..16 steps");
  const account = lower(plan.account);
  const collateral = lower(manifest.seer.collateralToken);
  const outcomeTokens = new Map<Address, Address>(); // token -> market
  for (const [market, tokens] of context.markets) for (const token of tokens) outcomeTokens.set(lower(token), lower(market));
  const seen = new Set<string>();
  const approvals: (Pull & { stepId: string; index: number })[] = [];
  const pulls: (Pull & { index: number })[] = [];
  let totalValue = 0n;

  plan.steps.forEach((step, index) => {
    if (seen.has(step.id)) throw new PlanVerificationError(step.id, "duplicate step id");
    for (const dependency of step.dependsOn) if (!seen.has(dependency)) throw new PlanVerificationError(step.id, `depends on unknown or later step ${dependency}`);
    seen.add(step.id);
    if (step.chainId !== manifest.chainId) throw new PlanVerificationError(step.id, "wrong chain");
    const item = ALLOWLIST.get(step.allowlistId);
    if (!item) throw new PlanVerificationError(step.id, "call is not on the allowlist");
    const to = lower(step.to);
    if (item.target.kind === "static") {
      if (to !== resolveStatic(manifest, item.target.key)) throw new PlanVerificationError(step.id, "target does not match the deployment manifest");
    } else if (!outcomeTokens.has(to)) {
      throw new PlanVerificationError(step.id, "target is not an outcome token of a registered market");
    }
    let expected: Hex;
    try {
      expected = encodeFunctionData({ abi: [functionAbi(item)], functionName: item.functionName, args: step.args as never });
    } catch {
      throw new PlanVerificationError(step.id, "arguments do not encode for the declared function");
    }
    if (expected.toLowerCase() !== step.data.toLowerCase()) throw new PlanVerificationError(step.id, "calldata does not match the declared function and arguments");
    if (item.value === "zero" && step.value !== 0n) throw new PlanVerificationError(step.id, "non-payable call carries value");
    if (item.value === "positive" && step.value <= 0n) throw new PlanVerificationError(step.id, "payable call needs a positive value");
    totalValue += step.value;

    const args = step.args;
    const requireMarket = (value: unknown): Address => {
      const market = lower(String(value));
      if (!context.markets.has(market)) throw new PlanVerificationError(step.id, "market is not a registered claim market");
      return market;
    };
    const requireQuestion = (value: unknown): void => {
      if (!context.questionIds.has(String(value).toLowerCase() as Hex32)) throw new PlanVerificationError(step.id, "question is not a registered claim question");
    };
    const outcomesOf = (market: Address): readonly Address[] => context.markets.get(market)!.map(lower);

    switch (item.id) {
      case "collateralToken.approve":
      case "outcomeToken.approve": {
        const spender = lower(String(args[0]));
        const amount = args[1] as bigint;
        const allowed = (item.spenders ?? []).map((key) => resolveStatic(manifest, key));
        if (!allowed.includes(spender)) throw new PlanVerificationError(step.id, "approval spender is not allowed");
        if (typeof amount !== "bigint" || amount <= 0n || amount > UINT128_MAX || amount > limits.maxApprovalAmount) {
          throw new PlanVerificationError(step.id, "approval amount must be positive, exact and within the limit");
        }
        approvals.push({ token: to, spender, amount, stepId: step.id, index });
        break;
      }
      case "gnosisRouter.splitFromBase":
        requireMarket(args[0]);
        break;
      case "gnosisRouter.splitPosition": {
        if (lower(String(args[0])) !== collateral) throw new PlanVerificationError(step.id, "split collateral must be the Seer collateral token");
        requireMarket(args[1]);
        pulls.push({ token: collateral, spender: to, amount: args[2] as bigint, index });
        break;
      }
      case "gnosisRouter.mergeToBase": {
        const market = requireMarket(args[0]);
        for (const token of outcomesOf(market)) pulls.push({ token, spender: to, amount: args[1] as bigint, index });
        break;
      }
      case "gnosisRouter.redeemToBase": {
        const market = requireMarket(args[0]);
        const indexes = args[1] as readonly bigint[];
        const amounts = args[2] as readonly bigint[];
        if (indexes.length !== amounts.length) throw new PlanVerificationError(step.id, "redeem indexes and amounts differ in length");
        const tokens = outcomesOf(market);
        indexes.forEach((outcome, position) => {
          const token = tokens[Number(outcome)];
          if (token === undefined) throw new PlanVerificationError(step.id, "redeem outcome index out of range");
          pulls.push({ token, spender: to, amount: amounts[position]!, index });
        });
        break;
      }
      case "positionManager.createAndInitializePoolIfNecessary": {
        const token0 = lower(String(args[0]));
        const token1 = lower(String(args[1]));
        if (!(token0 < token1)) throw new PlanVerificationError(step.id, "pool tokens must be sorted (token0 < token1)");
        const pair = [token0, token1];
        if (!pair.includes(collateral) || !pair.some((token) => outcomeTokens.has(token))) {
          throw new PlanVerificationError(step.id, "pools pair a registered outcome token with the Seer collateral");
        }
        break;
      }
      case "positionManager.mint": {
        const params = args[0] as { token0: string; token1: string; amount0Desired: bigint; amount1Desired: bigint; recipient: string };
        const token0 = lower(params.token0);
        const token1 = lower(params.token1);
        if (!(token0 < token1)) throw new PlanVerificationError(step.id, "mint tokens must be sorted (token0 < token1)");
        if (![token0, token1].includes(collateral) || ![token0, token1].some((token) => outcomeTokens.has(token))) {
          throw new PlanVerificationError(step.id, "positions pair a registered outcome token with the Seer collateral");
        }
        if (lower(params.recipient) !== account) throw new PlanVerificationError(step.id, "position recipient must be the plan account");
        if (params.amount0Desired > 0n) pulls.push({ token: token0, spender: to, amount: params.amount0Desired, index });
        if (params.amount1Desired > 0n) pulls.push({ token: token1, spender: to, amount: params.amount1Desired, index });
        break;
      }
      case "positionManager.collect": {
        const params = args[0] as { recipient: string };
        if (lower(params.recipient) !== account) throw new PlanVerificationError(step.id, "collect recipient must be the plan account");
        break;
      }
      case "realitio.submitAnswer":
      case "realitio.fundAnswerBounty":
      case "realitio.claimWinnings":
      case "klerosHomeProxy.handleNotifiedRequest":
      case "klerosHomeProxy.handleRejectedRequest":
      case "klerosHomeProxy.reportArbitrationAnswer":
        requireQuestion(args[0]);
        break;
      case "realitio.reopenQuestion":
        // The question being reopened (last argument) must be a registered claim question; Reality itself enforces
        // that the reopened content, arbitrator, timeout, opening time and min bond equal the original's.
        requireQuestion(args[7]);
        break;
      case "realityProxy.resolve":
        requireMarket(args[0]);
        break;
      default:
        break;
    }
  });

  // Exact approvals: each approval is consumed exactly by the pulls that follow it (same token and spender).
  const key = (token: Address, spender: Address) => `${token}|${spender}`;
  const approved = new Map<string, bigint>();
  for (const approval of approvals) approved.set(key(approval.token, approval.spender), (approved.get(key(approval.token, approval.spender)) ?? 0n) + approval.amount);
  const pulled = new Map<string, bigint>();
  for (const pull of pulls) {
    const k = key(pull.token, pull.spender);
    const precedingApproval = approvals.some((approval) => key(approval.token, approval.spender) === k && approval.index < pull.index);
    if (!precedingApproval) throw new PlanVerificationError(null, `a step pulls ${pull.token} without a preceding exact approval`);
    pulled.set(k, (pulled.get(k) ?? 0n) + pull.amount);
  }
  for (const [k, amount] of approved) {
    if (pulled.get(k) !== amount) throw new PlanVerificationError(null, "approval amount is not consumed exactly by the plan");
  }
  if (totalValue > limits.maxTotalValueWei) throw new PlanVerificationError(null, "plan value exceeds the spending limit");
  return totalValue;
}

/** Normalizes an address argument for display (EIP-55); never used for comparisons. */
export function displayAddress(address: string): string {
  return getAddress(address);
}
