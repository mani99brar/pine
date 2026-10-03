import { describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import { erc20Abi } from "./abi/external.js";
import { GNOSIS_EXTERNAL, type DeploymentManifest } from "./deployment.js";
import { buildStep, newPlan, planFromWire, planToWire, PlanVerificationError, verifyPlan, type PlanContext, type TxPlan } from "./tx-plan.js";
import type { Address, Hex32 } from "./types.js";

const manifest: DeploymentManifest = {
  version: 1,
  ...GNOSIS_EXTERNAL,
  pine: { claimRegistry: "0x00000000000000000000000000000000000c1a10", evidenceRegistry: "0x00000000000000000000000000000000000e01de", deploymentBlock: 42_000_000 },
};
const account: Address = "0x00000000000000000000000000000000000a11ce";
const market: Address = "0x00000000000000000000000000000000000ba5e0";
const yes: Address = "0x00000000000000000000000000000000000000f1";
const no: Address = "0x00000000000000000000000000000000000000f2";
const invalid: Address = "0x00000000000000000000000000000000000000f3";
const question: Hex32 = `0x${"ab".repeat(32)}`;
const context: PlanContext = { markets: new Map([[market, [yes, no, invalid]]]), questionIds: new Set([question]) };
const limits = { maxTotalValueWei: 10n ** 20n, maxApprovalAmount: 10n ** 24n };
const sdai = manifest.seer.collateralToken;

function fundingPlan(): TxPlan {
  const amount = 5n * 10n ** 18n;
  const [token0, token1] = yes < sdai ? [yes, sdai] : [sdai, yes];
  const mintParams = {
    token0, token1, tickLower: -6_960, tickUpper: -60,
    amount0Desired: token0 === yes ? amount : 0n, amount1Desired: token1 === yes ? amount : 0n,
    amount0Min: 0n, amount1Min: 0n, recipient: account, deadline: 1_900_000_000n,
  };
  return newPlan(manifest, "plan-1", account, [
    buildStep(manifest, { id: "split", allowlistId: "gnosisRouter.splitFromBase", args: [market], value: amount }),
    buildStep(manifest, { id: "approve-yes", allowlistId: "outcomeToken.approve", to: yes, args: [manifest.amm.positionManager, amount], dependsOn: ["split"] }),
    buildStep(manifest, { id: "pool", allowlistId: "positionManager.createAndInitializePoolIfNecessary", args: [token0, token1, 2n ** 96n] }),
    buildStep(manifest, { id: "mint", allowlistId: "positionManager.mint", args: [mintParams], dependsOn: ["approve-yes", "pool"] }),
  ]);
}

describe("verifyPlan", () => {
  it("accepts a well-formed funding plan and returns its total value", () => {
    expect(verifyPlan(fundingPlan(), manifest, context, limits)).toBe(5n * 10n ** 18n);
  });
  it("accepts a create-claim plan", () => {
    const params = {
      claimDocumentSha256: question, policyDocumentSha256: question, repositoryId: 123_456n, commit: `0x${"ab".repeat(20)}`,
      evidenceDeadline: 1_900_000_000n, revealDeadline: 1_900_172_800n, minBond: 10n ** 19n,
      title: "Reporter deposits never use arbitration funds",
    };
    const plan = newPlan(manifest, "plan-2", account, [buildStep(manifest, { id: "create", allowlistId: "claimRegistry.createClaim", args: [params] })]);
    expect(verifyPlan(plan, manifest, context, limits)).toBe(0n);
  });
  const rejects = (mutate: (plan: TxPlan) => void, pattern: RegExp, ctx = context) => {
    const plan = fundingPlan();
    mutate(plan);
    expect(() => verifyPlan(plan, manifest, ctx, limits)).toThrow(PlanVerificationError);
    expect(() => verifyPlan(plan, manifest, ctx, limits)).toThrow(pattern);
  };
  it("rejects a redirected target", () => rejects((p) => { p.steps[0]!.to = "0x000000000000000000000000000000000000dead"; }, /target/));
  it("rejects calldata that does not match the declared args", () =>
    rejects((p) => { p.steps[1]!.data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: ["0x000000000000000000000000000000000000beef", 5n * 10n ** 18n] }); }, /calldata/));
  it("rejects an unlimited approval", () =>
    rejects((p) => {
      const step = p.steps[1]!;
      step.args = [manifest.amm.positionManager, 2n ** 256n - 1n];
      step.data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [manifest.amm.positionManager, 2n ** 256n - 1n] });
    }, /approval amount/));
  it("rejects an approval to a spender outside the manifest", () =>
    rejects((p) => {
      const step = p.steps[1]!;
      step.args = ["0x000000000000000000000000000000000000beef", 5n * 10n ** 18n];
      step.data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: ["0x000000000000000000000000000000000000beef", 5n * 10n ** 18n] });
    }, /spender/));
  it("rejects an approval larger than what the plan pulls", () =>
    rejects((p) => {
      const step = p.steps[1]!;
      step.args = [manifest.amm.positionManager, 6n * 10n ** 18n];
      step.data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [manifest.amm.positionManager, 6n * 10n ** 18n] });
    }, /consumed exactly/));
  it("rejects a mint to someone else", () =>
    rejects((p) => {
      const original = p.steps[3]!;
      const params = { ...(original.args[0] as Record<string, unknown>), recipient: "0x000000000000000000000000000000000000beef" };
      p.steps[3] = buildStep(manifest, { id: "mint", allowlistId: "positionManager.mint", args: [params], dependsOn: original.dependsOn });
    }, /recipient/));
  it("rejects unregistered markets and outcome tokens", () => rejects(() => {}, /registered/, { markets: new Map(), questionIds: new Set() }));
  it("rejects value on non-payable calls and plans above the spending limit", () => {
    rejects((p) => { p.steps[1]!.value = 1n; }, /non-payable/);
    const plan = fundingPlan();
    expect(() => verifyPlan(plan, manifest, context, { ...limits, maxTotalValueWei: 10n ** 18n })).toThrow(/spending limit/);
  });
  it("rejects a plan built for another manifest or chain", () => {
    rejects((p) => { p.deploymentHash = `0x${"00".repeat(32)}`; }, /manifest/);
    rejects((p) => { p.chainId = 1; }, /chain/);
  });
  it("rejects calls outside the allowlist and broken dependency order", () => {
    rejects((p) => { p.steps[0]!.allowlistId = "erc20.transfer"; }, /allowlist/);
    rejects((p) => { p.steps[1]!.dependsOn = ["mint"]; }, /depends on/);
  });
  it("rejects a pull without a preceding approval", () =>
    rejects((p) => { p.steps = [p.steps[0]!, p.steps[2]!, p.steps[3]!].map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== "approve-yes") })); }, /without a preceding exact approval/));
});

describe("buildDeploymentManifest", () => {
  it("overlays Pine addresses on the verified Gnosis constants and has a stable hash", async () => {
    const { buildDeploymentManifest, deploymentHash } = await import("./deployment.js");
    const built = buildDeploymentManifest({ claimRegistry: "0x00000000000000000000000000000000000C1A10", evidenceRegistry: "0x00000000000000000000000000000000000e01de", deploymentBlock: 42_000_000n });
    expect(built).toEqual(manifest);
    expect(deploymentHash(built)).toBe(deploymentHash(manifest));
    expect(() => buildDeploymentManifest({ claimRegistry: manifest.pine.claimRegistry, evidenceRegistry: manifest.pine.evidenceRegistry, deploymentBlock: 1 }, 1)).toThrow(/Unsupported chain/);
  });
});

describe("plan wire format", () => {
  it("round-trips through JSON and still verifies (args decoded from calldata)", () => {
    const wire = JSON.parse(JSON.stringify(planToWire(fundingPlan())));
    expect(wire.steps[0].value).toBe("5000000000000000000");
    expect("args" in wire.steps[0]).toBe(false);
    expect(verifyPlan(planFromWire(wire), manifest, context, limits)).toBe(5n * 10n ** 18n);
  });
  it("rejects malformed wire plans and calldata for another function", () => {
    const wire = JSON.parse(JSON.stringify(planToWire(fundingPlan())));
    expect(() => planFromWire({ ...wire, extra: 1 })).toThrow(PlanVerificationError);
    const swapped = { ...wire, steps: [{ ...wire.steps[1], allowlistId: "positionManager.mint" }] };
    expect(() => planFromWire(swapped)).toThrow(/decode/);
    expect(() => planFromWire({ ...wire, steps: [{ ...wire.steps[0], value: "-1" }] })).toThrow(PlanVerificationError);
  });
});
