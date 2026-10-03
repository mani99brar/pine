// Pure dueActions over read-model records; no database (no suite lock: it holds no in-memory Postgres).
import { describe, expect, it } from "vitest";
import { REALITY_ANSWERED_TOO_SOON, type ArbitrationRecord, type ClaimRecord, type OracleQuestionRecord } from "@pine/shared/read-model";
import type { KlerosHomeStage } from "@pine/shared/chain-events";
import type { Address, Hex32 } from "@pine/shared/types";
import { dueActions, phaseOf, type DueActionInput } from "./due-actions.js";

const Q = `0x${"71".repeat(32)}` as Hex32;
const Q2 = `0x${"72".repeat(32)}` as Hex32;
const NO = `0x${"0".repeat(63)}1` as Hex32;
const XDAI = 10n ** 18n;
const OPEN = 2_000;
const BOB = "0x0000000000000000000000000000000000000b0b" as Address;
const ACCOUNT = "0x00000000000000000000000000000000000a11ce" as Address;

const claim = { market: "0x00000000000000000000000000000000000000aa", questionId: Q, conditionId: `0x${"c0".repeat(32)}`, evidenceDeadline: 1_000, revealDeadline: OPEN } as unknown as ClaimRecord;

function question(overrides: Partial<OracleQuestionRecord> = {}): OracleQuestionRecord {
  return {
    questionId: Q,
    markets: [claim.market],
    openingTs: OPEN,
    minBond: XDAI,
    timeout: 302_400,
    bestAnswer: null,
    bond: 0n,
    finalizeTs: 0,
    pendingArbitration: false,
    arbitrationRequestedBy: null,
    answeredByArbitrator: false,
    bounty: 0n,
    reopenedBy: null,
    reopens: null,
    answerCount: 0,
    lastEventBlock: 1n,
    ...overrides,
  };
}

const arbitration = (stage: KlerosHomeStage, questionId: Hex32 = Q): ArbitrationRecord => ({ questionId, stage, requester: BOB, rejectionReason: null, arbitratorAnswer: stage === "ArbitratorAnswered" ? NO : null, updatedAt: 3_000, history: [] });

function input(overrides: Partial<DueActionInput>): DueActionInput {
  return {
    now: 1_500,
    claim,
    question: question(),
    original: question(),
    answerCount: 0,
    arbitration: null,
    resolution: null,
    chain: { historyHash: null, originalHistoryHash: null, balance: null },
    account: null,
    klerosForeignProxy: "0xfe0eb5fc686f929eb26d541d75bb59f816c0aa68",
    klerosForeignChainId: 1,
    ...overrides,
  };
}

const names = (value: DueActionInput) => dueActions(value).map((action) => action.action);
const answered = question({ bestAnswer: NO, bond: 4n * XDAI, finalizeTs: 10_000, answerCount: 3 });

describe("dueActions for every oracle state", () => {
  it("not_open: nothing to do before the opening time", () => {
    expect(names(input({ now: OPEN - 1 }))).toEqual([]);
  });

  it("open_unanswered: answer (min bond) and fund bounty", () => {
    const actions = dueActions(input({ now: OPEN }));
    expect(actions.map((action) => action.action)).toEqual(["answer", "fund_bounty"]);
    expect(actions[0]?.details).toMatchObject({ minimumBond: XDAI, maxPrevious: 0n });
  });

  it("answered: answer with a doubled bond, fund bounty, and arbitration on Ethereum as instructions only", () => {
    const actions = dueActions(input({ now: 5_000, question: answered, answerCount: 3 }));
    expect(actions.map((action) => action.action)).toEqual(["answer", "fund_bounty", "request_arbitration_on_ethereum"]);
    expect(actions[0]?.details).toMatchObject({ minimumBond: 8n * XDAI, maxPrevious: 4n * XDAI });
    expect(actions[2]).toMatchObject({ planRoute: null, details: { chainId: 1, maxPrevious: 4n * XDAI, foreignProxy: "0xfe0eb5fc686f929eb26d541d75bb59f816c0aa68" } });
  });

  it("pending_arbitration: each Kleros home stage yields its relay step (or nothing while waiting)", () => {
    const pending = question({ ...answered, pendingArbitration: true, arbitrationRequestedBy: BOB });
    const at = (stage: KlerosHomeStage) => names(input({ now: 5_000, question: pending, answerCount: 3, arbitration: arbitration(stage) }));
    expect(at("RequestNotified")).toEqual(["handle_notified_request"]);
    expect(at("RequestAcknowledged")).toEqual([]);
    expect(at("ArbitratorAnswered")).toEqual(["report_arbitration_answer"]);
    expect(at("ArbitrationFailed")).toEqual([]);
    // A rejected request leaves the question open (Reality was never notified).
    expect(names(input({ now: 5_000, question: answered, answerCount: 3, arbitration: arbitration("RequestRejected") }))).toEqual(["answer", "fund_bounty", "request_arbitration_on_ethereum", "handle_rejected_request"]);
    expect(names(input({ now: 5_000, question: pending, answerCount: 0, arbitration: arbitration("ArbitratorAnswered") }))).toEqual([]);
  });

  it("RequestCanceled: a handled rejection needs no relay step; the question is open again and arbitration can be re-requested", () => {
    // RequestCanceled follows handleRejectedRequest (the mainnet deposit is refunded); Reality was never notified, so
    // the question is answered and not pending, and handle_rejected_request must not be offered a second time.
    const canceled = dueActions(input({ now: 5_000, question: answered, answerCount: 3, arbitration: arbitration("RequestCanceled") }));
    expect(canceled.map((action) => action.action)).toEqual(["answer", "fund_bounty", "request_arbitration_on_ethereum"]);
    expect(canceled[2]).toMatchObject({ planRoute: null, details: { maxPrevious: 4n * XDAI } });
    // A home-side ArbitrationFailed (cancelArbitration reset the timer) likewise leaves only the open-question actions.
    const reset = question({ ...answered, finalizeTs: 5_000 + 302_400 });
    expect(names(input({ now: 5_000, question: reset, answerCount: 3, arbitration: arbitration("ArbitrationFailed") }))).toEqual(["answer", "fund_bounty", "request_arbitration_on_ethereum"]);
    // Once that question finalizes, the canceled request does not block resolution.
    expect(names(input({ now: 10_000, question: answered, answerCount: 3, arbitration: arbitration("RequestCanceled") }))).toEqual(["resolve_market"]);
  });

  it("finalized: resolve the market and claim winnings while the history hash is unclaimed", () => {
    const final = question({ bestAnswer: NO, bond: 4n * XDAI, finalizeTs: 10_000 });
    expect(names(input({ now: 10_000, question: final, chain: { historyHash: `0x${"12".repeat(32)}`, originalHistoryHash: null, balance: null } }))).toEqual(["resolve_market", "claim_winnings"]);
    expect(names(input({ now: 10_000, question: final, chain: { historyHash: `0x${"0".repeat(64)}`, originalHistoryHash: null, balance: null } }))).toEqual(["resolve_market"]);
    const byArbitrator = question({ bestAnswer: NO, finalizeTs: 9_000, answeredByArbitrator: true });
    expect(names(input({ now: 10_000, question: byArbitrator, arbitration: arbitration("ArbitrationFinished") }))).toEqual(["resolve_market"]);
    // Resolved: nothing left but claims and withdrawals.
    const resolution = { conditionId: claim.conditionId, ctfQuestionId: Q, payoutNumerators: [0n, 1n, 0n], resolvedAt: 10_001, txHash: Q, blockNumber: 5n };
    expect(names(input({ now: 10_002, question: final, resolution, account: ACCOUNT, chain: { historyHash: null, originalHistoryHash: null, balance: 5n } }))).toEqual(["withdraw"]);
  });

  it("answered too soon: reopen the ORIGINAL question; after a reopen the original can still be claimed", () => {
    const tooSoon = question({ bestAnswer: REALITY_ANSWERED_TOO_SOON, bond: XDAI, finalizeTs: 9_000 });
    const actions = dueActions(input({ now: 10_000, question: tooSoon, original: tooSoon }));
    expect(actions.map((action) => action.action)).toEqual(["reopen_question"]);
    expect(actions[0]).toMatchObject({ questionId: Q, details: { reopens: Q } });
    const replacement = question({ questionId: Q2, reopens: Q });
    const original = { ...tooSoon, reopenedBy: Q2 };
    const after = dueActions(input({ now: 10_000, question: replacement, original, chain: { historyHash: null, originalHistoryHash: `0x${"34".repeat(32)}`, balance: null } }));
    expect(after.map((action) => [action.action, action.questionId])).toEqual([
      ["answer", Q2],
      ["fund_bounty", Q2],
      ["claim_winnings", Q],
    ]);
    // The replacement settling too soon again leads to another reopen of the original.
    const replacementTooSoon = question({ questionId: Q2, reopens: Q, bestAnswer: REALITY_ANSWERED_TOO_SOON, bond: XDAI, finalizeTs: 9_500 });
    expect(dueActions(input({ now: 10_000, question: replacementTooSoon, original })).map((action) => [action.action, action.questionId])).toEqual([["reopen_question", Q]]);
  });

  it("withdraw appears only for a given account with a balance", () => {
    expect(names(input({ now: OPEN - 1, chain: { historyHash: null, originalHistoryHash: null, balance: 3n } }))).toEqual([]);
    expect(names(input({ now: OPEN - 1, account: ACCOUNT, chain: { historyHash: null, originalHistoryHash: null, balance: 3n } }))).toEqual(["withdraw"]);
    expect(names(input({ now: OPEN - 1, account: ACCOUNT, chain: { historyHash: null, originalHistoryHash: null, balance: 0n } }))).toEqual([]);
  });

  it("phase follows the deadlines, arbitration, finalization and resolution", () => {
    expect(phaseOf(claim, null, null, 999)).toBe("evidence_open");
    expect(phaseOf(claim, null, null, 1_000)).toBe("reveal_open");
    expect(phaseOf(claim, { state: "open_unanswered" }, null, OPEN)).toBe("oracle_open");
    expect(phaseOf(claim, { state: "pending_arbitration", outcome: "no", requestedBy: BOB }, null, 5_000)).toBe("pending_arbitration");
    expect(phaseOf(claim, { state: "finalized", outcome: "no", byArbitrator: false }, null, 20_000)).toBe("finalized");
    expect(phaseOf(claim, null, { conditionId: Q, ctfQuestionId: Q, payoutNumerators: [], resolvedAt: 1, txHash: Q, blockNumber: 1n }, 20_000)).toBe("resolved");
  });
});
