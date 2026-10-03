// ClaimRegistry ClaimCreated (MemoryReadModel.applyOne "ClaimCreated").

import { indexer } from "envio";
import { assertSafeUint, lower, markProgress } from "../lib/common.js";
import { marketsOf, newQuestion, sortedMarkets } from "../lib/question.js";

const COMMIT = /^0x[0-9a-f]{40}$/;

indexer.onEvent({ contract: "ClaimRegistry", event: "ClaimCreated" }, async ({ event, context }) => {
  const { claim } = event.params;
  const market = lower(event.params.market);
  const questionId = lower(claim.questionId);
  const conditionId = lower(claim.conditionId);
  const [existingClaim, existingQuestion] = await Promise.all([context.Claim.get(market), context.OracleQuestion.get(questionId)]);
  markProgress(context, event);

  // Domain of the frozen ClaimCreatedEvent, guaranteed by the ClaimRegistry: a violation halts (handler error).
  assertSafeUint(claim.repositoryId, "repositoryId", 1n);
  assertSafeUint(claim.evidenceDeadline, "evidenceDeadline");
  assertSafeUint(claim.revealDeadline, "revealDeadline");
  const commit = lower(claim.commit);
  if (!COMMIT.test(commit)) throw new Error("commit is not a bytes20 value");

  if (existingClaim) return; // The registry never emits twice for one market; first wins.
  context.Claim.set({
    id: market,
    registry: lower(event.srcAddress),
    creator: lower(event.params.creator),
    claimDocumentSha256: lower(event.params.claimDocumentSha256),
    policyDocumentSha256: lower(claim.policyDocumentSha256),
    repositoryId: claim.repositoryId,
    commit: commit.slice(2),
    questionId,
    conditionId,
    evidenceDeadline: claim.evidenceDeadline,
    revealDeadline: claim.revealDeadline,
    minBond: claim.minBond,
    title: event.params.title,
    marketName: event.params.marketName,
    marketNameHash: lower(claim.marketNameHash),
    yesToken: lower(claim.yesToken),
    noToken: lower(claim.noToken),
    invalidToken: lower(claim.invalidToken),
    createdAt: BigInt(event.block.timestamp),
    createdBlock: BigInt(event.block.number),
    createdTxHash: lower(event.transaction.hash),
    createdLogIndex: BigInt(event.logIndex),
  });
  context.TrackedCondition.set({ id: conditionId });
  if (existingQuestion) {
    // Seer reuses an identical Reality question for identical market parameters.
    context.OracleQuestion.set({ ...existingQuestion, markets: sortedMarkets([...marketsOf(existingQuestion), market]) });
  } else {
    context.OracleQuestion.set(newQuestion(questionId, [market], claim.revealDeadline, claim.minBond, null));
  }
});
