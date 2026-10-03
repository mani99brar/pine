// Reality.eth v3 events of tracked questions (MemoryReadModel.applyOne "Reality*"). A question is tracked iff its
// OracleQuestion entity exists; events of any other question only advance the progress marker.

import { indexer } from "envio";
import { encodePacked, keccak256 } from "viem";
import { logId, lower, markProgress } from "../lib/common.js";
import { marketsOf, newQuestion } from "../lib/question.js";

const asHex = (value: string): `0x${string}` => {
  if (!/^0x[0-9a-f]*$/.test(value)) throw new Error("expected lowercase hex");
  return value as `0x${string}`;
};

/** submitAnswerReveal: commitment_id = keccak256(abi.encodePacked(question_id, answer_hash, bond)). */
export function commitmentIdOf(questionId: string, answerHash: string, bond: bigint): string {
  return keccak256(encodePacked(["bytes32", "bytes32", "uint256"], [asHex(lower(questionId)), asHex(lower(answerHash)), bond]));
}

indexer.onEvent({ contract: "RealityETH", event: "LogNewAnswer" }, async ({ event, context }) => {
  const questionId = lower(event.params.question_id);
  const answerValue = lower(event.params.answer);
  const commitmentKey = `${questionId}:${answerValue}`;
  const [question, firstCommitment] = await Promise.all([context.OracleQuestion.get(questionId), context.AnswerCommitment.get(commitmentKey)]);
  markProgress(context, event);
  if (!question) return;
  const { bond, ts, is_commitment: isCommitment } = event.params;
  const id = logId(questionId, event.block.number, event.logIndex);
  context.OracleAnswer.set({
    id,
    questionId,
    answer: answerValue,
    historyHash: lower(event.params.history_hash),
    answerer: lower(event.params.user),
    bond,
    ts,
    isCommitment,
    revealedAnswer: isCommitment ? undefined : answerValue,
    txHash: lower(event.transaction.hash),
    blockNumber: BigInt(event.block.number),
    logIndex: BigInt(event.logIndex),
  });
  // A reveal updates the first commitment of the question with this id (the reference's `find`).
  if (isCommitment && !firstCommitment) context.AnswerCommitment.set({ id: commitmentKey, answerId: id });
  context.OracleQuestion.set({
    ...question,
    answerCount: question.answerCount + 1n,
    // _addAnswerToHistory: the bond level changes only when a bond is posted (arbitrator answers carry none).
    bond: bond > 0n ? bond : question.bond,
    // submitAnswer: finalize_ts = ts + timeout. Arbitrator answer (bond 0, after LogFinalize): finalize_ts = ts.
    ...(isCommitment ? {} : { bestAnswer: answerValue, finalizeTs: bond > 0n ? ts + question.timeout : ts }),
    lastEventBlock: BigInt(event.block.number),
  });
});

indexer.onEvent({ contract: "RealityETH", event: "LogAnswerReveal" }, async ({ event, context }) => {
  const questionId = lower(event.params.question_id);
  const commitmentKey = `${questionId}:${commitmentIdOf(questionId, event.params.answer_hash, event.params.bond)}`;
  const [question, commitment] = await Promise.all([context.OracleQuestion.get(questionId), context.AnswerCommitment.get(commitmentKey)]);
  const committed = commitment ? await context.OracleAnswer.get(commitment.answerId) : undefined;
  markProgress(context, event);
  if (!question) return;
  const answer = lower(event.params.answer);
  if (committed) context.OracleAnswer.set({ ...committed, revealedAnswer: answer });
  // Only the reveal of the current (highest) bond becomes the best answer and restarts the timeout.
  const current = event.params.bond === question.bond;
  context.OracleQuestion.set({
    ...question,
    ...(current ? { bestAnswer: answer, finalizeTs: BigInt(event.block.timestamp) + question.timeout } : {}),
    lastEventBlock: BigInt(event.block.number),
  });
});

indexer.onEvent({ contract: "RealityETH", event: "LogNotifyOfArbitrationRequest" }, async ({ event, context }) => {
  const question = await context.OracleQuestion.get(lower(event.params.question_id));
  markProgress(context, event);
  if (!question) return;
  context.OracleQuestion.set({
    ...question,
    pendingArbitration: true,
    arbitrationRequestedBy: lower(event.params.user),
    lastEventBlock: BigInt(event.block.number),
  });
});

indexer.onEvent({ contract: "RealityETH", event: "LogCancelArbitration" }, async ({ event, context }) => {
  const question = await context.OracleQuestion.get(lower(event.params.question_id));
  markProgress(context, event);
  if (!question) return;
  // cancelArbitration: not pending, finalize_ts = now + timeout.
  context.OracleQuestion.set({
    ...question,
    pendingArbitration: false,
    finalizeTs: BigInt(event.block.timestamp) + question.timeout,
    lastEventBlock: BigInt(event.block.number),
  });
});

indexer.onEvent({ contract: "RealityETH", event: "LogFinalize" }, async ({ event, context }) => {
  const question = await context.OracleQuestion.get(lower(event.params.question_id));
  markProgress(context, event);
  if (!question) return;
  // submitAnswerByArbitrator: best_answer = answer, finalize_ts = now, not pending.
  context.OracleQuestion.set({
    ...question,
    pendingArbitration: false,
    bestAnswer: lower(event.params.answer),
    finalizeTs: BigInt(event.block.timestamp),
    answeredByArbitrator: true,
    lastEventBlock: BigInt(event.block.number),
  });
});

indexer.onEvent({ contract: "RealityETH", event: "LogReopenQuestion" }, async ({ event, context }) => {
  const replacementId = lower(event.params.question_id);
  const [original, replacement] = await Promise.all([
    context.OracleQuestion.get(lower(event.params.reopened_question_id)),
    context.OracleQuestion.get(replacementId),
  ]);
  markProgress(context, event);
  if (!original) return;
  const block = BigInt(event.block.number);
  context.OracleQuestion.set({ ...original, reopenedBy: replacementId, lastEventBlock: block });
  if (!replacement) {
    // reopenQuestion requires identical content, opening time, min bond and timeout.
    context.OracleQuestion.set({ ...newQuestion(replacementId, marketsOf(original), original.openingTs, original.minBond, original.id), lastEventBlock: block });
  }
});

indexer.onEvent({ contract: "RealityETH", event: "LogFundAnswerBounty" }, async ({ event, context }) => {
  const question = await context.OracleQuestion.get(lower(event.params.question_id));
  markProgress(context, event);
  if (!question) return;
  context.OracleQuestion.set({ ...question, bounty: event.params.bounty, lastEventBlock: BigInt(event.block.number) });
});
