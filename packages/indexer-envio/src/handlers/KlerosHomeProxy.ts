// Kleros home-proxy arbitration stages of tracked questions (MemoryReadModel.applyOne "KlerosHome").

import { indexer, type EvmOnEventContext } from "envio";
import { logId, lower, markProgress, type EventPosition } from "../lib/common.js";

type Stage = "RequestNotified" | "RequestRejected" | "RequestAcknowledged" | "RequestCanceled" | "ArbitrationFailed" | "ArbitratorAnswered" | "ArbitrationFinished";

interface StageInput {
  stage: Stage;
  questionId: string;
  requester: string | null;
  reason: string | null;
  answer: string | null;
}

interface StageEvent extends EventPosition {
  logIndex: number;
  transaction: { hash: string };
}

async function applyStage(context: EvmOnEventContext, event: StageEvent, input: StageInput): Promise<void> {
  const questionId = lower(input.questionId);
  const [question, existing] = await Promise.all([context.OracleQuestion.get(questionId), context.Arbitration.get(questionId)]);
  markProgress(context, event);
  if (!question) return;
  const at = BigInt(event.block.timestamp);
  context.Arbitration.set({
    id: questionId,
    stage: input.stage,
    requester: input.requester ? lower(input.requester) : existing?.requester,
    rejectionReason: input.stage === "RequestRejected" ? (input.reason ?? undefined) : existing?.rejectionReason,
    arbitratorAnswer: input.stage === "ArbitratorAnswered" && input.answer ? lower(input.answer) : existing?.arbitratorAnswer,
    updatedAt: at,
  });
  context.ArbitrationStage.set({
    id: logId(questionId, event.block.number, event.logIndex),
    questionId,
    stage: input.stage,
    at,
    txHash: lower(event.transaction.hash),
    blockNumber: BigInt(event.block.number),
    logIndex: BigInt(event.logIndex),
  });
}

indexer.onEvent({ contract: "KlerosHomeProxy", event: "RequestNotified" }, async ({ event, context }) => {
  await applyStage(context, event, { stage: "RequestNotified", questionId: event.params._questionID, requester: event.params._requester, reason: null, answer: null });
});

indexer.onEvent({ contract: "KlerosHomeProxy", event: "RequestRejected" }, async ({ event, context }) => {
  await applyStage(context, event, { stage: "RequestRejected", questionId: event.params._questionID, requester: event.params._requester, reason: event.params._reason, answer: null });
});

indexer.onEvent({ contract: "KlerosHomeProxy", event: "RequestAcknowledged" }, async ({ event, context }) => {
  await applyStage(context, event, { stage: "RequestAcknowledged", questionId: event.params._questionID, requester: event.params._requester, reason: null, answer: null });
});

indexer.onEvent({ contract: "KlerosHomeProxy", event: "RequestCanceled" }, async ({ event, context }) => {
  await applyStage(context, event, { stage: "RequestCanceled", questionId: event.params._questionID, requester: event.params._requester, reason: null, answer: null });
});

indexer.onEvent({ contract: "KlerosHomeProxy", event: "ArbitrationFailed" }, async ({ event, context }) => {
  await applyStage(context, event, { stage: "ArbitrationFailed", questionId: event.params._questionID, requester: event.params._requester, reason: null, answer: null });
});

indexer.onEvent({ contract: "KlerosHomeProxy", event: "ArbitratorAnswered" }, async ({ event, context }) => {
  await applyStage(context, event, { stage: "ArbitratorAnswered", questionId: event.params._questionID, requester: null, reason: null, answer: event.params._answer });
});

indexer.onEvent({ contract: "KlerosHomeProxy", event: "ArbitrationFinished" }, async ({ event, context }) => {
  await applyStage(context, event, { stage: "ArbitrationFinished", questionId: event.params._questionID, requester: null, reason: null, answer: null });
});
