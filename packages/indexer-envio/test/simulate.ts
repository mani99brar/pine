// Converts frozen ChainEvents into Envio simulate items (the decoded log each event stands for), with explicit block,
// timestamp, block hash, transaction hash and log index so createTestIndexer processes them at their real positions.

import type { ChainEvent } from "@pine/shared/chain-events";
import type { TestIndexer } from "envio";

type ProcessConfig = Parameters<TestIndexer["process"]>[0];
type ChainConfig = NonNullable<ProcessConfig["chains"][100]>;
export type SimulateItem = NonNullable<ChainConfig["simulate"]>[number];

export function toSimulateItem(event: ChainEvent): SimulateItem {
  const position = {
    srcAddress: event.address,
    logIndex: event.logIndex,
    block: { number: Number(event.blockNumber), timestamp: event.blockTimestamp, hash: event.blockHash },
    transaction: { hash: event.transactionHash },
  };
  switch (event.kind) {
    case "ClaimCreated":
      return {
        ...position,
        contract: "ClaimRegistry",
        event: "ClaimCreated",
        params: {
          market: event.market,
          creator: event.creator,
          claimDocumentSha256: event.claimDocumentSha256,
          claim: {
            creator: event.creator,
            createdAt: BigInt(event.blockTimestamp),
            evidenceDeadline: BigInt(event.evidenceDeadline),
            revealDeadline: BigInt(event.revealDeadline),
            repositoryId: BigInt(event.repositoryId),
            commit: `0x${event.commit}`,
            claimDocumentSha256: event.claimDocumentSha256,
            policyDocumentSha256: event.policyDocumentSha256,
            questionId: event.questionId,
            conditionId: event.conditionId,
            marketNameHash: event.marketNameHash,
            minBond: event.minBond,
            yesToken: event.yesToken,
            noToken: event.noToken,
            invalidToken: event.invalidToken,
          },
          title: event.title,
          marketName: event.marketName,
        },
      };
    case "EvidenceCommitted":
      return {
        ...position,
        contract: "EvidenceRegistry",
        event: "EvidenceCommitted",
        params: { submissionId: event.submissionId, market: event.market, submitter: event.submitter, commitment: event.commitment, committedAt: BigInt(event.committedAt) },
      };
    case "EvidenceRevealed":
      return {
        ...position,
        contract: "EvidenceRegistry",
        event: "EvidenceRevealed",
        params: {
          submissionId: event.submissionId,
          market: event.market,
          submitter: event.submitter,
          contentSha256: event.contentSha256,
          committedAt: BigInt(event.committedAt),
          revealedAt: BigInt(event.revealedAt),
        },
      };
    case "EvidencePublished":
      return {
        ...position,
        contract: "EvidenceRegistry",
        event: "EvidencePublished",
        params: { submissionId: event.submissionId, market: event.market, submitter: event.submitter, contentSha256: event.contentSha256, publishedAt: BigInt(event.publishedAt) },
      };
    case "RealityNewAnswer":
      return {
        ...position,
        contract: "RealityETH",
        event: "LogNewAnswer",
        params: {
          answer: event.answer,
          question_id: event.questionId,
          history_hash: event.historyHash,
          user: event.user,
          bond: event.bond,
          ts: BigInt(event.ts),
          is_commitment: event.isCommitment,
        },
      };
    case "RealityAnswerReveal":
      return {
        ...position,
        contract: "RealityETH",
        event: "LogAnswerReveal",
        params: { question_id: event.questionId, user: event.user, answer_hash: event.answerHash, answer: event.answer, nonce: event.nonce, bond: event.bond },
      };
    case "RealityArbitrationRequested":
      return { ...position, contract: "RealityETH", event: "LogNotifyOfArbitrationRequest", params: { question_id: event.questionId, user: event.user } };
    case "RealityArbitrationCancelled":
      return { ...position, contract: "RealityETH", event: "LogCancelArbitration", params: { question_id: event.questionId } };
    case "RealityArbitratorAnswered":
      return { ...position, contract: "RealityETH", event: "LogFinalize", params: { question_id: event.questionId, answer: event.answer } };
    case "RealityQuestionReopened":
      return { ...position, contract: "RealityETH", event: "LogReopenQuestion", params: { question_id: event.questionId, reopened_question_id: event.reopenedQuestionId } };
    case "RealityBountyFunded":
      return {
        ...position,
        contract: "RealityETH",
        event: "LogFundAnswerBounty",
        params: { question_id: event.questionId, bounty_added: event.bountyAdded, bounty: event.bounty, user: event.user },
      };
    case "ConditionResolution":
      return {
        ...position,
        contract: "ConditionalTokens",
        event: "ConditionResolution",
        params: {
          conditionId: event.conditionId,
          oracle: event.oracle,
          questionId: event.ctfQuestionId,
          outcomeSlotCount: BigInt(event.outcomeSlotCount),
          payoutNumerators: [...event.payoutNumerators],
        },
      };
    case "KlerosHome":
      return klerosItem(event, position);
  }
}

type Position = Pick<SimulateItem, "srcAddress" | "logIndex" | "block" | "transaction">;

function klerosItem(event: ChainEvent & { kind: "KlerosHome" }, position: Position): SimulateItem {
  const requester = (): `0x${string}` => {
    if (event.requester === null) throw new Error(`${event.stage} needs a requester`);
    return event.requester;
  };
  switch (event.stage) {
    case "RequestNotified":
      return { ...position, contract: "KlerosHomeProxy", event: "RequestNotified", params: { _questionID: event.questionId, _requester: requester(), _maxPrevious: event.maxPrevious ?? 0n } };
    case "RequestRejected":
      return {
        ...position,
        contract: "KlerosHomeProxy",
        event: "RequestRejected",
        params: { _questionID: event.questionId, _requester: requester(), _maxPrevious: event.maxPrevious ?? 0n, _reason: event.reason ?? "" },
      };
    case "RequestAcknowledged":
      return { ...position, contract: "KlerosHomeProxy", event: "RequestAcknowledged", params: { _questionID: event.questionId, _requester: requester() } };
    case "RequestCanceled":
      return { ...position, contract: "KlerosHomeProxy", event: "RequestCanceled", params: { _questionID: event.questionId, _requester: requester() } };
    case "ArbitrationFailed":
      return { ...position, contract: "KlerosHomeProxy", event: "ArbitrationFailed", params: { _questionID: event.questionId, _requester: requester() } };
    case "ArbitratorAnswered":
      if (event.answer === null) throw new Error("ArbitratorAnswered needs an answer");
      return { ...position, contract: "KlerosHomeProxy", event: "ArbitratorAnswered", params: { _questionID: event.questionId, _answer: event.answer } };
    case "ArbitrationFinished":
      return { ...position, contract: "KlerosHomeProxy", event: "ArbitrationFinished", params: { _questionID: event.questionId } };
  }
}
