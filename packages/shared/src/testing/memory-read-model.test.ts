import { describe, expect, it } from "vitest";
import { MemoryReadModel, OutOfOrderEventError } from "./memory-read-model.js";
import { describeReadModelConformance } from "./read-model-conformance.js";
import { SCENARIO_CHAIN_ID, SCENARIO_QUESTION_TIMEOUT, scenarioClaimsAndEvidence } from "./read-model-scenarios.js";

describeReadModelConformance("memory reference", async (events, setup) => {
  const model = new MemoryReadModel({ chainId: setup.chainId, questionTimeout: setup.questionTimeout });
  model.apply(events);
  return { readModel: model };
});

describe("MemoryReadModel ordering", () => {
  it("refuses an event at or before the last applied position", () => {
    const { events } = scenarioClaimsAndEvidence();
    const model = new MemoryReadModel({ chainId: SCENARIO_CHAIN_ID, questionTimeout: SCENARIO_QUESTION_TIMEOUT });
    model.apply(events.slice(0, 3));
    expect(() => model.apply([events[1]!])).toThrow(OutOfOrderEventError);
    expect(() => model.apply([events[2]!])).toThrow(OutOfOrderEventError);
  });
  it("ignores events of other chains", async () => {
    const { events, claims } = scenarioClaimsAndEvidence();
    const model = new MemoryReadModel({ chainId: 1, questionTimeout: SCENARIO_QUESTION_TIMEOUT });
    model.apply(events);
    expect(await model.getClaim(claims[0]!.market)).toBeNull();
  });
});
