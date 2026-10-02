// FROZEN. Valid example documents for tests across packages.
import type { ClaimDocument } from "../claim-document.js";
import { GNOSIS_EXTERNAL } from "../deployment.js";

export function exampleClaimDocument(overrides: Partial<ClaimDocument> = {}): ClaimDocument {
  return {
    schema: "urn:pine:claim:v1",
    nonce: "0x7f0c7c4f6b2a5d1e9a3b8c0d4e6f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b",
    policy: { id: "BOT-001", version: "0.1.0", sha256: "0x9404b90b7ea23aabc44a78b76b19e7b156e8e8ffaec699bd12b4dabdb2da2cfc" },
    target: {
      host: "github.com",
      repository: { id: 427016914, ownerLogin: "kleros", name: "kleros-v2" },
      commit: "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12",
      baseCommit: null,
      membership: { method: "pull_head", ref: { kind: "pull", number: 2101 }, verifiedAt: "2026-10-02T18:00:00Z" },
    },
    claim: {
      title: "Reporter deposits never use arbitration funds or the operator gas reserve",
      requirement: "Each reporter-funding deposit's principal is allocated only from eligible bridging/reporter funds in scope.",
      violation: "A reachable sequence in which a positive reporter deposit draws principal from an arbitration allocation or the operator gas reserve.",
      scope: { components: ["bots/gateway-balancer/src/reporter", "bots/gateway-balancer/src/platform/ledger"], outOfScope: ["LI.FI execution"] },
      allowedInputs: "Configurations valid under config/example.json; journal states reachable from an empty journal.",
      assumptions: ["Operator reserve may pay reporter transaction gas fees."],
      faultModel: "Process crash between any two persisted steps; RPC timeouts; replacement transactions.",
      regressionOnly: false,
      exclusions: ["Gas fees paid from the operator reserve."],
      policyParameters: { sourceRequirement: "gateway-balancer-bot-spec.md sections 2.2 and 4.2", startingStates: "Reachable from an empty journal", simulatedAdapters: ["lifi"] },
    },
    environment: {
      runtime: "Node 24.21.0 on Linux x64",
      dependencies: "yarn.lock at the target commit",
      configuration: "config/example.json at the target commit with two pairs",
      externalState: "Simulated chains; no live RPC",
      reproduction: { setup: "yarn install --immutable", command: "yarn workspace @kleros/gateway-balancer-bot test", notes: "" },
    },
    evidence: { chainId: 100, registry: "0x00000000000000000000000000000000000e01de", evidenceDeadline: 1791158400, revealDeadline: 1791331200, manifestSchema: "urn:pine:evidence-manifest:v1" },
    market: {
      chainId: 100,
      claimRegistry: "0x00000000000000000000000000000000000c1a10",
      seerMarketFactory: GNOSIS_EXTERNAL.seer.marketFactory,
      collateralToken: GNOSIS_EXTERNAL.seer.collateralToken,
      realitio: GNOSIS_EXTERNAL.seer.realitio,
      arbitrator: GNOSIS_EXTERNAL.seer.arbitrator,
      questionTimeoutSeconds: GNOSIS_EXTERNAL.seer.questionTimeoutSeconds,
      openingTime: 1791331200,
      minBondWei: "10000000000000000000",
    },
    disclosure: { liveSystemImpact: "none" },
    creator: "0x00000000000000000000000000000000000a11ce",
    createdAt: "2026-10-02T18:30:00Z",
    ...overrides,
  };
}
