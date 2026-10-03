import "./lock.js";

// An invalid ENVIO_QUESTION_TIMEOUT fails closed: Envio cannot load the handlers, so nothing is processed. Set before
// this file's (fresh fork process) first createTestIndexer().

import { createTestIndexer } from "envio";
import { afterAll, describe, expect, it, vi } from "vitest";
import { claimCreated, EventBuilder } from "@pine/shared/testing/read-model-scenarios";
import { toSimulateItem } from "./simulate.js";

vi.stubEnv("ENVIO_QUESTION_TIMEOUT", "abc");
afterAll(() => {
  vi.unstubAllEnvs();
});

describe("ENVIO_QUESTION_TIMEOUT in the handlers", () => {
  it("an invalid value stops processing before any entity is written", async () => {
    const indexer = createTestIndexer();
    const claim = claimCreated(new EventBuilder(), "timeout");
    await expect(indexer.process({ chains: { 100: { simulate: [toSimulateItem(claim)] } } })).rejects.toThrow(/ENVIO_QUESTION_TIMEOUT must be a positive integer/);
    expect(await indexer.Claim.getAll().catch(() => [])).toEqual([]);
  });
});
