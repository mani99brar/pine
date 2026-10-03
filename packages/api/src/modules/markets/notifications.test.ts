// Must stay the first import: serializes the memory-heavy markets test files (see test/lock.ts).
import "./test/lock.js";
import { describe, expect, it } from "vitest";
import { claimCreated, SCENARIO_ADDRESSES } from "@pine/shared/testing/read-model-scenarios";
import type { Address } from "@pine/shared/types";
import { createMarketsState } from "./index.js";
import { runWatch, WATCH_MAX_CLAIMS } from "./notifications.js";
import { addClaim, answerHex, EVIDENCE_REGISTRY, MANIFEST, useHarness, type Harness } from "./test/helpers.js";

const harnessOf = useHarness();
const STRANGER = "0x00000000000000000000000000000000000000f0" as Address;
const state = () => createMarketsState(MANIFEST);
const watch = (h: Harness) => runWatch(h.ctx, state());
const count = async (h: Harness) => Number((await h.ctx.database.sql.query<{ n: string }>("SELECT count(*)::int AS n FROM markets_notifications"))[0]?.n);
const list = (h: Harness, headers = h.headers, query = "") => h.app.inject({ method: "GET", url: `/api/v1/accounts/me/notifications${query}`, headers });

describe("markets.watch", () => {
  it("notifies the claim creator and evidence submitters that have an account, idempotently", async () => {
    const h = harnessOf();
    const submitter = await h.user();
    const claim = await addClaim(h, "n1", { creator: h.session.wallet });
    h.b.nextBlock();
    await h.apply(
      { ...h.b.envelope(EVIDENCE_REGISTRY), kind: "EvidenceCommitted", submissionId: 1n, market: claim.market, submitter: submitter.session.wallet, commitment: `0x${"c1".repeat(32)}`, committedAt: h.b.now() },
      { ...h.b.envelope(EVIDENCE_REGISTRY), kind: "EvidenceCommitted", submissionId: 2n, market: claim.market, submitter: STRANGER, commitment: `0x${"c2".repeat(32)}`, committedAt: h.b.now() },
    );
    expect((await watch(h)).inserted).toBe(0);
    h.at(claim.evidenceDeadline - 3_600);
    await h.fresh();
    expect(await watch(h)).toMatchObject({ claims: 1, inserted: 2, skipped: false });
    expect(await watch(h)).toMatchObject({ inserted: 0 });
    expect(await count(h)).toBe(2);
    // Read-model facts only: the job never calls the chain.
    expect(h.chain.calls).toEqual([]);
    expect(h.ctx.metrics.counters.get('markets_notifications{"outcome":"inserted"}')).toBe(1);
    const mine = (await list(h)).json().items;
    expect(mine).toEqual([expect.objectContaining({ market: claim.market, kind: "evidence_closing", target: claim.evidenceDeadline, readAt: null })]);
    expect((await list(h, submitter.headers)).json().items).toHaveLength(1);
    const wallets = await h.ctx.database.sql.query<{ wallet_address: string }>("SELECT u.wallet_address FROM markets_notifications n JOIN users u ON u.id = n.user_id");
    expect(wallets.map((row) => row.wallet_address)).not.toContain(STRANGER);
  });

  it("follows the oracle: answers open, finalization soon (per answer), finalized with due actions", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "n2", { creator: h.session.wallet });
    h.b.nextBlock(claim.revealDeadline - h.b.now() + 10);
    const answerAt = h.b.now();
    await h.apply({ ...h.b.envelope(SCENARIO_ADDRESSES.reality as Address), kind: "RealityNewAnswer", questionId: claim.questionId, answer: answerHex(1n), historyHash: `0x${"a1".repeat(32)}`, user: STRANGER, bond: 10n ** 18n, ts: answerAt, isCommitment: false });
    h.at(answerAt + 302_400 - 3_600);
    await h.fresh();
    await watch(h);
    const kinds = (await list(h)).json().items.map((item: { kind: string }) => item.kind).sort();
    expect(kinds).toEqual(["answers_open", "finalization_soon"]);
    h.at(answerAt + 302_400);
    await h.fresh();
    await watch(h);
    const finalized = (await list(h)).json().items.find((item: { kind: string }) => item.kind === "finalized");
    expect(finalized.payload).toMatchObject({ outcome: "no", dueActions: ["resolve_market"] });
  });

  it("notifies reveal closing, each arbitration stage change and the resolution, once each", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "n4", { creator: h.session.wallet });
    const kinds = async () => (await list(h)).json().items.map((item: { kind: string; target: number }) => `${item.kind}@${item.target}`).sort();
    h.at(claim.revealDeadline - 6 * 3_600 - 1);
    await h.fresh();
    await watch(h);
    expect(await kinds()).toEqual([]);
    h.at(claim.revealDeadline - 6 * 3_600);
    await h.fresh();
    await watch(h);
    expect(await kinds()).toEqual([`reveal_closing@${claim.revealDeadline}`]);

    const reality = SCENARIO_ADDRESSES.reality as Address;
    const proxy = SCENARIO_ADDRESSES.klerosHomeProxy as Address;
    h.b.nextBlock(claim.revealDeadline - h.b.now() + 10);
    await h.apply({ ...h.b.envelope(reality), kind: "RealityNewAnswer", questionId: claim.questionId, answer: answerHex(1n), historyHash: `0x${"a2".repeat(32)}`, user: STRANGER, bond: 10n ** 18n, ts: h.b.now(), isCommitment: false });
    h.b.nextBlock(60);
    const notifiedAt = h.b.now();
    await h.apply(
      { ...h.b.envelope(proxy), kind: "KlerosHome", stage: "RequestNotified", questionId: claim.questionId, requester: STRANGER, maxPrevious: 10n ** 18n, reason: null, answer: null },
      { ...h.b.envelope(reality), kind: "RealityArbitrationRequested", questionId: claim.questionId, user: STRANGER },
    );
    h.b.nextBlock(600);
    const acknowledgedAt = h.b.now();
    await h.apply({ ...h.b.envelope(proxy), kind: "KlerosHome", stage: "RequestAcknowledged", questionId: claim.questionId, requester: STRANGER, maxPrevious: null, reason: null, answer: null });
    h.at(h.b.now());
    await h.fresh();
    await watch(h);
    const arbitration = (await kinds()).filter((kind: string) => kind.startsWith("arbitration_"));
    expect(arbitration).toEqual([`arbitration_RequestAcknowledged@${acknowledgedAt}`, `arbitration_RequestNotified@${notifiedAt}`]);

    h.b.nextBlock(60);
    const resolvedAt = h.b.now();
    await h.apply({ ...h.b.envelope(SCENARIO_ADDRESSES.conditionalTokens as Address), kind: "ConditionResolution", conditionId: claim.conditionId, oracle: MANIFEST.seer.realityProxy, ctfQuestionId: `0x${"cf".repeat(32)}`, outcomeSlotCount: 3, payoutNumerators: [0n, 1n, 0n] });
    h.at(h.b.now());
    await h.fresh();
    await watch(h);
    const resolved = (await list(h)).json().items.find((item: { kind: string }) => item.kind === "resolved");
    expect(resolved).toMatchObject({ target: resolvedAt, payload: { market: claim.market, payoutNumerators: ["0", "1", "0"] } });
    const before = await count(h);
    expect((await watch(h)).inserted).toBe(0);
    expect(await count(h)).toBe(before);
  });

  it("never notifies while the read model is stale or halted", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "n3", { creator: h.session.wallet });
    h.at(claim.evidenceDeadline - 3_600);
    expect(await watch(h)).toMatchObject({ skipped: true });
    await h.fresh();
    h.ctx.readModel.setHalted(true);
    expect(await watch(h)).toMatchObject({ skipped: true });
    expect(await count(h)).toBe(0);
  });

  it(`processes at most ${WATCH_MAX_CLAIMS} claims per run and rotates its persisted cursor`, async () => {
    const h = harnessOf();
    const events = [];
    for (let index = 0; index < 230; index += 1) {
      if (index % 50 === 0) h.b.nextBlock();
      events.push(claimCreated(h.b, `many-${index}`, { creator: h.session.wallet }));
    }
    await h.apply(...events);
    expect((await watch(h)).claims).toBe(200);
    expect((await h.ctx.database.sql.query<{ cursor: string | null }>("SELECT cursor FROM markets_watch_state"))[0]?.cursor).not.toBeNull();
    expect((await watch(h)).claims).toBe(30);
    expect((await h.ctx.database.sql.query<{ cursor: string | null }>("SELECT cursor FROM markets_watch_state"))[0]?.cursor).toBeNull();
    expect((await watch(h)).claims).toBe(200);
  });
});

describe("notification routes (owner only)", () => {
  it("marks as read idempotently and hides other users' notifications", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "n5", { creator: h.session.wallet });
    h.at(claim.evidenceDeadline - 60);
    await h.fresh();
    await watch(h);
    const [item] = (await list(h)).json().items;
    const other = await h.user();
    expect((await list(h, other.headers)).json().items).toEqual([]);
    expect((await h.app.inject({ method: "POST", url: `/api/v1/accounts/me/notifications/${item.id}/read`, headers: other.headers })).statusCode).toBe(404);
    const read = await h.app.inject({ method: "POST", url: `/api/v1/accounts/me/notifications/${item.id}/read`, headers: h.headers });
    expect(read.statusCode).toBe(200);
    h.ctx.clock.advance(60_000);
    const again = await h.app.inject({ method: "POST", url: `/api/v1/accounts/me/notifications/${item.id}/read`, headers: h.headers });
    expect(again.json().readAt).toBe(read.json().readAt);
    expect((await list(h, h.headers, "?unread=true")).json().items).toEqual([]);
    expect((await list(h, {})).statusCode).toBe(401);
    expect((await list(h, h.headers, "?cursor=bogus")).statusCode).toBe(400);
  });
});
