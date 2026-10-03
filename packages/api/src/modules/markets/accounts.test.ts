// Must stay the first import: serializes the markets test files (see test/lock.ts). Public routes only: no database.
import "./test/lock.js";
import { describe, expect, it } from "vitest";
import { claimCreated } from "@pine/shared/testing/read-model-scenarios";
import type { Address } from "@pine/shared/types";
import { EVIDENCE_REGISTRY, useHarness, type Harness } from "./test/helpers.js";

const harnessOf = useHarness({ database: false });
const WALLET = "0x00000000000000000000000000000000000000d1" as Address;
const activity = (h: Harness, query = "", headers: Record<string, string> = {}) => h.app.inject({ method: "GET", url: `/api/v1/accounts/${WALLET}/activity${query}`, headers });

describe("GET /api/v1/accounts/:wallet/activity", () => {
  it("lists claims created and evidence submitted with one cursor over both lists", async () => {
    const h = harnessOf();
    const events = [];
    for (let index = 0; index < 25; index += 1) events.push(claimCreated(h.b, `act-${index}`, { creator: WALLET }));
    await h.apply(...events);
    const market = events[0]!.market;
    h.b.nextBlock();
    await h.apply(...Array.from({ length: 3 }, (_, index) => ({ ...h.b.envelope(EVIDENCE_REGISTRY), kind: "EvidenceCommitted" as const, submissionId: BigInt(index + 1), market, submitter: WALLET, commitment: `0x${"c3".repeat(32)}` as const, committedAt: h.b.now() })));
    const first = (await activity(h)).json();
    expect(first.claims).toHaveLength(20);
    expect(first.evidence.map((item: { submissionId: string }) => item.submissionId)).toEqual(["1", "2", "3"]);
    expect(first.claims[0]).toMatchObject({ contentTrust: "untrusted" });
    expect(first.oracleAnswers).toMatchObject({ available: false });
    expect(first.nextCursor).not.toBeNull();
    const second = (await activity(h, `?cursor=${first.nextCursor}`)).json();
    expect(second.claims).toHaveLength(5);
    expect(second.evidence).toEqual([]);
    expect(second.nextCursor).toBeNull();
    const all = [...first.claims, ...second.claims].map((claim: { market: string }) => claim.market);
    expect(new Set(all).size).toBe(25);
  });

  it("excludes hidden claims and evidence, refuses bad cursors, and is identical with or without a session", async () => {
    const h = harnessOf();
    const claim = claimCreated(h.b, "act-hidden", { creator: WALLET });
    await h.apply(claim);
    h.ctx.moderation.set("claim", claim.market, "hide", "spam");
    expect((await activity(h)).json().claims).toEqual([]);
    expect((await activity(h, "?cursor=%%%")).statusCode).toBe(400);
    const anonymous = await activity(h);
    const withSession = await activity(h, "", h.headers);
    expect(withSession.body).toBe(anonymous.body);
  });
});
