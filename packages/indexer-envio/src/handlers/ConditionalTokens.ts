// Conditional Tokens ConditionResolution of tracked conditions (MemoryReadModel.applyOne "ConditionResolution").

import { indexer } from "envio";
import { lower, markProgress } from "../lib/common.js";

indexer.onEvent({ contract: "ConditionalTokens", event: "ConditionResolution" }, async ({ event, context }) => {
  const conditionId = lower(event.params.conditionId);
  const [tracked, resolved] = await Promise.all([context.TrackedCondition.get(conditionId), context.ConditionResolution.get(conditionId)]);
  markProgress(context, event);
  if (!tracked || resolved) return; // Untracked, or already resolved (first wins).
  context.ConditionResolution.set({
    id: conditionId,
    ctfQuestionId: lower(event.params.questionId),
    payoutNumerators: event.params.payoutNumerators.map((value) => value.toString()),
    resolvedAt: BigInt(event.block.timestamp),
    txHash: lower(event.transaction.hash),
    blockNumber: BigInt(event.block.number),
  });
});
