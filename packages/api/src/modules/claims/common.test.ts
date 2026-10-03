// Pure rules of the claims module (no database): plan-offer expiry, deadline rounding, window bounds and the ETag's
// hashed form (PRD-03 §5, §6, §8b; decisions "API windows" and "ETag").

import { describe, expect, it } from "vitest";
import { testConfig } from "../../contracts/testing.js";
import { CLOCK_ONLY_FIELDS, etagForm, etagOf, evidenceWindowBounds, planExpiry, roundUpToMinute } from "./common.js";

const DAY = 86_400;

describe("plan offer expiry: min(evidenceDeadline - 1 day - 15 min, previewCreatedAt + 24 h)", () => {
  it("the 24 h preview cap wins for every window the API accepts (>= 3 days)", () => {
    const created = 1_790_000_000;
    expect(planExpiry(created + 3 * DAY, created)).toBe(created + DAY);
    expect(planExpiry(created + 30 * DAY, created)).toBe(created + DAY);
  });

  it("the on-chain minimum window wins when the deadline is near (a preview frozen under a shorter configured window)", () => {
    const created = 1_790_000_000;
    // evidenceDeadline - 1 day - 15 min < created + 24 h once the deadline is less than 2 days and 15 min away.
    expect(planExpiry(created + 2 * DAY, created)).toBe(created + DAY - 900);
    expect(planExpiry(created + 2 * DAY + 900, created)).toBe(created + DAY);
    expect(planExpiry(created + DAY + 900, created)).toBe(created);
  });
});

describe("evidence window", () => {
  it("rounds the deadline up to the minute (exact minutes stay)", () => {
    expect(roundUpToMinute(120)).toBe(120);
    expect(roundUpToMinute(121)).toBe(180);
    expect(roundUpToMinute(179)).toBe(180);
  });

  it("bounds are [max(3 d, config min), min(30 d, config max)]", () => {
    const base = testConfig();
    expect(evidenceWindowBounds(testConfig({ claims: { ...base.claims, minEvidenceWindowSeconds: DAY, maxEvidenceWindowSeconds: 90 * DAY } }))).toEqual({ min: 3 * DAY, max: 30 * DAY });
    expect(evidenceWindowBounds(testConfig({ claims: { ...base.claims, minEvidenceWindowSeconds: 5 * DAY, maxEvidenceWindowSeconds: 10 * DAY } }))).toEqual({ min: 5 * DAY, max: 10 * DAY });
  });
});

describe("ETag hashed form (PRD-03 §8b)", () => {
  const body = (lagSeconds: number, extra: Record<string, unknown> = {}) => ({
    items: [{ market: "0x01", phase: "evidence_open" }],
    nextCursor: null,
    indexer: { indexedBlock: "10", indexedBlockTimestamp: 1_790_000_000, lagSeconds, halted: false, stale: false, ...extra },
  });

  it("leaves out only indexer.lagSeconds; indexedBlock, stale and halted stay in", () => {
    expect(CLOCK_ONLY_FIELDS).toEqual([["indexer", "lagSeconds"]]);
    expect(etagForm(body(5))).toEqual({ items: [{ market: "0x01", phase: "evidence_open" }], nextCursor: null, indexer: { indexedBlock: "10", indexedBlockTimestamp: 1_790_000_000, halted: false, stale: false } });
    expect(etagOf(body(5))).toBe(etagOf(body(500)));
    expect(etagOf(body(5))).not.toBe(etagOf(body(5, { stale: true })));
    expect(etagOf(body(5))).not.toBe(etagOf(body(5, { halted: true })));
    expect(etagOf(body(5))).not.toBe(etagOf(body(5, { indexedBlock: "11" })));
  });

  it("is a strong quoted SHA-256 (base64url) and leaves bodies without an indexer untouched", () => {
    expect(etagOf({ a: 1 })).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(etagForm({ a: 1, lagSeconds: 3 })).toEqual({ a: 1, lagSeconds: 3 });
    expect(etagForm([1, 2])).toEqual([1, 2]);
  });
});
