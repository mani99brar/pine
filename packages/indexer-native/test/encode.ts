// Test-only encoder: a ChainEvent back to the raw log its contract would emit (viem encodeEventTopics plus
// encodeAbiParameters over the shared ABIs). Lets the poller tests build scripted chains from the frozen scenarios.

import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type AbiParameter } from "viem";
import type { ChainEvent } from "@pine/shared/chain-events";
import type { Hex, Hex32 } from "@pine/shared/types";
import { EVENT_SPECS, type RawLog, type SourceName } from "../src/decode.js";

function spec(source: SourceName, name: string): AbiEvent {
  const found = EVENT_SPECS.find((item) => item.source === source && item.name === name);
  if (!found) throw new Error(`no spec ${source}.${name}`);
  return found.abiEvent;
}

/** Encodes `args` (by ABI parameter name) as the event's topics and data. */
export function encodeLog(event: AbiEvent, args: Record<string, unknown>): { topics: Hex32[]; data: Hex } {
  const indexed: Record<string, unknown> = {};
  const dataInputs: AbiParameter[] = [];
  const dataValues: unknown[] = [];
  for (const input of event.inputs) {
    if (!input.name) throw new Error("unnamed input");
    if (input.indexed) indexed[input.name] = args[input.name];
    else {
      dataInputs.push(input);
      dataValues.push(args[input.name]);
    }
  }
  const topics = encodeEventTopics({ abi: [event], eventName: event.name, args: indexed } as never) as Hex32[];
  const data = encodeAbiParameters(dataInputs, dataValues as never) as Hex;
  return { topics: topics.map((topic) => topic.toLowerCase() as Hex32), data };
}

export function sourceAndArgs(event: ChainEvent): { source: SourceName; name: string; args: Record<string, unknown> } {
  switch (event.kind) {
    case "ClaimCreated":
      return {
        source: "claimRegistry",
        name: "ClaimCreated",
        args: {
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
        source: "evidenceRegistry",
        name: "EvidenceCommitted",
        args: { submissionId: event.submissionId, market: event.market, submitter: event.submitter, commitment: event.commitment, committedAt: BigInt(event.committedAt) },
      };
    case "EvidenceRevealed":
      return {
        source: "evidenceRegistry",
        name: "EvidenceRevealed",
        args: {
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
        source: "evidenceRegistry",
        name: "EvidencePublished",
        args: { submissionId: event.submissionId, market: event.market, submitter: event.submitter, contentSha256: event.contentSha256, publishedAt: BigInt(event.publishedAt) },
      };
    case "RealityNewAnswer":
      return {
        source: "reality",
        name: "LogNewAnswer",
        args: { answer: event.answer, question_id: event.questionId, history_hash: event.historyHash, user: event.user, bond: event.bond, ts: BigInt(event.ts), is_commitment: event.isCommitment },
      };
    case "RealityAnswerReveal":
      return {
        source: "reality",
        name: "LogAnswerReveal",
        args: { question_id: event.questionId, user: event.user, answer_hash: event.answerHash, answer: event.answer, nonce: event.nonce, bond: event.bond },
      };
    case "RealityArbitrationRequested":
      return { source: "reality", name: "LogNotifyOfArbitrationRequest", args: { question_id: event.questionId, user: event.user } };
    case "RealityArbitrationCancelled":
      return { source: "reality", name: "LogCancelArbitration", args: { question_id: event.questionId } };
    case "RealityArbitratorAnswered":
      return { source: "reality", name: "LogFinalize", args: { question_id: event.questionId, answer: event.answer } };
    case "RealityQuestionReopened":
      return { source: "reality", name: "LogReopenQuestion", args: { question_id: event.questionId, reopened_question_id: event.reopenedQuestionId } };
    case "RealityBountyFunded":
      return { source: "reality", name: "LogFundAnswerBounty", args: { question_id: event.questionId, bounty_added: event.bountyAdded, bounty: event.bounty, user: event.user } };
    case "ConditionResolution":
      return {
        source: "conditionalTokens",
        name: "ConditionResolution",
        args: { conditionId: event.conditionId, oracle: event.oracle, questionId: event.ctfQuestionId, outcomeSlotCount: BigInt(event.outcomeSlotCount), payoutNumerators: event.payoutNumerators },
      };
    case "KlerosHome":
      return {
        source: "klerosHomeProxy",
        name: event.stage,
        args: { _questionID: event.questionId, _requester: event.requester, _maxPrevious: event.maxPrevious, _reason: event.reason, _answer: event.answer },
      };
  }
}

/** The raw log a ChainEvent came from (address, position and hashes from its envelope). */
export function encodeChainEvent(event: ChainEvent): RawLog {
  const { source, name, args } = sourceAndArgs(event);
  const { topics, data } = encodeLog(spec(source, name), args);
  return {
    address: event.address.toLowerCase() as RawLog["address"],
    topics,
    data,
    blockNumber: event.blockNumber,
    blockHash: event.blockHash.toLowerCase() as Hex32,
    transactionHash: event.transactionHash.toLowerCase() as Hex32,
    logIndex: event.logIndex,
  };
}
