// dueActions (PRD-04 section 2.3, ADR D7): a pure function over read-model facts plus values read by eth_call at
// request time. It lists the permissionless actions possible now; Pine never performs any of them itself.

import { classifyAnswer, deriveOracleStatus, type ArbitrationRecord, type ClaimRecord, type ConditionResolutionRecord, type OracleQuestionRecord, type OracleStatus } from "@pine/shared/read-model";
import type { Address, Hex32 } from "@pine/shared/types";
import { NULL_HASH } from "./history.js";

export type DueActionName =
  | "answer"
  | "fund_bounty"
  | "request_arbitration_on_ethereum"
  | "handle_notified_request"
  | "handle_rejected_request"
  | "report_arbitration_answer"
  | "reopen_question"
  | "resolve_market"
  | "claim_winnings"
  | "withdraw";

export interface DueAction {
  action: DueActionName;
  questionId: Hex32 | null;
  /** Path of the Pine plan route for this action, or null when only instructions exist (Ethereum mainnet steps). */
  planRoute: string | null;
  details: Record<string, unknown>;
}

export interface ChainFacts {
  /** Reality getHistoryHash(current question), read once the current question is finalized; null when not read. */
  historyHash: Hex32 | null;
  /** getHistoryHash(original claim question) when it differs from the current one and settled too soon. */
  originalHistoryHash: Hex32 | null;
  /** Reality balanceOf(account), only when an account was given. */
  balance: bigint | null;
}

export interface DueActionInput {
  now: number;
  claim: ClaimRecord;
  /** The current question (the latest replacement after a reopen, otherwise the claim's question). */
  question: OracleQuestionRecord | null;
  /** The claim's original question record (equal to `question` unless reopened). */
  original: OracleQuestionRecord | null;
  answerCount: number;
  arbitration: ArbitrationRecord | null;
  resolution: ConditionResolutionRecord | null;
  /** Null when no eth_call values are available (the watch job uses read-model facts only). */
  chain: ChainFacts | null;
  account: Address | null;
  klerosForeignProxy: Address;
  klerosForeignChainId: number;
}

export type Phase = "evidence_open" | "reveal_open" | "oracle_open" | "pending_arbitration" | "finalized" | "resolved";

export function phaseOf(claim: Pick<ClaimRecord, "evidenceDeadline" | "revealDeadline">, status: OracleStatus | null, resolution: ConditionResolutionRecord | null, now: number): Phase {
  if (resolution) return "resolved";
  if (now < claim.evidenceDeadline) return "evidence_open";
  if (now < claim.revealDeadline) return "reveal_open";
  if (status?.state === "pending_arbitration") return "pending_arbitration";
  if (status?.state === "finalized") return "finalized";
  return "oracle_open";
}

const XDAI_BOND_NOTE = "Bonds are paid in native xDAI by your own wallet; Pine never answers or bonds.";

export function dueActions(input: DueActionInput): DueAction[] {
  const actions: DueAction[] = [];
  const question = input.question;
  if (!question) return actions;
  const status = deriveOracleStatus(question, input.now);
  const qid = question.questionId;

  if (status.state === "open_unanswered" || status.state === "answered") {
    const currentBond = question.bond;
    const doubled = 2n * currentBond;
    const minimum = doubled > question.minBond ? doubled : question.minBond;
    actions.push({ action: "answer", questionId: qid, planRoute: "/api/v1/oracle/plans/submit-answer", details: { minimumBond: minimum, maxPrevious: currentBond, note: XDAI_BOND_NOTE } });
    actions.push({ action: "fund_bounty", questionId: qid, planRoute: "/api/v1/oracle/plans/fund-bounty", details: { currentBounty: question.bounty } });
  }
  if (status.state === "answered") {
    actions.push({
      action: "request_arbitration_on_ethereum",
      questionId: qid,
      planRoute: null,
      details: {
        chainId: input.klerosForeignChainId,
        foreignProxy: input.klerosForeignProxy,
        function: "requestArbitration(bytes32 _questionID, uint256 _maxPrevious)",
        maxPrevious: question.bond,
        finalizesAt: status.finalizesAt,
        note: "Paid in ETH on Ethereum mainnet (fee from getDisputeFee(questionId)); Pine issues no mainnet plans. Allow ~30 min for the bridge before finalization.",
      },
    });
  }

  const arbitration = input.arbitration;
  if (arbitration && arbitration.questionId.toLowerCase() === qid.toLowerCase()) {
    if (arbitration.stage === "RequestNotified" && arbitration.requester) {
      actions.push({ action: "handle_notified_request", questionId: qid, planRoute: "/api/v1/oracle/plans/handle-notified-request", details: { requester: arbitration.requester } });
    }
    if (arbitration.stage === "RequestRejected" && arbitration.requester) {
      actions.push({ action: "handle_rejected_request", questionId: qid, planRoute: "/api/v1/oracle/plans/handle-rejected-request", details: { requester: arbitration.requester } });
    }
    if (arbitration.stage === "ArbitratorAnswered" && input.answerCount > 0) {
      actions.push({ action: "report_arbitration_answer", questionId: qid, planRoute: "/api/v1/oracle/plans/report-arbitration-answer", details: { arbitratorAnswer: arbitration.arbitratorAnswer } });
    }
  }

  if (status.state === "finalized") {
    if (status.outcome === "answered_too_soon") {
      actions.push({ action: "reopen_question", questionId: input.claim.questionId, planRoute: "/api/v1/oracle/plans/reopen", details: { reopens: input.claim.questionId } });
    } else if (!input.resolution) {
      actions.push({ action: "resolve_market", questionId: qid, planRoute: "/api/v1/oracle/plans/resolve", details: { market: input.claim.market } });
    }
    if (input.chain?.historyHash && input.chain.historyHash !== NULL_HASH) {
      actions.push({ action: "claim_winnings", questionId: qid, planRoute: "/api/v1/oracle/plans/claim-winnings", details: { historyHash: input.chain.historyHash } });
    }
  }
  const original = input.original;
  if (original && original.questionId !== qid && input.chain?.originalHistoryHash && input.chain.originalHistoryHash !== NULL_HASH) {
    const originalStatus = deriveOracleStatus(original, input.now);
    if (originalStatus.state === "finalized") {
      actions.push({ action: "claim_winnings", questionId: original.questionId, planRoute: "/api/v1/oracle/plans/claim-winnings", details: { historyHash: input.chain.originalHistoryHash, settledTooSoon: true } });
    }
  }
  if (input.account && input.chain?.balance && input.chain.balance > 0n) {
    actions.push({ action: "withdraw", questionId: null, planRoute: "/api/v1/oracle/plans/withdraw", details: { account: input.account, balance: input.chain.balance } });
  }
  return actions;
}

/** True when the question's best answer is Reality's "answered too soon" and it is final. */
export function settledTooSoon(question: OracleQuestionRecord | null, now: number): boolean {
  if (!question) return false;
  const status = deriveOracleStatus(question, now);
  return status.state === "finalized" && question.bestAnswer !== null && classifyAnswer(question.bestAnswer) === "answered_too_soon";
}
