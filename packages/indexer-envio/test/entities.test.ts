import "./lock.js";

// Entity equivalence (PRD-05 3.1): for each frozen scenario the real handlers produce exactly the records of
// MemoryReadModel, and the produced rows equal the committed snapshot the read-model-envio fake serves.

import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import type { ChainEvent } from "@pine/shared/chain-events";
import { scenarioClaimsAndEvidence, scenarioManyClaims, scenarioOracle } from "@pine/shared/testing/read-model-scenarios";
import { allEntities, expectEquivalent, runEnvio, splitAtBlocks } from "./differential.js";
import { toSimulateItem } from "./simulate.js";
import { buildSnapshot, committedSnapshot, serializeSnapshot, snapshotPath } from "./snapshot.js";

/** Every frozen scenario of packages/shared/src/testing/read-model-scenarios.ts, by snapshot name. */
const SCENARIOS: readonly { name: string; events: () => ChainEvent[] }[] = [
  { name: "claims-and-evidence", events: () => scenarioClaimsAndEvidence().events },
  { name: "oracle", events: () => scenarioOracle().events },
  { name: "many-claims", events: () => scenarioManyClaims().events },
];

describe("handlers reproduce MemoryReadModel on every frozen scenario", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: entities equal the reference records and the committed snapshot`, async () => {
      const events = scenario.events();
      const indexer = await runEnvio(events);
      await expectEquivalent(events, indexer);

      const actual = buildSnapshot(scenario.name, events, await allEntities(indexer));
      const committed = committedSnapshot(scenario.name, actual);
      expect(committed, `missing ${snapshotPath(scenario.name)}; run UPDATE_SNAPSHOTS=1 pnpm --filter @pine/indexer-envio test`).not.toBeNull();
      expect(committed).toBe(serializeSnapshot(actual));
    });

    it(`SEC-IDX-04 ${scenario.name}: processing in several batches, or again from scratch, gives identical entities`, async () => {
      const events = scenario.events();
      const whole = await allEntities(await runEnvio(events));
      const batches = splitAtBlocks(events, 3);
      expect(batches.length).toBeGreaterThan(1);
      const split = await runEnvio(events, batches);
      await expectEquivalent(events, split);
      expect(await allEntities(split)).toEqual(whole);
    });

    it(`SEC-IDX-04 ${scenario.name}: re-submitting an already processed range to the same store is refused and changes nothing (no double counting)`, async () => {
      const events = scenario.events();
      const batches = splitAtBlocks(events, 3);
      const simulate = (batch: readonly ChainEvent[]) => ({ chains: { 100: { simulate: batch.map(toSimulateItem) } } });
      const indexer = createTestIndexer();
      for (const batch of batches) {
        await indexer.process(simulate(batch));
        const applied = await allEntities(indexer);
        await expect(indexer.process(simulate(batch))).rejects.toThrow(/never reached a handler/);
        expect(await allEntities(indexer)).toEqual(applied);
      }
      expect(await allEntities(indexer)).toEqual(await allEntities(await runEnvio(events)));
    });
  }
});
