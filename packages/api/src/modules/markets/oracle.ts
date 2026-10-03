// Oracle and arbitration status (PRD-04 section 2.3, ADR D7, SEC-IDX-07): read-model facts, derived status, phase,
// staleness and dueActions; eth_call reads at request time for what the read model cannot know (the current reopened
// replacement, history hashes, withdrawable balances).

import { z } from "zod";
import { realityV3Abi } from "@pine/shared/abi/external";
import {
  deriveOracleStatus,
  type ArbitrationRecord,
  type ClaimRecord,
  type ConditionResolutionRecord,
  type OracleAnswerRecord,
  type OracleQuestionRecord,
} from "@pine/shared/read-model";
import type { Address, Hex32 } from "@pine/shared/types";
import type { AppContext } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { addressParam, chainRead, CONTENT_TRUST, freshness, nowSeconds, PUBLIC_ROUTE, requireClaim, sendPublic, ZERO_HASH, type MarketsRouteDeps, type MarketsState } from "./common.js";
import { dueActions, phaseOf, settledTooSoon, type ChainFacts } from "./due-actions.js";

/** The public status route fans out to eth_call: responses are cached per (market, account) for 10 s (PRD-04 4a). */
export const ORACLE_CACHE_SECONDS = 10;
export const ORACLE_CACHE_ENTRIES = 2_048;
/** Concurrent cache misses that may fan out to RPC (per process); the next one is refused with 429 (PRD-04 4b). */
export const ORACLE_MAX_IN_FLIGHT = 4;
export const ORACLE_RETRY_AFTER_SECONDS = 2;

export interface OracleSnapshot {
  claim: ClaimRecord;
  /** The claim's question record. */
  original: OracleQuestionRecord | null;
  /** Current question id: Reality reopened_questions(original) when set (the latest replacement), else the original. */
  currentId: Hex32;
  current: OracleQuestionRecord | null;
  answers: OracleAnswerRecord[];
  arbitration: ArbitrationRecord | null;
  resolution: ConditionResolutionRecord | null;
  /** Every question id that belongs to the claim (PlanContext). */
  questionIds: Hex32[];
}

const lowerHash = (value: unknown): Hex32 => String(value).toLowerCase() as Hex32;

export const reality = (ctx: AppContext, state: MarketsState) => {
  const address = state.manifest.seer.realitio;
  const read = <T>(functionName: string, args: readonly unknown[]): Promise<T> =>
    ctx.chain.publicClient.readContract({ address, abi: realityV3Abi, functionName: functionName as never, args: args as never, blockTag: "latest" }) as Promise<T>;
  return {
    reopenedQuestion: async (questionId: Hex32) => lowerHash(await read<string>("reopened_questions", [questionId])),
    historyHash: async (questionId: Hex32) => lowerHash(await read<string>("getHistoryHash", [questionId])),
    balanceOf: (account: Address) => read<bigint>("balanceOf", [account]),
    timeout: async (questionId: Hex32) => Number(await read<number | bigint>("getTimeout", [questionId])),
    openingTs: async (questionId: Hex32) => Number(await read<number | bigint>("getOpeningTS", [questionId])),
    minBond: (questionId: Hex32) => read<bigint>("getMinBond", [questionId]),
    arbitrator: async (questionId: Hex32) => String(await read<string>("getArbitrator", [questionId])).toLowerCase() as Address,
  };
};

/**
 * Loads the claim's oracle facts. The current question comes from Reality's reopened_questions(original) (eth_call):
 * after a second reopen the read model no longer links the first replacement, so the chain is asked which one is
 * current. That id is accepted only when the read model links it to the claim's question (its record reopens the
 * original, or the original's reopenedBy names it); otherwise NOT_READY. Known limitation: an intermediate replacement
 * (neither original nor current) is not covered.
 */
export async function loadOracle(ctx: AppContext, state: MarketsState, market: Address): Promise<OracleSnapshot> {
  const claim = await requireClaim(ctx, state, market);
  const original = await ctx.readModel.getOracleQuestion(claim.questionId);
  const replacement = await chainRead(() => reality(ctx, state).reopenedQuestion(claim.questionId));
  const currentId = replacement !== ZERO_HASH ? replacement : claim.questionId;
  const current = currentId === claim.questionId ? original : await ctx.readModel.getOracleQuestion(currentId);
  // The RPC answer is used only when the read model links it to this claim's question (PRD-04 4b): an id that reopens
  // another question (or is not indexed and not linked) is never offered as this claim's current question.
  if (currentId !== claim.questionId && current?.reopens !== claim.questionId && original?.reopenedBy !== currentId) {
    throw new ApiError("NOT_READY", "The current oracle question is not linked to this claim in the indexed data yet; try again shortly", { retryAfterSeconds: 30 });
  }
  const [answers, arbitration, resolution] = await Promise.all([
    ctx.readModel.listOracleAnswers(currentId),
    ctx.readModel.getArbitration(currentId),
    ctx.readModel.getConditionResolution(claim.conditionId),
  ]);
  const questionIds = [...new Set([claim.questionId, currentId, ...(original?.reopenedBy ? [original.reopenedBy] : [])])];
  return { claim, original, currentId, current, answers, arbitration, resolution, questionIds };
}

export async function chainFactsOf(ctx: AppContext, state: MarketsState, snapshot: OracleSnapshot, account: Address | null, now: number): Promise<ChainFacts> {
  const r = reality(ctx, state);
  const finalized = snapshot.current !== null && deriveOracleStatus(snapshot.current, now).state === "finalized";
  const reopened = snapshot.currentId !== snapshot.claim.questionId && settledTooSoon(snapshot.original, now);
  return chainRead(async () => ({
    historyHash: finalized ? await r.historyHash(snapshot.currentId) : null,
    originalHistoryHash: reopened ? await r.historyHash(snapshot.claim.questionId) : null,
    balance: account ? await r.balanceOf(account) : null,
  }));
}

const answerView = (answer: OracleAnswerRecord) => ({
  answer: answer.answer,
  revealedAnswer: answer.revealedAnswer,
  historyHash: answer.historyHash,
  answerer: answer.answerer,
  bond: answer.bond,
  ts: answer.ts,
  isCommitment: answer.isCommitment,
  txHash: answer.txHash,
  blockNumber: answer.blockNumber,
});

export function registerOracleStatusRoute({ app, ctx, state }: MarketsRouteDeps): void {
  app.get(
    "/api/v1/markets/:market/oracle",
    { config: PUBLIC_ROUTE, schema: { params: z.object({ market: addressParam }).strict(), querystring: z.object({ account: addressParam.optional() }).strict() } },
    async (request, reply) => {
      const now = nowSeconds(ctx);
      const account = request.query.account ?? null;
      const cacheKey = `${request.params.market}:${account ?? ""}`;
      const cached = state.oracleCache.get(cacheKey, now);
      if (cached !== undefined) return sendPublic(request, reply, cached, 5);
      const body = await state.oracleFanOut.run(() => oracleStatus(ctx, state, request.params.market, account, now));
      state.oracleCache.set(cacheKey, body, now);
      return sendPublic(request, reply, body, 5);
    },
  );
}

/** The oracle-status response: read-model facts plus eth_call reads (the RPC fan-out the limiter bounds). */
async function oracleStatus(ctx: AppContext, state: MarketsState, market: Address, account: Address | null, now: number) {
  const snapshot = await loadOracle(ctx, state, market);
  const chain = await chainFactsOf(ctx, state, snapshot, account, now);
  const status = snapshot.current ? deriveOracleStatus(snapshot.current, now) : null;
  return {
    market: snapshot.claim.market,
    questionId: snapshot.claim.questionId,
    currentQuestionId: snapshot.currentId,
    reopened: snapshot.currentId !== snapshot.claim.questionId,
    question: snapshot.current,
    originalQuestion: snapshot.currentId !== snapshot.claim.questionId ? snapshot.original : null,
    answers: snapshot.answers.map(answerView),
    status,
    arbitration: snapshot.arbitration
      ? { ...snapshot.arbitration, rejectionReason: snapshot.arbitration.rejectionReason, rejectionReasonTrust: CONTENT_TRUST }
      : null,
    resolution: snapshot.resolution,
    phase: phaseOf(snapshot.claim, status, snapshot.resolution, now),
    dueActions: dueActions({
      now,
      claim: snapshot.claim,
      question: snapshot.current,
      original: snapshot.original,
      answerCount: snapshot.answers.length,
      arbitration: snapshot.arbitration,
      resolution: snapshot.resolution,
      chain,
      account,
      klerosForeignProxy: state.manifest.kleros.foreignProxy,
      klerosForeignChainId: state.manifest.kleros.foreignChainId,
    }),
    chainReads: { historyHash: chain.historyHash, originalHistoryHash: chain.originalHistoryHash, balance: chain.balance },
    freshness: await freshness(ctx),
    note: "Pine runs no keeper and never answers or bonds; every action above is permissionless and must be sent by an interested party.",
    computedAt: now,
  };
}
