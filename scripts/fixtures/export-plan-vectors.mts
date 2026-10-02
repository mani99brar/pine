// Plan vectors for the Gnosis fork e2e tests (docs/prd/PRD-06-assembly.md section 2).
//
//   pnpm --filter @pine/api exec node --import tsx ../../scripts/fixtures/export-plan-vectors.mts           write
//   pnpm --filter @pine/api exec node --import tsx ../../scripts/fixtures/export-plan-vectors.mts --check   compare
//
// Bootstrap without filesystem cheatcodes (contracts/foundry.toml keeps fs_permissions = []), in two generated files:
//   1. Every input is a constant below. They are emitted into contracts/test/e2e/generated/PlanInputs.sol first.
//   2. The probe test (contracts/test/e2e/E2EProbe.t.sol, imports only PlanInputs.sol) replays the exact fork sequence
//      of the e2e tests (deployer label and nonce, deploy the pair, createClaim, split) at block 48550000 and prints
//      the fork-dependent values; they are committed in scripts/fixtures/fork-observations.json.
//   3. This script reads the observations, builds the createClaim, commit, reveal and ladder funding plans with
//      @pine/shared/tx-plan (buildStep/newPlan/verifyPlan/planToWire) and writes scripts/fixtures/plan-vectors.json
//      plus contracts/test/e2e/generated/PlanVectors.sol, whose calldata the e2e tests replay byte for byte.
// --check regenerates all three files in memory and fails on any difference. Output is deterministic: sorted JSON keys,
// bigints as decimal strings, fixed plan ids, no clock and no randomness.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeploymentManifest, deploymentHash, GNOSIS_EXTERNAL } from "../../packages/shared/src/deployment.ts";
import { computeEvidenceCommitment } from "../../packages/shared/src/evidence.ts";
import { renderQuestion } from "../../packages/shared/src/question.ts";
import {
  buildStep,
  displayAddress,
  newPlan,
  planFromWire,
  planToWire,
  verifyPlan,
  type PlanContext,
  type TxPlan,
  type TxStep,
} from "../../packages/shared/src/tx-plan.ts";
import type { Address, Hex32 } from "../../packages/shared/src/types.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OBSERVATIONS_PATH = path.join(root, "scripts", "fixtures", "fork-observations.json");
const VECTORS_JSON_PATH = path.join(root, "scripts", "fixtures", "plan-vectors.json");
const INPUTS_SOL_PATH = path.join(root, "contracts", "test", "e2e", "generated", "PlanInputs.sol");
const VECTORS_SOL_PATH = path.join(root, "contracts", "test", "e2e", "generated", "PlanVectors.sol");

// ---------------------------------------------------------------------------------------------------------------
// Inputs (constants; emitted into PlanInputs.sol)
// ---------------------------------------------------------------------------------------------------------------

const sha256Of = (text: string): Hex32 => `0x${createHash("sha256").update(text, "utf8").digest("hex")}` as Hex32;

const FORK_BLOCK = 48_550_000n;
const CHAIN_ID = 100;
const DAY = 86_400n;

/** forge-std makeAddr labels; the probe observes the resulting addresses. */
const LABELS = {
  deployer: "pine-e2e-deployer",
  creator: "pine-e2e-creator",
  submitter: "pine-e2e-submitter",
  funder: "pine-e2e-funder",
} as const;

interface ClaimInput {
  /** Preimage (UTF-8) of the claim-document digest; the digest itself is what the contracts see. */
  claimDocumentPreimage: string;
  claimDocumentSha256: Hex32;
  policyDocumentSha256: Hex32;
  repositoryId: bigint;
  /** 40 lowercase hex characters, no 0x. */
  commit: string;
  /** evidenceDeadline = fork timestamp + evidenceWindow (ADR-0001 default 7 days). */
  evidenceWindow: bigint;
  /** revealDeadline = evidenceDeadline + revealWindow (ADR-0001: 48 h). */
  revealWindow: bigint;
  /** Reality min bond in wei (ADR-0001 default 10 xDAI). */
  minBond: bigint;
  title: string;
}

const POLICY_SHA256 = sha256Of("pine e2e policy text v1");

/**
 * Scenario A is the full lifecycle claim. Scenario B is a second claim whose YES token sorts on the other side of sDAI,
 * covering the other ladder orientation. Its digest preimage ends in a probe counter: the first value, 0, already gives
 * the other orientation at block 48550000 (the probe test asserts both orientations are covered).
 */
const CLAIM_PREIMAGE_A = "pine e2e claim document A";
const CLAIM_PREIMAGE_B = "pine e2e claim document B 0";

const CLAIMS = {
  a: {
    claimDocumentPreimage: CLAIM_PREIMAGE_A,
    claimDocumentSha256: sha256Of(CLAIM_PREIMAGE_A),
    policyDocumentSha256: POLICY_SHA256,
    repositoryId: 427_016_914n,
    commit: "3f2a9c41d07e5b86a1c4e2f09b7d3a5c8e1f6b20",
    evidenceWindow: 7n * DAY,
    revealWindow: 2n * DAY,
    minBond: 10n * 10n ** 18n,
    title: "Pine e2e: evidence registry accepts reveals only from the submitter",
  },
  b: {
    claimDocumentPreimage: CLAIM_PREIMAGE_B,
    claimDocumentSha256: sha256Of(CLAIM_PREIMAGE_B),
    policyDocumentSha256: POLICY_SHA256,
    repositoryId: 427_016_914n,
    commit: "3f2a9c41d07e5b86a1c4e2f09b7d3a5c8e1f6b20",
    evidenceWindow: 7n * DAY,
    revealWindow: 2n * DAY,
    minBond: 10n * 10n ** 18n,
    title: "Pine e2e: second orientation of the YES ladder",
  },
} as const satisfies Record<string, ClaimInput>;

type ScenarioKey = keyof typeof CLAIMS;
const SCENARIOS: readonly ScenarioKey[] = ["a", "b"];

/** Evidence of scenario A. Fixed for reproducible vectors only: real salts are 32 random bytes kept by the client. */
const EVIDENCE_CONTENT_SHA256 = sha256Of("pine e2e evidence manifest");
const EVIDENCE_SALT = sha256Of("pine e2e evidence salt (vector only, never reuse)");
/** The commit is the first submission of a freshly deployed EvidenceRegistry. */
const EVIDENCE_SUBMISSION_ID = 1n;

/** Ladder funding (PRD-04 section 3.2): xDAI budget split into complete sets, YES sold over [lower, upper]. */
const FUNDING_BUDGET_WEI = 10n * 10n ** 18n;
/** Tick spacing of new Algebra pools on Gnosis. */
const TICK_SPACING = 60n;
/**
 * The ladder's bounds as ticks of the YES price in sDAI (price = 1.0001^tick), chosen at exact multiples of the spacing:
 * lowerPrice = 1.0001^-16080 ~ 0.2003 and upperPrice = 1.0001^-1080 ~ 0.8977 sDAI per YES (inside 0.01..0.95).
 */
const YES_PRICE_TICK_LOWER = -16_080n;
const YES_PRICE_TICK_UPPER = -1_080n;
/** S = shares - ceil(shares * 10 / 10000): margin for sDAI interest between plan and execution (PRD-04 3.2 step 2). */
const SHARE_MARGIN_BPS = 10n;
/** amountMin of the YES side = S - S * 50 / 10000 (PRD-04 3.2 step 5). */
const MINT_SLIPPAGE_BPS = 50n;
/** Mint deadline = fork timestamp + 20 minutes (PRD-04 3.2 step 5); the test mints before any warp. */
const MINT_DEADLINE_OFFSET = 1_200n;

const PLAN_IDS = {
  createClaimA: "vector-create-claim-a",
  commitA: "vector-commit-a",
  revealA: "vector-reveal-a",
  fundingA: "vector-funding-a",
  createClaimB: "vector-create-claim-b",
  fundingB: "vector-funding-b",
} as const;

// ---------------------------------------------------------------------------------------------------------------
// TickMath (BigInt port of Uniswap v3 / Algebra V1.9 TickMath.getSqrtRatioAtTick, identical constants)
// ---------------------------------------------------------------------------------------------------------------

const MIN_TICK = -887_272n;
const MAX_TICK = 887_272n;
const MAX_UINT256 = (1n << 256n) - 1n;
const Q96 = 1n << 96n;
const WAD = 10n ** 18n;

const TICK_FACTORS: readonly (readonly [bigint, bigint])[] = [
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

/** sqrt(1.0001^tick) * 2^96 rounded up, exactly as the Solidity library computes it (uint160). */
function getSqrtRatioAtTick(tick: bigint): bigint {
  const absTick = tick < 0n ? -tick : tick;
  if (absTick > MAX_TICK) throw new Error(`tick ${tick} out of range`);
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, factor] of TICK_FACTORS) if ((absTick & bit) !== 0n) ratio = (ratio * factor) >> 128n;
  if (tick > 0n) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

// Self-test against the library's documented bounds before anything is derived from the port.
if (getSqrtRatioAtTick(MIN_TICK) !== 4_295_128_739n) throw new Error("TickMath port: MIN_SQRT_RATIO mismatch");
if (getSqrtRatioAtTick(MAX_TICK) !== 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n) {
  throw new Error("TickMath port: MAX_SQRT_RATIO mismatch");
}
if (getSqrtRatioAtTick(0n) !== Q96) throw new Error("TickMath port: tick 0 mismatch");

/** price (token1 per token0) of a sqrt price, as an 18-decimal fixed-point integer, rounded down. Display only. */
const priceWad = (sqrtPriceX96: bigint): bigint => (sqrtPriceX96 * sqrtPriceX96 * WAD) >> 192n;

// ---------------------------------------------------------------------------------------------------------------
// Observations (scripts/fixtures/fork-observations.json, captured by the probe test)
// ---------------------------------------------------------------------------------------------------------------

interface ScenarioObservation {
  market: Address;
  yesToken: Address;
  noToken: Address;
  invalidToken: Address;
  questionId: Hex32;
  conditionId: Hex32;
  /** sDAI shares (= YES minted) by GnosisRouter.splitFromBase{value: FUNDING_BUDGET_WEI} right after createClaim. */
  sdaiShares: bigint;
  /** AlgebraFactory.poolByPair(yesToken, sDAI) before funding (zero: the pool does not exist yet). */
  yesPoolBefore: Address;
}

interface Observations {
  chainId: number;
  forkBlock: bigint;
  blockTimestamp: bigint;
  deployer: Address;
  deployerNonce: bigint;
  evidenceRegistry: Address;
  claimRegistry: Address;
  creator: Address;
  submitter: Address;
  funder: Address;
  scenarios: Record<ScenarioKey, ScenarioObservation>;
}

function fail(message: string): never {
  throw new Error(`fork-observations.json: ${message}`);
}
function field(object: unknown, key: string): unknown {
  if (typeof object !== "object" || object === null || Array.isArray(object)) fail(`expected an object around "${key}"`);
  if (!(key in object)) fail(`missing "${key}"`);
  return (object as Record<string, unknown>)[key];
}
function address(object: unknown, key: string): Address {
  const value = field(object, key);
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value)) fail(`"${key}" must be a lowercase address`);
  return value as Address;
}
function hex32(object: unknown, key: string): Hex32 {
  const value = field(object, key);
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) fail(`"${key}" must be lowercase 32-byte hex`);
  return value as Hex32;
}
function uint(object: unknown, key: string): bigint {
  const value = field(object, key);
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value)) fail(`"${key}" must be a decimal string`);
  return BigInt(value);
}
function exactKeys(object: unknown, keys: readonly string[], where: string): void {
  if (typeof object !== "object" || object === null) fail(`${where} must be an object`);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.join(",") !== expected.join(",")) fail(`${where} keys must be exactly ${expected.join(", ")}`);
}

const SCENARIO_KEYS = ["market", "yesToken", "noToken", "invalidToken", "questionId", "conditionId", "sdaiShares", "yesPoolBefore"];
const TOP_KEYS = ["chainId", "forkBlock", "blockTimestamp", "deployer", "deployerNonce", "evidenceRegistry", "claimRegistry", "creator", "submitter", "funder", "scenarios"];

function parseObservations(json: unknown): Observations {
  exactKeys(json, TOP_KEYS, "root");
  const chainId = field(json, "chainId");
  if (chainId !== CHAIN_ID) fail("chainId must be 100");
  const scenariosJson = field(json, "scenarios");
  exactKeys(scenariosJson, SCENARIOS, "scenarios");
  const scenario = (key: ScenarioKey): ScenarioObservation => {
    const s = field(scenariosJson, key);
    exactKeys(s, SCENARIO_KEYS, `scenarios.${key}`);
    return {
      market: address(s, "market"),
      yesToken: address(s, "yesToken"),
      noToken: address(s, "noToken"),
      invalidToken: address(s, "invalidToken"),
      questionId: hex32(s, "questionId"),
      conditionId: hex32(s, "conditionId"),
      sdaiShares: uint(s, "sdaiShares"),
      yesPoolBefore: address(s, "yesPoolBefore"),
    };
  };
  const observations: Observations = {
    chainId: CHAIN_ID,
    forkBlock: uint(json, "forkBlock"),
    blockTimestamp: uint(json, "blockTimestamp"),
    deployer: address(json, "deployer"),
    deployerNonce: uint(json, "deployerNonce"),
    evidenceRegistry: address(json, "evidenceRegistry"),
    claimRegistry: address(json, "claimRegistry"),
    creator: address(json, "creator"),
    submitter: address(json, "submitter"),
    funder: address(json, "funder"),
    scenarios: { a: scenario("a"), b: scenario("b") },
  };
  if (observations.forkBlock !== FORK_BLOCK) fail(`forkBlock must be ${FORK_BLOCK}`);
  return observations;
}

// ---------------------------------------------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------------------------------------------

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const collateral = GNOSIS_EXTERNAL.seer.collateralToken.toLowerCase() as Address;
const positionManager = GNOSIS_EXTERNAL.amm.positionManager.toLowerCase() as Address;

interface ClaimTimes {
  evidenceDeadline: bigint;
  revealDeadline: bigint;
}

function claimTimes(input: ClaimInput, forkTimestamp: bigint): ClaimTimes {
  const evidenceDeadline = forkTimestamp + input.evidenceWindow;
  return { evidenceDeadline, revealDeadline: evidenceDeadline + input.revealWindow };
}

function createClaimArgs(input: ClaimInput, times: ClaimTimes) {
  return {
    claimDocumentSha256: input.claimDocumentSha256,
    policyDocumentSha256: input.policyDocumentSha256,
    repositoryId: input.repositoryId,
    commit: `0x${input.commit}` as `0x${string}`,
    evidenceDeadline: times.evidenceDeadline,
    revealDeadline: times.revealDeadline,
    minBond: input.minBond,
    title: input.title,
  };
}

interface Ladder {
  yesIsToken0: boolean;
  token0: Address;
  token1: Address;
  /** Pool ticks in the pool's own orientation (token1 per token0). */
  tickLower: bigint;
  tickUpper: bigint;
  /** Initial pool price, strictly outside the range so the position holds only YES (PRD-04 3.2 step 3/4). */
  initSqrtPriceX96: bigint;
  /** S: the exact approval and the YES-side amountDesired. */
  mintAmount: bigint;
  mintAmountMin: bigint;
  mintDeadline: bigint;
  /** Display only (18 decimals, rounded down): ladder bounds in sDAI per YES, and the max loss if YES resolves. */
  yesLowerPriceWad: bigint;
  yesUpperPriceWad: bigint;
  maxLossIfYesShares: bigint;
}

function ladderFor(observation: ScenarioObservation, forkTimestamp: bigint): Ladder {
  if (YES_PRICE_TICK_LOWER % TICK_SPACING !== 0n || YES_PRICE_TICK_UPPER % TICK_SPACING !== 0n) throw new Error("ticks must be multiples of the spacing");
  if (!(YES_PRICE_TICK_LOWER < YES_PRICE_TICK_UPPER)) throw new Error("lower tick must be below the upper tick");
  const yes = observation.yesToken;
  const yesIsToken0 = yes < collateral;
  const shares = observation.sdaiShares;
  const margin = (shares * SHARE_MARGIN_BPS + 9_999n) / 10_000n; // ceil(shares * 10 / 10000)
  const mintAmount = shares - margin;
  const mintAmountMin = mintAmount - (mintAmount * MINT_SLIPPAGE_BPS) / 10_000n;
  // YES = token0: pool price = sDAI per YES, range above the current price, initialised just below tickLower.
  // YES = token1: pool price = YES per sDAI = 1 / (sDAI per YES), so the range is the negated, swapped tick pair and the
  // pool is initialised just above tickUpper. Either way the current price lies outside the range on the side where the
  // position is made of YES only (single-sided), and YES is cheaper than lowerPrice.
  const tickLower = yesIsToken0 ? YES_PRICE_TICK_LOWER : -YES_PRICE_TICK_UPPER;
  const tickUpper = yesIsToken0 ? YES_PRICE_TICK_UPPER : -YES_PRICE_TICK_LOWER;
  const initSqrtPriceX96 = yesIsToken0 ? getSqrtRatioAtTick(tickLower) - 1n : getSqrtRatioAtTick(tickUpper) + 1n;
  const sqrtLower = getSqrtRatioAtTick(YES_PRICE_TICK_LOWER);
  const sqrtUpper = getSqrtRatioAtTick(YES_PRICE_TICK_UPPER);
  // Max loss if YES resolves = S * (1 - sqrt(lower * upper)) (PRD-04 3.2 step 6), in sDAI shares, before fees.
  const sqrtProductWad = (sqrtLower * sqrtUpper * WAD) >> 192n;
  return {
    yesIsToken0,
    token0: yesIsToken0 ? yes : collateral,
    token1: yesIsToken0 ? collateral : yes,
    tickLower,
    tickUpper,
    initSqrtPriceX96,
    mintAmount,
    mintAmountMin,
    mintDeadline: forkTimestamp + MINT_DEADLINE_OFFSET,
    yesLowerPriceWad: priceWad(sqrtLower),
    yesUpperPriceWad: priceWad(sqrtUpper),
    maxLossIfYesShares: mintAmount - (mintAmount * sqrtProductWad) / WAD,
  };
}

function fundingSteps(manifest: ReturnType<typeof buildDeploymentManifest>, observation: ScenarioObservation, ladder: Ladder, funder: Address): TxStep[] {
  if (observation.yesPoolBefore !== ZERO_ADDRESS) throw new Error("the vectors assume the YES/sDAI pool does not exist yet");
  return [
    buildStep(manifest, { id: "split", allowlistId: "gnosisRouter.splitFromBase", args: [observation.market], value: FUNDING_BUDGET_WEI }),
    buildStep(manifest, { id: "approve-yes", allowlistId: "outcomeToken.approve", to: observation.yesToken, args: [positionManager, ladder.mintAmount], dependsOn: ["split"] }),
    buildStep(manifest, { id: "create-pool", allowlistId: "positionManager.createAndInitializePoolIfNecessary", args: [ladder.token0, ladder.token1, ladder.initSqrtPriceX96] }),
    buildStep(manifest, {
      id: "mint-yes",
      allowlistId: "positionManager.mint",
      args: [
        {
          token0: ladder.token0,
          token1: ladder.token1,
          tickLower: Number(ladder.tickLower),
          tickUpper: Number(ladder.tickUpper),
          amount0Desired: ladder.yesIsToken0 ? ladder.mintAmount : 0n,
          amount1Desired: ladder.yesIsToken0 ? 0n : ladder.mintAmount,
          amount0Min: ladder.yesIsToken0 ? ladder.mintAmountMin : 0n,
          amount1Min: ladder.yesIsToken0 ? 0n : ladder.mintAmountMin,
          recipient: funder,
          deadline: ladder.mintDeadline,
        },
      ],
      dependsOn: ["approve-yes", "create-pool"],
    }),
  ];
}

interface Built {
  manifest: ReturnType<typeof buildDeploymentManifest>;
  plans: Record<string, TxPlan>;
  times: Record<ScenarioKey, ClaimTimes>;
  ladders: Record<ScenarioKey, Ladder>;
  questions: Record<ScenarioKey, string>;
  commitment: Hex32;
}

function build(observations: Observations): Built {
  const manifest = buildDeploymentManifest({
    claimRegistry: observations.claimRegistry,
    evidenceRegistry: observations.evidenceRegistry,
    deploymentBlock: observations.forkBlock,
  });
  // Scenarios A and B run in separate fork worlds from the same factory nonce, so they may share the market address:
  // each plan is verified against the registered markets of its own world only.
  const contextOf = (key: ScenarioKey): PlanContext => {
    const s = observations.scenarios[key];
    return { markets: new Map([[s.market, [s.yesToken, s.noToken, s.invalidToken]]]), questionIds: new Set([s.questionId]) };
  };
  const ts = observations.blockTimestamp;
  const times = { a: claimTimes(CLAIMS.a, ts), b: claimTimes(CLAIMS.b, ts) };
  const ladders = { a: ladderFor(observations.scenarios.a, ts), b: ladderFor(observations.scenarios.b, ts) };
  if (ladders.a.yesIsToken0 === ladders.b.yesIsToken0) throw new Error("scenarios a and b must cover both YES/sDAI orientations");
  const questions = {
    a: question(CLAIMS.a, times.a, observations.evidenceRegistry),
    b: question(CLAIMS.b, times.b, observations.evidenceRegistry),
  };
  const commitment = computeEvidenceCommitment({
    chainId: CHAIN_ID,
    registry: observations.evidenceRegistry,
    market: observations.scenarios.a.market,
    submitter: observations.submitter,
    contentSha256: EVIDENCE_CONTENT_SHA256,
    salt: EVIDENCE_SALT,
  });

  const create = (key: ScenarioKey) =>
    buildStep(manifest, { id: "create", allowlistId: "claimRegistry.createClaim", args: [createClaimArgs(CLAIMS[key], times[key])] });
  const plans: Record<string, TxPlan> = {
    [PLAN_IDS.createClaimA]: newPlan(manifest, PLAN_IDS.createClaimA, observations.creator, [create("a")]),
    [PLAN_IDS.commitA]: newPlan(manifest, PLAN_IDS.commitA, observations.submitter, [
      buildStep(manifest, { id: "commit", allowlistId: "evidenceRegistry.commitEvidence", args: [observations.scenarios.a.market, commitment] }),
    ]),
    [PLAN_IDS.revealA]: newPlan(manifest, PLAN_IDS.revealA, observations.submitter, [
      buildStep(manifest, { id: "reveal", allowlistId: "evidenceRegistry.revealEvidence", args: [EVIDENCE_SUBMISSION_ID, EVIDENCE_CONTENT_SHA256, EVIDENCE_SALT] }),
    ]),
    [PLAN_IDS.fundingA]: newPlan(manifest, PLAN_IDS.fundingA, observations.funder, fundingSteps(manifest, observations.scenarios.a, ladders.a, observations.funder)),
    [PLAN_IDS.createClaimB]: newPlan(manifest, PLAN_IDS.createClaimB, observations.creator, [create("b")]),
    [PLAN_IDS.fundingB]: newPlan(manifest, PLAN_IDS.fundingB, observations.funder, fundingSteps(manifest, observations.scenarios.b, ladders.b, observations.funder)),
  };

  // Every plan passes the frozen verifier, also after a wire round trip (what a client would receive).
  const scenarioOf: Record<string, ScenarioKey> = {
    [PLAN_IDS.createClaimA]: "a",
    [PLAN_IDS.commitA]: "a",
    [PLAN_IDS.revealA]: "a",
    [PLAN_IDS.fundingA]: "a",
    [PLAN_IDS.createClaimB]: "b",
    [PLAN_IDS.fundingB]: "b",
  };
  for (const [planId, plan] of Object.entries(plans)) {
    const key = scenarioOf[planId];
    if (key === undefined) throw new Error(`no scenario for ${planId}`);
    const isFunding = planId === PLAN_IDS.fundingA || planId === PLAN_IDS.fundingB;
    const limits = {
      maxTotalValueWei: isFunding ? FUNDING_BUDGET_WEI : 0n,
      maxApprovalAmount: isFunding ? ladders[key].mintAmount : 0n,
    };
    const context = contextOf(key);
    const value = verifyPlan(plan, manifest, context, limits);
    if (value !== limits.maxTotalValueWei) throw new Error(`${planId}: unexpected plan value ${value}`);
    verifyPlan(planFromWire(JSON.parse(JSON.stringify(planToWire(plan)))), manifest, context, limits);
  }
  return { manifest, plans, times, ladders, questions, commitment };
}

function question(input: ClaimInput, times: ClaimTimes, evidenceRegistry: Address): string {
  return renderQuestion({
    evidenceRegistry,
    title: input.title,
    evidenceDeadline: Number(times.evidenceDeadline),
    revealDeadline: Number(times.revealDeadline),
    repositoryId: Number(input.repositoryId),
    commit: input.commit,
    claimDocumentSha256: input.claimDocumentSha256,
    policyDocumentSha256: input.policyDocumentSha256,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------------------------------------------

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function toJson(value: unknown): Json {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) out[key] = toJson((value as Record<string, unknown>)[key]);
    return out;
  }
  throw new Error(`cannot serialise ${typeof value}`);
}

const stringify = (value: unknown): string => `${JSON.stringify(toJson(value), null, 2)}\n`;

const solAddress = (value: string): string => displayAddress(value);
const solHex = (value: string): string => {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error("not hex bytes");
  return `hex"${value.slice(2).toLowerCase()}"`;
};
const solString = (value: string): string => {
  // Only printable ASCII without '"' and '\' is emitted as a plain literal (claim titles and questions satisfy this).
  if (!/^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/.test(value)) throw new Error(`refusing to emit a string literal with unsafe bytes: ${value}`);
  return `"${value}"`;
};
const solInt = (value: bigint): string => {
  const digits = (value < 0n ? -value : value).toString(10).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  return value < 0n ? `-${digits}` : digits;
};

const HEADER = (source: string) =>
  `// SPDX-License-Identifier: MIT\n// GENERATED by scripts/fixtures/export-plan-vectors.mts${source}. Do not edit; regenerate with\n` +
  `// \`pnpm --filter @pine/api exec node --import tsx ../../scripts/fixtures/export-plan-vectors.mts\`.\npragma solidity 0.8.37;\n`;

function emitInputs(): string {
  const lines: string[] = [HEADER(" from its constants"), "/// @notice Inputs of the plan vectors (constants of the vector script). The probe test imports only this file.", "library PlanInputs {"];
  const c = (decl: string, comment?: string) => {
    if (comment) lines.push(`    /// ${comment}`);
    lines.push(`    ${decl};`);
  };
  c(`uint256 internal constant FORK_BLOCK = ${solInt(FORK_BLOCK)}`);
  c(`uint256 internal constant CHAIN_ID = ${CHAIN_ID}`);
  c(`string internal constant DEPLOYER_LABEL = ${solString(LABELS.deployer)}`, "forge-std makeAddr labels of the deployer and the plan accounts.");
  c(`string internal constant CREATOR_LABEL = ${solString(LABELS.creator)}`);
  c(`string internal constant SUBMITTER_LABEL = ${solString(LABELS.submitter)}`);
  c(`string internal constant FUNDER_LABEL = ${solString(LABELS.funder)}`);
  for (const key of SCENARIOS) {
    const claim = CLAIMS[key];
    const p = key.toUpperCase();
    lines.push("", `    // Claim ${p}: deadlines are the fork timestamp + EVIDENCE_WINDOW and the evidence deadline + REVEAL_WINDOW.`);
    c(`bytes32 internal constant ${p}_CLAIM_DOCUMENT_SHA256 = ${claim.claimDocumentSha256}`, `sha256(${JSON.stringify(claim.claimDocumentPreimage)})`);
    c(`bytes32 internal constant ${p}_POLICY_DOCUMENT_SHA256 = ${claim.policyDocumentSha256}`);
    c(`uint64 internal constant ${p}_REPOSITORY_ID = ${solInt(claim.repositoryId)}`);
    c(`bytes20 internal constant ${p}_COMMIT = bytes20(hex"${claim.commit}")`);
    c(`uint64 internal constant ${p}_EVIDENCE_WINDOW = ${solInt(claim.evidenceWindow)}`);
    c(`uint64 internal constant ${p}_REVEAL_WINDOW = ${solInt(claim.revealWindow)}`);
    c(`uint256 internal constant ${p}_MIN_BOND = ${solInt(claim.minBond)}`);
    c(`string internal constant ${p}_TITLE = ${solString(claim.title)}`);
  }
  lines.push("", "    // Evidence of claim A (fixed salt for reproducible vectors only).");
  c(`bytes32 internal constant EVIDENCE_CONTENT_SHA256 = ${EVIDENCE_CONTENT_SHA256}`);
  c(`bytes32 internal constant EVIDENCE_SALT = ${EVIDENCE_SALT}`);
  c(`uint256 internal constant EVIDENCE_SUBMISSION_ID = ${EVIDENCE_SUBMISSION_ID}`);
  lines.push("", "    // Ladder funding (PRD-04 section 3.2).");
  c(`uint256 internal constant FUNDING_BUDGET_WEI = ${solInt(FUNDING_BUDGET_WEI)}`);
  c(`int24 internal constant TICK_SPACING = ${TICK_SPACING}`);
  c(`int24 internal constant YES_PRICE_TICK_LOWER = ${solInt(YES_PRICE_TICK_LOWER)}`, "Ladder bounds as ticks of the YES price in sDAI: 1.0001^-16080 ~ 0.2003, 1.0001^-1080 ~ 0.8977.");
  c(`int24 internal constant YES_PRICE_TICK_UPPER = ${solInt(YES_PRICE_TICK_UPPER)}`);
  c(`uint256 internal constant SHARE_MARGIN_BPS = ${SHARE_MARGIN_BPS}`);
  c(`uint256 internal constant MINT_SLIPPAGE_BPS = ${MINT_SLIPPAGE_BPS}`);
  c(`uint256 internal constant MINT_DEADLINE_OFFSET = ${solInt(MINT_DEADLINE_OFFSET)}`);
  lines.push("");
  for (const [name, id] of Object.entries(PLAN_IDS)) {
    const constant = name.replace(/([A-Z])/g, "_$1").toUpperCase();
    c(`string internal constant PLAN_ID_${constant} = ${solString(id)}`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

function emitPlan(name: string, plan: TxPlan): string[] {
  const lines = [
    `    function ${name}() internal pure returns (VectorPlan memory plan) {`,
    `        plan.planId = ${solString(plan.planId)};`,
    `        plan.account = ${solAddress(plan.account)};`,
    `        plan.steps = new VectorStep[](${plan.steps.length});`,
  ];
  plan.steps.forEach((step, index) => {
    lines.push(
      `        plan.steps[${index}] = VectorStep({`,
      `            id: ${solString(step.id)},`,
      `            allowlistId: ${solString(step.allowlistId)},`,
      `            to: ${solAddress(step.to)},`,
      `            value: ${solInt(step.value)},`,
      `            data: ${solHex(step.data)}`,
      `        });`,
    );
  });
  lines.push("    }");
  return lines;
}

function emitVectors(observations: Observations, built: Built): string {
  const lines: string[] = [
    HEADER(" from scripts/fixtures/fork-observations.json"),
    "/// @notice One transaction of a plan: the e2e tests send `data` with `value` to `to` from the plan account.",
    "struct VectorStep {",
    "    string id;",
    "    string allowlistId;",
    "    address to;",
    "    uint256 value;",
    "    bytes data;",
    "}",
    "",
    "struct VectorPlan {",
    "    string planId;",
    "    address account;",
    "    VectorStep[] steps;",
    "}",
    "",
    "/// @notice Fork observations (block 48550000) and the calldata packages/shared/src/tx-plan.ts built from them.",
    "library PlanVectors {",
  ];
  const c = (decl: string, comment?: string) => {
    if (comment) lines.push(`    /// ${comment}`);
    lines.push(`    ${decl};`);
  };
  c(`uint256 internal constant FORK_BLOCK = ${solInt(observations.forkBlock)}`);
  c(`uint256 internal constant FORK_TIMESTAMP = ${solInt(observations.blockTimestamp)}`);
  c(`address internal constant DEPLOYER = ${solAddress(observations.deployer)}`);
  c(`uint64 internal constant DEPLOYER_NONCE = ${solInt(observations.deployerNonce)}`);
  c(`address internal constant EVIDENCE_REGISTRY = ${solAddress(observations.evidenceRegistry)}`);
  c(`address internal constant CLAIM_REGISTRY = ${solAddress(observations.claimRegistry)}`);
  c(`address internal constant CREATOR = ${solAddress(observations.creator)}`);
  c(`address internal constant SUBMITTER = ${solAddress(observations.submitter)}`);
  c(`address internal constant FUNDER = ${solAddress(observations.funder)}`);
  c(`bytes32 internal constant DEPLOYMENT_HASH = ${deploymentHash(built.manifest)}`, "deploymentHash of the manifest the plans were built for.");
  c(`bytes32 internal constant EVIDENCE_COMMITMENT = ${built.commitment}`, "computeEvidenceCommitment of claim A's evidence (TypeScript).");
  for (const key of SCENARIOS) {
    const s = observations.scenarios[key];
    const t = built.times[key];
    const l = built.ladders[key];
    const p = key.toUpperCase();
    lines.push("", `    // Scenario ${p}: YES is token${l.yesIsToken0 ? "0" : "1"} of the YES/sDAI pool.`);
    c(`address internal constant ${p}_MARKET = ${solAddress(s.market)}`);
    c(`address internal constant ${p}_YES_TOKEN = ${solAddress(s.yesToken)}`);
    c(`address internal constant ${p}_NO_TOKEN = ${solAddress(s.noToken)}`);
    c(`address internal constant ${p}_INVALID_TOKEN = ${solAddress(s.invalidToken)}`);
    c(`bytes32 internal constant ${p}_QUESTION_ID = ${s.questionId}`);
    c(`bytes32 internal constant ${p}_CONDITION_ID = ${s.conditionId}`);
    c(`uint256 internal constant ${p}_SDAI_SHARES = ${solInt(s.sdaiShares)}`);
    c(`uint64 internal constant ${p}_EVIDENCE_DEADLINE = ${solInt(t.evidenceDeadline)}`);
    c(`uint64 internal constant ${p}_REVEAL_DEADLINE = ${solInt(t.revealDeadline)}`);
    c(`string internal constant ${p}_QUESTION = ${solString(built.questions[key])}`, "renderQuestion() of the TypeScript twin (packages/shared/src/question.ts) for this claim.");
    c(`bool internal constant ${p}_YES_IS_TOKEN0 = ${l.yesIsToken0}`);
    c(`address internal constant ${p}_TOKEN0 = ${solAddress(l.token0)}`);
    c(`address internal constant ${p}_TOKEN1 = ${solAddress(l.token1)}`);
    c(`int24 internal constant ${p}_TICK_LOWER = ${solInt(l.tickLower)}`);
    c(`int24 internal constant ${p}_TICK_UPPER = ${solInt(l.tickUpper)}`);
    c(`uint160 internal constant ${p}_INIT_SQRT_PRICE_X96 = ${solInt(l.initSqrtPriceX96)}`);
    c(`uint256 internal constant ${p}_MINT_AMOUNT = ${solInt(l.mintAmount)}`);
    c(`uint256 internal constant ${p}_MINT_AMOUNT_MIN = ${solInt(l.mintAmountMin)}`);
    c(`uint256 internal constant ${p}_MINT_DEADLINE = ${solInt(l.mintDeadline)}`);
  }
  const fns: [string, string][] = [
    ["planACreateClaim", PLAN_IDS.createClaimA],
    ["planACommit", PLAN_IDS.commitA],
    ["planAReveal", PLAN_IDS.revealA],
    ["planAFunding", PLAN_IDS.fundingA],
    ["planBCreateClaim", PLAN_IDS.createClaimB],
    ["planBFunding", PLAN_IDS.fundingB],
  ];
  for (const [name, planId] of fns) {
    const plan = built.plans[planId];
    if (!plan) throw new Error(`missing plan ${planId}`);
    lines.push("", ...emitPlan(name, plan));
  }
  lines.push("}", "");
  return lines.join("\n");
}

function emitVectorsJson(observations: Observations, built: Built): string {
  const scenarios: Record<string, unknown> = {};
  for (const key of SCENARIOS) {
    const claim = CLAIMS[key];
    scenarios[key] = {
      claim: { ...claim, ...built.times[key], question: built.questions[key] },
      ladder: { ...built.ladders[key], yesPriceTickLower: YES_PRICE_TICK_LOWER, yesPriceTickUpper: YES_PRICE_TICK_UPPER, tickSpacing: TICK_SPACING },
    };
  }
  return stringify({
    generator: "scripts/fixtures/export-plan-vectors.mts",
    inputs: {
      labels: LABELS,
      evidence: { contentSha256: EVIDENCE_CONTENT_SHA256, salt: EVIDENCE_SALT, submissionId: EVIDENCE_SUBMISSION_ID },
      funding: { budgetWei: FUNDING_BUDGET_WEI, shareMarginBps: SHARE_MARGIN_BPS, mintSlippageBps: MINT_SLIPPAGE_BPS, mintDeadlineOffset: MINT_DEADLINE_OFFSET },
      planIds: PLAN_IDS,
    },
    observations,
    manifest: built.manifest,
    deploymentHash: deploymentHash(built.manifest),
    evidenceCommitment: built.commitment,
    scenarios,
    plans: Object.fromEntries(Object.entries(built.plans).map(([planId, plan]) => [planId, planToWire(plan)])),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------

const check = process.argv.includes("--check");
const outputs: [string, string][] = [[INPUTS_SOL_PATH, emitInputs()]];
if (existsSync(OBSERVATIONS_PATH)) {
  const observations = parseObservations(JSON.parse(readFileSync(OBSERVATIONS_PATH, "utf8")));
  const built = build(observations);
  outputs.push([VECTORS_JSON_PATH, emitVectorsJson(observations, built)], [VECTORS_SOL_PATH, emitVectors(observations, built)]);
} else if (check) {
  console.error("scripts/fixtures/fork-observations.json is missing; run the probe test and commit its observations.");
  process.exit(1);
} else {
  console.log("No fork observations yet: writing PlanInputs.sol only (run the probe next).");
}

let stale = 0;
for (const [file, text] of outputs) {
  const relative = path.relative(root, file);
  if (check) {
    const current = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (current !== text) {
      stale += 1;
      console.error(`${relative} is out of date with scripts/fixtures/export-plan-vectors.mts`);
    } else {
      console.log(`${relative} is up to date`);
    }
  } else {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`Wrote ${relative}`);
  }
}
if (stale > 0) process.exit(1);
