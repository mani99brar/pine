// The e2e harness's own guarantee: every plan in a response is decoded with planFromWire and verified, including plans
// that are malformed (they must fail, never be skipped).

import { describe, expect, it } from "vitest";
import { planFromWire, PlanVerificationError } from "@pine/shared/tx-plan";
import { wirePlansIn } from "./support/app.js";

const wire = {
  version: 1,
  planId: "p-1",
  chainId: 100,
  account: "0x00000000000000000000000000000000000a11ce",
  deploymentHash: `0x${"11".repeat(32)}`,
  steps: [{ id: "s", allowlistId: "claimRegistry.createClaim", chainId: 100, to: "0x00000000000000000000000000000000000c1a10", data: "0x", value: "0", dependsOn: [] }],
};

describe("wirePlansIn", () => {
  it("finds well-formed plans once, wherever they are", () => {
    const body = { publication: { id: "x" }, plan: wire, nested: [{ again: wire }] };
    expect(wirePlansIn(body)).toEqual([wire]);
  });

  it("finds malformed plans so that planFromWire rejects them instead of skipping them", () => {
    const { deploymentHash: _dropped, ...withoutHash } = wire;
    const malformed = [
      { plan: withoutHash },
      { plan: { ...wire, version: 2 } },
      { plan: "not a plan" },
      { item: { planId: "p-2", steps: [{ to: "0x00", data: "0xdead" }] } },
      { item: { deploymentHash: wire.deploymentHash, steps: "none" } },
    ];
    for (const body of malformed) {
      const found = wirePlansIn(body);
      expect(found, JSON.stringify(body)).toHaveLength(1);
      expect(() => planFromWire(found[0]), JSON.stringify(body)).toThrow(PlanVerificationError);
    }
  });

  it("does not mistake a plan's state view (step states without calls) for a second plan", () => {
    const view = { planId: "p-1", kind: "ladder", plan: wire, steps: [{ id: "s", state: "pending", txHashes: [] }] };
    expect(wirePlansIn(view)).toEqual([wire]);
    // The discovery document names the manifest digest; it carries no plan.
    expect(wirePlansIn({ chainId: 100, deployment: {}, deploymentHash: wire.deploymentHash })).toEqual([]);
  });
});
