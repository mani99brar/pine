// Must stay the first import: serializes the memory-heavy markets test files (see test/lock.ts).
import "./test/lock.js";
import { describe, expect, it, vi } from "vitest";
import { concat, keccak256, stringToHex, toHex } from "viem";
import { REALITY_ANSWERED_TOO_SOON, REALITY_INVALID } from "@pine/shared/read-model";
import { claimCreated, SCENARIO_ADDRESSES, scenarioOracle } from "@pine/shared/testing/read-model-scenarios";
import type { Address, Hex32 } from "@pine/shared/types";
import { ORACLE_MAX_IN_FLIGHT, ORACLE_RETRY_AFTER_SECONDS } from "./oracle.js";
import { addClaim, answerHex, EVIDENCE_REGISTRY, MANIFEST, postJson, useHarness, verifiedPlan, ZERO32, type Harness } from "./test/helpers.js";

const harnessOf = useHarness();
const XDAI = 10n ** 18n;
const ALICE = "0x0000000000000000000000000000000000a1a1a1" as Address;
const BOB = "0x0000000000000000000000000000000000b0b0b0" as Address;
const TIMEOUT = 302_400;
const REALITY = SCENARIO_ADDRESSES.reality as Address;
const PROXY = SCENARIO_ADDRESSES.klerosHomeProxy as Address;

/** Independent history hash (raw concatenation, as abi.encodePacked lays it out). */
const hashAfter = (previous: Hex32, answer: Hex32, bond: bigint, answerer: Address, isCommitment: boolean): Hex32 =>
  keccak256(concat([previous, answer, toHex(bond, { size: 32 }), answerer, isCommitment ? "0x01" : "0x00"]));

const chains = new Map<string, Hex32>();

/** Applies a LogNewAnswer with a real history hash and keeps the scripted getHistoryHash in sync. */
async function answer(h: Harness, questionId: Hex32, value: Hex32, bond: bigint, answerer: Address, isCommitment = false): Promise<Hex32> {
  const previous = chains.get(questionId) ?? ZERO32;
  const historyHash = hashAfter(previous, value, bond, answerer, isCommitment);
  chains.set(questionId, historyHash);
  h.chain.historyHashes.set(questionId, historyHash);
  h.b.nextBlock();
  await h.apply({ ...h.b.envelope(REALITY), kind: "RealityNewAnswer", questionId, answer: value, historyHash, user: answerer, bond, ts: h.b.now(), isCommitment });
  return historyHash;
}

/** Moves chain time and the clock to `seconds` (the read model fresh at that time). */
async function moveTo(h: Harness, seconds: number) {
  h.b.nextBlock(Math.max(1, seconds - h.b.now()));
  h.at(seconds);
  await h.fresh();
}

async function openClaim(h: Harness, seed: string) {
  chains.clear();
  const claim = await addClaim(h, seed);
  await moveTo(h, claim.revealDeadline + 10);
  return claim;
}

const status = (h: Harness, market: Address, account?: Address) => h.app.inject({ method: "GET", url: `/api/v1/markets/${market}/oracle${account ? `?account=${account}` : ""}` });

describe("GET /api/v1/markets/:market/oracle", () => {
  it("returns facts, derived status, phase, staleness and dueActions; account-specific actions only with an account", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "o1");
    await answer(h, claim.questionId, answerHex(1n), XDAI, ALICE);
    h.chain.balances.set(ALICE, 3n * XDAI);
    const anonymous = (await status(h, claim.market)).json();
    expect(anonymous).toMatchObject({
      questionId: claim.questionId,
      currentQuestionId: claim.questionId,
      status: { state: "answered", outcome: "no", bond: XDAI.toString() },
      phase: "oracle_open",
      freshness: { stale: false },
    });
    expect(anonymous.dueActions.map((action: { action: string }) => action.action)).toEqual(["answer", "fund_bounty", "request_arbitration_on_ethereum"]);
    const withAccount = (await status(h, claim.market, ALICE)).json();
    expect(withAccount.dueActions.map((action: { action: string }) => action.action)).toContain("withdraw");
    expect(h.chain.calls).toContain(`balanceOf:${ALICE}`);
  });

  it("follows Reality's current replacement after a reopen and offers the claim on the original question", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "o2");
    await answer(h, claim.questionId, REALITY_ANSWERED_TOO_SOON, XDAI, ALICE);
    await moveTo(h, h.b.now() + TIMEOUT + 1);
    const replacement = `0x${"5e".repeat(32)}` as Hex32;
    h.b.nextBlock();
    await h.apply({ ...h.b.envelope(REALITY), kind: "RealityQuestionReopened", questionId: replacement, reopenedQuestionId: claim.questionId });
    h.chain.reopened.set(claim.questionId, replacement);
    const body = (await status(h, claim.market)).json();
    expect(body).toMatchObject({ currentQuestionId: replacement, reopened: true, status: { state: "open_unanswered" } });
    expect(body.dueActions.map((action: { action: string; questionId: string }) => [action.action, action.questionId])).toEqual([
      ["answer", replacement],
      ["fund_bounty", replacement],
      ["claim_winnings", claim.questionId],
    ]);
  });

  it("uses Reality's reopened_questions id only when the read model links it to the claim's question; otherwise NOT_READY", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "o2x");
    const other = await addClaim(h, "o2x-other");
    await moveTo(h, other.revealDeadline + 10);
    await answer(h, claim.questionId, REALITY_ANSWERED_TOO_SOON, XDAI, ALICE);
    await moveTo(h, h.b.now() + TIMEOUT + 1);
    // The RPC names another indexed Pine question (it reopens nothing) as the replacement: refused, nothing offered.
    expect(await h.ctx.readModel.getOracleQuestion(other.questionId)).toMatchObject({ reopens: null });
    h.chain.reopened.set(claim.questionId, other.questionId);
    const refused = await status(h, claim.market);
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe("NOT_READY");
    const plan = await postJson(h, "/api/v1/oracle/plans/submit-answer", { market: claim.market, outcome: "yes", bond: (10n * XDAI).toString() });
    expect(plan.statusCode).toBe(503);
    expect(plan.json().error.code).toBe("NOT_READY");
    // An id the read model has not indexed (and the original does not name) is refused the same way.
    h.chain.reopened.set(claim.questionId, `0x${"6a".repeat(32)}` as Hex32);
    h.at(h.ctx.clock.unix() + 11);
    await h.fresh();
    expect((await status(h, claim.market)).json().error.code).toBe("NOT_READY");
    expect(await h.ctx.database.sql.query("SELECT id FROM markets_plans")).toEqual([]);
    // Once indexed as the reopener of the claim's question, it is the current question.
    h.b.nextBlock();
    await h.apply({ ...h.b.envelope(REALITY), kind: "RealityQuestionReopened", questionId: `0x${"6a".repeat(32)}` as Hex32, reopenedQuestionId: claim.questionId });
    h.at(h.ctx.clock.unix() + 11);
    await h.fresh();
    expect((await status(h, claim.market)).json()).toMatchObject({ currentQuestionId: `0x${"6a".repeat(32)}`, reopened: true });
  });

  it("derives status, phase and dueActions from the shared full oracle scenario (arbitration, resolution, reopen)", async () => {
    const h = harnessOf();
    const scenario = scenarioOracle();
    h.ctx.readModel.apply(scenario.events);
    h.at(scenario.builder.now() + 10);
    await h.fresh();
    const seeded = (seed: string) => keccak256(stringToHex(seed));
    // gamma: arbitration requested, cancelled, requested again, answered by the arbitrator, finished, condition resolved.
    h.chain.historyHashes.set(scenario.claim.questionId, seeded("h4"));
    const gamma = (await status(h, scenario.claim.market)).json();
    expect(gamma).toMatchObject({
      status: { state: "finalized", outcome: "yes", byArbitrator: true },
      phase: "resolved",
      arbitration: { stage: "ArbitrationFinished" },
      resolution: { payoutNumerators: ["1", "0", "0"] },
    });
    expect(gamma.answers.map((item: { isCommitment: boolean; bond: string }) => [item.isCommitment, item.bond])).toEqual([
      [false, XDAI.toString()],
      [true, (2n * XDAI).toString()],
      [false, (4n * XDAI).toString()],
      [false, "0"],
    ]);
    expect(gamma.dueActions.map((action: { action: string }) => action.action)).toEqual(["claim_winnings"]);
    // delta: settled too soon, reopened; the replacement is answered and its arbitration request was rejected.
    const delta = (await h.ctx.readModel.getClaim(`0x${keccak256(stringToHex("market:delta")).slice(26)}` as Address))!;
    h.chain.reopened.set(delta.questionId, scenario.reopenedQuestionId);
    h.chain.historyHashes.set(delta.questionId, seeded("d1"));
    const body = (await status(h, delta.market)).json();
    expect(body).toMatchObject({ currentQuestionId: scenario.reopenedQuestionId, reopened: true, status: { state: "answered", outcome: "no" }, phase: "oracle_open", arbitration: { stage: "RequestRejected", rejectionReasonTrust: "untrusted" } });
    expect(body.dueActions.map((action: { action: string; questionId: string | null }) => [action.action, action.questionId])).toEqual([
      ["answer", scenario.reopenedQuestionId],
      ["fund_bounty", scenario.reopenedQuestionId],
      ["request_arbitration_on_ethereum", scenario.reopenedQuestionId],
      ["handle_rejected_request", scenario.reopenedQuestionId],
      ["claim_winnings", delta.questionId],
    ]);
  });

  it("caches the response per (market, account) for 10 s on the server: repeated requests make no new eth_call", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "o4");
    await answer(h, claim.questionId, answerHex(1n), XDAI, ALICE);
    h.chain.balances.set(ALICE, 3n * XDAI);
    const first = await status(h, claim.market);
    const callsAfterFirst = h.chain.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    // Another key (with an account) is computed separately.
    const withAccount = await status(h, claim.market, ALICE);
    expect(withAccount.json().dueActions.map((action: { action: string }) => action.action)).toContain("withdraw");
    const callsWithAccount = h.chain.calls.length;
    expect(callsWithAccount).toBeGreaterThan(callsAfterFirst);
    // Chain state changes inside the window are not visible until it ends, for either key.
    h.b.nextBlock();
    await h.apply({ ...h.b.envelope(REALITY), kind: "RealityQuestionReopened", questionId: `0x${"5f".repeat(32)}` as Hex32, reopenedQuestionId: claim.questionId });
    h.chain.reopened.set(claim.questionId, `0x${"5f".repeat(32)}` as Hex32);
    h.at(h.ctx.clock.unix() + 9);
    await h.fresh();
    expect((await status(h, claim.market)).body).toBe(first.body);
    expect((await status(h, claim.market, ALICE)).body).toBe(withAccount.body);
    expect(h.chain.calls.length).toBe(callsWithAccount);
    // After 10 s the entry is recomputed from the chain.
    h.at(h.ctx.clock.unix() + 1);
    await h.fresh();
    const fresh = await status(h, claim.market);
    expect(h.chain.calls.length).toBeGreaterThan(callsWithAccount);
    expect(fresh.json().currentQuestionId).toBe(`0x${"5f".repeat(32)}`);
    expect(first.json().currentQuestionId).toBe(claim.questionId);
  });

  it("caps concurrent RPC fan-out at 4 cache misses: a 5th is refused at once with 429 and Retry-After, never queued", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "o5");
    const accounts = Array.from({ length: 6 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}` as Address);
    const held = h.chain.hold();
    // Four misses (distinct cache keys) each hold an eth_call open.
    const inFlight = accounts.slice(0, 4).map((account) => status(h, claim.market, account));
    await vi.waitFor(() => expect(held.waiting()).toBe(4));
    const callsBefore = h.chain.calls.length;
    const refused = await status(h, claim.market, accounts[4]);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("RATE_LIMITED");
    expect(refused.headers["retry-after"]).toBe(String(ORACLE_RETRY_AFTER_SECONDS));
    // Refused before any read: no new eth_call was started and none is waiting for a slot.
    expect(held.waiting()).toBe(4);
    expect(h.chain.calls.length).toBe(callsBefore);
    held.release();
    const done = await Promise.all(inFlight);
    expect(done.map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    // Slots are released (also after errors): the next miss is served, and cache hits never take a slot.
    expect((await status(h, claim.market, accounts[5])).statusCode).toBe(200);
    expect((await status(h, claim.market, accounts[0])).statusCode).toBe(200);
    expect(ORACLE_MAX_IN_FLIGHT).toBe(4);
  });

  it("releases a fan-out slot when the status computation fails (six failures in a row are 502, never 429)", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "o6");
    h.chain.failCalls = true;
    for (let attempt = 0; attempt < 6; attempt += 1) expect((await status(h, claim.market, `0x${(attempt + 16).toString(16).padStart(40, "0")}` as Address)).statusCode).toBe(502);
    h.chain.failCalls = false;
    expect((await status(h, claim.market)).statusCode).toBe(200);
  });

  it("maps RPC failures to UPSTREAM_UNAVAILABLE without leaking the provider URL", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "o3");
    h.chain.failCalls = true;
    const response = await status(h, claim.market);
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("secret-key");
  });
});

describe("POST /api/v1/oracle/plans/submit-answer", () => {
  it("builds submitAnswer with maxPrevious = current bond and a bond of at least max(minBond, 2x current)", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "a1");
    await answer(h, claim.questionId, answerHex(1n), 3n * XDAI, ALICE);
    const tooLow = await postJson(h, "/api/v1/oracle/plans/submit-answer", { market: claim.market, outcome: "yes", bond: (6n * XDAI - 1n).toString() });
    expect(tooLow.statusCode).toBe(422);
    const response = await postJson(h, "/api/v1/oracle/plans/submit-answer", { market: claim.market, outcome: "invalid", bond: (6n * XDAI).toString() });
    expect(response.statusCode).toBe(201);
    expect(() => verifiedPlan(response.json().plan, { ...claim, questionId: `0x${"ab".repeat(32)}` })).toThrow(/registered claim question/);
    const plan = verifiedPlan(response.json().plan, claim);
    expect(plan.steps[0]).toMatchObject({ allowlistId: "realitio.submitAnswer", to: MANIFEST.seer.realitio, value: 6n * XDAI, args: [claim.questionId, REALITY_INVALID, 3n * XDAI] });
    expect(response.json().planState.expiresAt).toBe(h.ctx.clock.unix() + 3_600);
    expect(h.ctx.compliance.calls.at(-1)).toEqual({ wallet: h.session.wallet, action: "answer_oracle" });
  });

  it("uses min bond for the first answer and refuses before opening, above the 10,000 xDAI limit and after finalization", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "a2");
    chains.clear();
    expect((await postJson(h, "/api/v1/oracle/plans/submit-answer", { market: claim.market, outcome: "yes", bond: XDAI.toString() })).statusCode).toBe(422);
    await moveTo(h, claim.revealDeadline);
    const first = await postJson(h, "/api/v1/oracle/plans/submit-answer", { market: claim.market, outcome: "yes", bond: claim.minBond.toString() });
    expect(verifiedPlan(first.json().plan, claim).steps[0]?.args).toEqual([claim.questionId, ZERO32, 0n]);
    const huge = await postJson(h, "/api/v1/oracle/plans/submit-answer", { market: claim.market, outcome: "yes", bond: (10_000n * XDAI + 1n).toString() });
    expect(huge.statusCode).toBe(400);
    expect(huge.json().error.code).toBe("VALIDATION_FAILED");
    await answer(h, claim.questionId, answerHex(0n), XDAI, ALICE);
    await moveTo(h, h.b.now() + TIMEOUT);
    expect((await postJson(h, "/api/v1/oracle/plans/submit-answer", { market: claim.market, outcome: "no", bond: (2n * XDAI).toString() })).statusCode).toBe(422);
  });

  it("refuses a first answer below minBond (no plan stored; the quota precedes the build, PRD-04 4b)", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "a2b");
    expect(claim.minBond).toBeGreaterThan(1n);
    for (const bond of [claim.minBond - 1n, claim.minBond / 2n, 1n]) {
      const response = await postJson(h, "/api/v1/oracle/plans/submit-answer", { market: claim.market, outcome: "no", bond: bond.toString() });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.message).toContain(`at least ${claim.minBond.toString()} wei`);
    }
    // plans_per_day is consumed before the build (so an exhausted quota makes no RPC call): one unit per refused key.
    expect(h.ctx.quotas.used.get(`${h.session.userId}:plans_per_day`)).toBe(3);
    expect(await h.ctx.database.sql.query("SELECT id FROM markets_plans")).toEqual([]);
    // Exactly minBond is accepted for the first answer.
    expect((await postJson(h, "/api/v1/oracle/plans/submit-answer", { market: claim.market, outcome: "no", bond: claim.minBond.toString() })).statusCode).toBe(201);
  });

  it("SEC-IDX-07 every oracle helper route refuses with NOT_READY while the read model lags (not only when halted)", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "a3l");
    const lag = h.ctx.config.maxIndexerLagSeconds;
    const requests: [string, Record<string, unknown>][] = [
      ["/api/v1/oracle/plans/submit-answer", { market: claim.market, outcome: "yes", bond: claim.minBond.toString() }],
      ["/api/v1/oracle/plans/fund-bounty", { market: claim.market, amount: "1" }],
      ["/api/v1/oracle/plans/resolve", { market: claim.market }],
      ["/api/v1/oracle/plans/reopen", { market: claim.market }],
      ["/api/v1/oracle/plans/handle-notified-request", { market: claim.market }],
      ["/api/v1/oracle/plans/handle-rejected-request", { market: claim.market }],
      ["/api/v1/oracle/plans/report-arbitration-answer", { market: claim.market }],
      ["/api/v1/oracle/plans/claim-winnings", { market: claim.market }],
      ["/api/v1/oracle/plans/withdraw", {}],
    ];
    // Indexed up to now, then the clock runs ahead by more than the allowed lag (the indexer is not halted).
    h.at(h.ctx.clock.unix() + lag + 1);
    expect((await h.ctx.readModel.status()).halted).toBe(false);
    for (const [url, body] of requests) {
      const response = await postJson(h, url, body);
      expect(response.statusCode, url).toBe(503);
      expect(response.json().error.code, url).toBe("NOT_READY");
    }
    // Refused before any argument is derived: no eth_call, no plan, no quota.
    expect(h.chain.calls).toEqual([]);
    expect(h.ctx.quotas.used.size).toBe(0);
    expect(await h.ctx.database.sql.query("SELECT id FROM markets_plans")).toEqual([]);
    // At exactly the allowed lag the read model counts as fresh again.
    h.at(h.ctx.clock.unix() - 1);
    expect((await postJson(h, requests[0]![0], requests[0]![1])).statusCode).toBe(201);
  });

  it("an exhausted plans_per_day quota refuses every oracle helper route before any eth_call (quota before build)", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "a3q");
    h.ctx.quotas.limits.plans_per_day = 0;
    const requests: [string, Record<string, unknown>][] = [
      ["/api/v1/oracle/plans/submit-answer", { market: claim.market, outcome: "yes", bond: claim.minBond.toString() }],
      ["/api/v1/oracle/plans/fund-bounty", { market: claim.market, amount: "1" }],
      ["/api/v1/oracle/plans/resolve", { market: claim.market }],
      ["/api/v1/oracle/plans/reopen", { market: claim.market }],
      ["/api/v1/oracle/plans/handle-notified-request", { market: claim.market }],
      ["/api/v1/oracle/plans/handle-rejected-request", { market: claim.market }],
      ["/api/v1/oracle/plans/report-arbitration-answer", { market: claim.market }],
      ["/api/v1/oracle/plans/claim-winnings", { market: claim.market }],
      ["/api/v1/oracle/plans/withdraw", {}],
    ];
    for (const [url, body] of requests) {
      const response = await postJson(h, url, body);
      expect(response.statusCode, url).toBe(429);
      expect(response.json().error.code, url).toBe("QUOTA_EXCEEDED");
    }
    expect(h.chain.calls).toEqual([]);
    expect(await h.ctx.database.sql.query("SELECT id FROM markets_plans")).toEqual([]);
  });

  it("SEC-IDX-07 NOT_READY when stale; SEC-LEGAL-01 compliance refusal", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "a3");
    h.ctx.readModel.setHalted(true);
    expect((await postJson(h, "/api/v1/oracle/plans/submit-answer", { market: claim.market, outcome: "yes", bond: XDAI.toString() })).statusCode).toBe(503);
    h.ctx.readModel.setHalted(false);
    h.ctx.compliance.blockedActions.add("answer_oracle");
    expect((await postJson(h, "/api/v1/oracle/plans/submit-answer", { market: claim.market, outcome: "yes", bond: XDAI.toString() })).statusCode).toBe(451);
    expect(h.ctx.quotas.used.size).toBe(0);
  });
});

describe("wei and integer fields refuse malformed input with 400, never 500 (zod 4 refine after a failed regex)", () => {
  const MALFORMED = ["abc", "1.5", "-1", "", "9".repeat(79)];

  it("bond (submit-answer) and amount (fund-bounty), signed in and anonymous", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "wei");
    const cases: [string, (value: string) => Record<string, unknown>][] = [
      ["/api/v1/oracle/plans/submit-answer", (bond) => ({ market: claim.market, outcome: "yes", bond })],
      ["/api/v1/oracle/plans/fund-bounty", (amount) => ({ market: claim.market, amount })],
    ];
    for (const [url, body] of cases) {
      for (const value of MALFORMED) {
        for (const headers of [h.headers, {}]) {
          const response = await postJson(h, url, body(value), { headers });
          expect({ url, value, status: response.statusCode, code: response.json().error?.code }).toEqual({ url, value, status: 400, code: "VALIDATION_FAILED" });
        }
      }
    }
    expect(h.ctx.quotas.used.size).toBe(0);
    expect(await h.ctx.database.sql.query("SELECT id FROM markets_plans")).toEqual([]);
  });

  it("submission ids (reveal-template body, evidence detail and ERC-1497 params)", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "ids");
    for (const value of MALFORMED) {
      const template = await postJson(h, "/api/v1/evidence/reveal-template", { submissionId: value, contentSha256: `0x${"ab".repeat(32)}` }, { key: null });
      expect({ value, status: template.statusCode, code: template.json().error?.code }).toEqual({ value, status: 400, code: "VALIDATION_FAILED" });
      if (value === "") continue;
      for (const suffix of ["", "/erc1497.json"]) {
        const url = `/api/v1/markets/${claim.market}/evidence/${EVIDENCE_REGISTRY}/${encodeURIComponent(value)}${suffix}`;
        const response = await h.app.inject({ method: "GET", url });
        expect({ url, status: response.statusCode, code: response.json().error?.code }).toEqual({ url, status: 400, code: "VALIDATION_FAILED" });
      }
    }
  });
});

describe("other oracle helper plans", () => {
  it("fund-bounty while open; resolve only after a final, non-too-soon answer", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "f1");
    const bounty = await postJson(h, "/api/v1/oracle/plans/fund-bounty", { market: claim.market, amount: "5" });
    expect(verifiedPlan(bounty.json().plan, claim).steps[0]).toMatchObject({ allowlistId: "realitio.fundAnswerBounty", value: 5n, args: [claim.questionId] });
    expect((await postJson(h, "/api/v1/oracle/plans/resolve", { market: claim.market })).statusCode).toBe(422);
    await answer(h, claim.questionId, answerHex(1n), XDAI, ALICE);
    await moveTo(h, h.b.now() + TIMEOUT);
    const resolve = await postJson(h, "/api/v1/oracle/plans/resolve", { market: claim.market });
    expect(resolve.statusCode).toBe(201);
    expect(verifiedPlan(resolve.json().plan, claim).steps[0]).toMatchObject({ allowlistId: "realityProxy.resolve", to: MANIFEST.seer.realityProxy, args: [claim.market] });
    // SEC-TX-01: the plan verifies only against the claim it was built for.
    expect(() => verifiedPlan(resolve.json().plan, { ...claim, market: "0x00000000000000000000000000000000000000ff" })).toThrow(/registered claim market/);
    expect((await postJson(h, "/api/v1/oracle/plans/fund-bounty", { market: claim.market, amount: "5" })).statusCode).toBe(422);
  });

  it("handleNotifiedRequest / handleRejectedRequest take the requester from the indexed Kleros stage", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "k1");
    await answer(h, claim.questionId, answerHex(1n), XDAI, ALICE);
    expect((await postJson(h, "/api/v1/oracle/plans/handle-notified-request", { market: claim.market })).statusCode).toBe(422);
    h.b.nextBlock();
    await h.apply({ ...h.b.envelope(PROXY), kind: "KlerosHome", stage: "RequestNotified", questionId: claim.questionId, requester: BOB, maxPrevious: XDAI, reason: null, answer: null });
    const notified = await postJson(h, "/api/v1/oracle/plans/handle-notified-request", { market: claim.market });
    expect(verifiedPlan(notified.json().plan, claim).steps[0]).toMatchObject({ allowlistId: "klerosHomeProxy.handleNotifiedRequest", to: MANIFEST.kleros.homeProxy, args: [claim.questionId, BOB] });
    expect((await postJson(h, "/api/v1/oracle/plans/handle-rejected-request", { market: claim.market })).statusCode).toBe(422);
    h.b.nextBlock();
    await h.apply({ ...h.b.envelope(PROXY), kind: "KlerosHome", stage: "RequestRejected", questionId: claim.questionId, requester: BOB, maxPrevious: 1n, reason: "Bond has changed", answer: null });
    const rejected = await postJson(h, "/api/v1/oracle/plans/handle-rejected-request", { market: claim.market });
    expect(verifiedPlan(rejected.json().plan, claim).steps[0]).toMatchObject({ allowlistId: "klerosHomeProxy.handleRejectedRequest", args: [claim.questionId, BOB] });
  });

  it("reportArbitrationAnswer uses the second-to-last hash and the raw commitment id, self-checked against getHistoryHash", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "r1");
    const h1 = await answer(h, claim.questionId, answerHex(1n), XDAI, ALICE);
    const commitmentId = `0x${"c7".repeat(32)}` as Hex32;
    await answer(h, claim.questionId, commitmentId, 2n * XDAI, BOB, true);
    h.b.nextBlock();
    await h.apply(
      { ...h.b.envelope(PROXY), kind: "KlerosHome", stage: "RequestNotified", questionId: claim.questionId, requester: ALICE, maxPrevious: 2n * XDAI, reason: null, answer: null },
      { ...h.b.envelope(REALITY), kind: "RealityArbitrationRequested", questionId: claim.questionId, user: ALICE },
    );
    h.b.nextBlock();
    await h.apply({ ...h.b.envelope(PROXY), kind: "KlerosHome", stage: "ArbitratorAnswered", questionId: claim.questionId, requester: null, maxPrevious: null, reason: null, answer: answerHex(1n) });
    const response = await postJson(h, "/api/v1/oracle/plans/report-arbitration-answer", { market: claim.market });
    expect(response.statusCode).toBe(201);
    expect(verifiedPlan(response.json().plan, claim).steps[0]).toMatchObject({ allowlistId: "klerosHomeProxy.reportArbitrationAnswer", args: [claim.questionId, h1, commitmentId, BOB] });
    // A history hash that the indexed records do not reproduce refuses the plan (no misread argument reaches a wallet).
    h.chain.historyHashes.set(claim.questionId, `0x${"ee".repeat(32)}`);
    const mismatch = await postJson(h, "/api/v1/oracle/plans/report-arbitration-answer", { market: claim.market });
    expect(mismatch.statusCode).toBe(422);
  });

  it("claimWinnings reconstructs the history from the current on-chain hash and refuses a mismatching chain", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "w1");
    const h1 = await answer(h, claim.questionId, answerHex(1n), XDAI, ALICE);
    const commitmentId = `0x${"c8".repeat(32)}` as Hex32;
    const h2 = await answer(h, claim.questionId, commitmentId, 2n * XDAI, BOB, true);
    await answer(h, claim.questionId, answerHex(1n), 4n * XDAI, ALICE);
    await moveTo(h, h.b.now() + TIMEOUT);
    const response = await postJson(h, "/api/v1/oracle/plans/claim-winnings", { market: claim.market });
    expect(response.statusCode).toBe(201);
    const [step] = verifiedPlan(response.json().plan, claim).steps;
    expect(step?.args).toEqual([claim.questionId, [h2, h1, ZERO32], [ALICE, BOB, ALICE], [4n * XDAI, 2n * XDAI, XDAI], [answerHex(1n), commitmentId, answerHex(1n)]]);
    // After a partial claim Reality's hash is h2: only the still-unclaimed entries remain.
    h.chain.historyHashes.set(claim.questionId, h2);
    const partial = await postJson(h, "/api/v1/oracle/plans/claim-winnings", { market: claim.market });
    expect(verifiedPlan(partial.json().plan, claim).steps[0]?.args).toEqual([claim.questionId, [h1, ZERO32], [BOB, ALICE], [2n * XDAI, XDAI], [commitmentId, answerHex(1n)]]);
    h.chain.historyHashes.set(claim.questionId, `0x${"ee".repeat(32)}`);
    expect((await postJson(h, "/api/v1/oracle/plans/claim-winnings", { market: claim.market })).statusCode).toBe(422);
    h.chain.historyHashes.set(claim.questionId, ZERO32);
    expect((await postJson(h, "/api/v1/oracle/plans/claim-winnings", { market: claim.market })).statusCode).toBe(422);
  });

  it("claimWinnings also covers the original settled-too-soon question after a reopen (hand-computed arguments)", async () => {
    const h = harnessOf();
    const claim = await openClaim(h, "w2");
    const o1 = await answer(h, claim.questionId, REALITY_ANSWERED_TOO_SOON, XDAI, ALICE);
    await answer(h, claim.questionId, REALITY_ANSWERED_TOO_SOON, 2n * XDAI, BOB);
    await moveTo(h, h.b.now() + TIMEOUT + 1);
    const replacement = `0x${"5f".repeat(32)}` as Hex32;
    h.b.nextBlock();
    await h.apply({ ...h.b.envelope(REALITY), kind: "RealityQuestionReopened", questionId: replacement, reopenedQuestionId: claim.questionId });
    h.chain.reopened.set(claim.questionId, replacement);
    await moveTo(h, h.b.now() + 10);
    await answer(h, replacement, answerHex(0n), XDAI, BOB);
    await moveTo(h, h.b.now() + TIMEOUT + 1);
    const response = await postJson(h, "/api/v1/oracle/plans/claim-winnings", { market: claim.market });
    expect(response.statusCode).toBe(201);
    const steps = verifiedPlan(response.json().plan, claim, [replacement]).steps;
    expect(steps.map((step) => step.args)).toEqual([
      [replacement, [ZERO32], [BOB], [XDAI], [answerHex(0n)]],
      [claim.questionId, [o1, ZERO32], [BOB, ALICE], [2n * XDAI, XDAI], [REALITY_ANSWERED_TOO_SOON, REALITY_ANSWERED_TOO_SOON]],
    ]);
    // Once the original was claimed (history hash 0) only the replacement remains.
    h.chain.historyHashes.set(claim.questionId, ZERO32);
    const again = await postJson(h, "/api/v1/oracle/plans/claim-winnings", { market: claim.market });
    expect(verifiedPlan(again.json().plan, claim, [replacement]).steps.map((step) => step.args[0])).toEqual([replacement]);
  });

  it("withdraw needs a Reality balance of the session wallet", async () => {
    const h = harnessOf();
    expect((await postJson(h, "/api/v1/oracle/plans/withdraw", {})).statusCode).toBe(422);
    h.chain.balances.set(h.session.wallet, 7n);
    const response = await postJson(h, "/api/v1/oracle/plans/withdraw", {});
    expect(response.statusCode).toBe(201);
    expect(verifiedPlan(response.json().plan, null).steps[0]).toMatchObject({ allowlistId: "realitio.withdraw", args: [] });
  });
});

describe("POST /api/v1/oracle/plans/reopen", () => {
  const SEP = "\u241f";

  /** Hand-computed Reality ids (raw packed bytes). */
  function ids(marketName: string, openingTs: number, minBond: bigint) {
    const question = `${marketName}${SEP}"Yes","No"${SEP}misc${SEP}en_US`;
    const contentHash = keccak256(concat([toHex(2n, { size: 32 }), toHex(openingTs, { size: 4 }), stringToHex(question)]));
    const idFor = (asker: Address, nonce: bigint) =>
      keccak256(concat([contentHash, MANIFEST.seer.arbitrator, toHex(TIMEOUT, { size: 4 }), toHex(minBond, { size: 32 }), MANIFEST.seer.realitio, asker, toHex(nonce, { size: 32 })]));
    return { question, idFor };
  }

  async function tooSoonClaim(h: Harness, seed: string) {
    chains.clear();
    const marketName = `Pine claim [Claim ${seed}]: was a reproducible counterexample submitted?`;
    const opening = h.b.now() + 9 * 86_400;
    const { question, idFor } = ids(marketName, opening, XDAI);
    const original = idFor(MANIFEST.seer.marketFactory, 0n);
    await h.apply(claimCreated(h.b, seed, { questionId: original, revealDeadline: opening }));
    const claim = (await h.ctx.readModel.getClaim(`0x${keccak256(stringToHex(`market:${seed}`)).slice(26)}` as Address))!;
    h.chain.timeouts.set(original, TIMEOUT);
    h.chain.questionParams.set(original, { arbitrator: MANIFEST.seer.arbitrator, openingTs: opening, minBond: XDAI });
    await moveTo(h, opening + 10);
    await answer(h, original, REALITY_ANSWERED_TOO_SOON, XDAI, ALICE);
    await moveTo(h, h.b.now() + TIMEOUT + 1);
    return { claim, question, idFor, original, opening };
  }

  it("re-creates the original question exactly; the nonce of a second reopen skips an existing id (hand-computed)", async () => {
    const h = harnessOf();
    const { claim, question, idFor, original, opening } = await tooSoonClaim(h, "reopen-1");
    const first = await postJson(h, "/api/v1/oracle/plans/reopen", { market: claim.market });
    expect(first.statusCode).toBe(201);
    const step = verifiedPlan(first.json().plan, claim).steps[0];
    expect(step).toMatchObject({ allowlistId: "realitio.reopenQuestion", value: 0n, args: [2n, question, MANIFEST.seer.arbitrator, TIMEOUT, opening, 0n, XDAI, original] });
    expect(first.json().details.expectedQuestionId).toBe(idFor(h.session.wallet, 0n));

    // The first reopen happened and its replacement settled too soon as well: reopen the ORIGINAL again with nonce 1.
    const firstReplacement = idFor(h.session.wallet, 0n);
    h.chain.timeouts.set(firstReplacement, TIMEOUT);
    h.b.nextBlock();
    await h.apply({ ...h.b.envelope(REALITY), kind: "RealityQuestionReopened", questionId: firstReplacement, reopenedQuestionId: original });
    h.chain.reopened.set(original, firstReplacement);
    await moveTo(h, h.b.now() + 60);
    await answer(h, firstReplacement, REALITY_ANSWERED_TOO_SOON, XDAI, BOB);
    await moveTo(h, h.b.now() + TIMEOUT + 1);
    const second = await postJson(h, "/api/v1/oracle/plans/reopen", { market: claim.market });
    expect(second.statusCode).toBe(201);
    const args = verifiedPlan(second.json().plan, claim, [firstReplacement]).steps[0]?.args;
    expect(args?.[5]).toBe(1n);
    expect(args?.[7]).toBe(original);
    expect(second.json().details.expectedQuestionId).toBe(idFor(h.session.wallet, 1n));
  });

  it("refuses when the question did not settle too soon or cannot be re-created exactly; CONFLICT without a free nonce", async () => {
    const h = harnessOf();
    const open = await openClaim(h, "reopen-2");
    expect((await postJson(h, "/api/v1/oracle/plans/reopen", { market: open.market })).statusCode).toBe(422);
    const { claim, idFor } = await tooSoonClaim(h, "reopen-3");
    for (let n = 0n; n <= 15n; n += 1n) h.chain.timeouts.set(idFor(h.session.wallet, n), TIMEOUT);
    expect((await postJson(h, "/api/v1/oracle/plans/reopen", { market: claim.market })).statusCode).toBe(409);
    // A fixture question id that is not Seer's derivation: the module refuses rather than guessing.
    chains.clear();
    const fake = await addClaim(h, "reopen-4");
    h.chain.timeouts.set(fake.questionId, TIMEOUT);
    h.chain.questionParams.set(fake.questionId, { arbitrator: MANIFEST.seer.arbitrator, openingTs: fake.revealDeadline, minBond: fake.minBond });
    await moveTo(h, fake.revealDeadline + 1);
    await answer(h, fake.questionId, REALITY_ANSWERED_TOO_SOON, XDAI, ALICE);
    await moveTo(h, h.b.now() + TIMEOUT + 1);
    const refused = await postJson(h, "/api/v1/oracle/plans/reopen", { market: fake.market });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.message).toMatch(/re-created exactly/);
  });
});
