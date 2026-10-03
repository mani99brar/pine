// Oracle helper plans (PRD-04 section 2.3, ADR D7, SEC-TX): every argument is re-derived at request time from the read
// model and eth_call reads, never taken from the client; history arguments are self-checked against Reality's
// getHistoryHash exactly as Reality checks them; reopenQuestion re-creates the original question and is checked by
// recomputing the original question id.

import { encodePacked, keccak256 } from "viem";
import { z } from "zod";
import { deriveOracleStatus, REALITY_INVALID } from "@pine/shared/read-model";
import { buildStep, newPlan, verifyPlan, type TxStep } from "@pine/shared/tx-plan";
import type { Address, Hex32 } from "@pine/shared/types";
import type { AppContext } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { addressParam, chainRead, HOUR, MARKETS_PLAN_LIMITS, nowSeconds, planContextOf, XDAI, type MarketsRouteDeps, type MarketsState } from "./common.js";
import { settledTooSoon } from "./due-actions.js";
import { claimWinningsArgs, HistoryMismatchError, NULL_HASH, reportArgs, verifyClaimArgs, verifyReportArgs } from "./history.js";
import { loadOracle, reality, type OracleSnapshot } from "./oracle.js";
import { createOrReplayPlan, type BuiltPlan, type PlanKind } from "./plans.js";

export const ORACLE_PLAN_TTL_SECONDS = HOUR;
export const REALITY_TEMPLATE_CATEGORICAL = 2n;
export const MAX_REOPEN_NONCE = 15;
/** Reality's question field separator (U+241F). */
export const REALITY_SEPARATOR = "\u241f";

const ANSWERS: Record<"yes" | "no" | "invalid", Hex32> = {
  yes: `0x${"0".repeat(64)}`,
  no: `0x${"0".repeat(63)}1`,
  invalid: REALITY_INVALID,
};

const MAX_VALUE = MARKETS_PLAN_LIMITS.maxTotalValueWei;
const WEI_PATTERN = /^[1-9][0-9]{0,77}$/;
// zod 4 runs a refine even after a failed regex: the refine re-checks the pattern so BigInt never throws (400, not 500).
const weiSchema = z
  .string()
  .regex(WEI_PATTERN, "must be a positive base-10 integer in wei")
  .refine((value) => WEI_PATTERN.test(value) && BigInt(value) <= MAX_VALUE, `must be at most ${MAX_VALUE / XDAI} xDAI`);

const marketBody = z.object({ market: addressParam }).strict();

/** The question text Seer asked: marketName, outcomes, category and language joined by U+241F. */
export function seerQuestionText(marketName: string, category: string, language: string): string {
  return [marketName, '"Yes","No"', category, language].join(REALITY_SEPARATOR);
}

/** content_hash = keccak256(abi.encodePacked(uint256 template_id, uint32 opening_ts, string question)). */
export function realityContentHash(templateId: bigint, openingTs: number, question: string): Hex32 {
  return keccak256(encodePacked(["uint256", "uint32", "string"], [templateId, openingTs, question]));
}

/** question_id = keccak256(abi.encodePacked(content_hash, arbitrator, uint32 timeout, uint256 min_bond, realitio, asker, uint256 nonce)). */
export function realityQuestionId(input: { contentHash: Hex32; arbitrator: Address; timeout: number; minBond: bigint; realitio: Address; asker: Address; nonce: bigint }): Hex32 {
  return keccak256(
    encodePacked(
      ["bytes32", "address", "uint32", "uint256", "address", "address", "uint256"],
      [input.contentHash, input.arbitrator, input.timeout, input.minBond, input.realitio, input.asker, input.nonce],
    ),
  );
}

function refuse(message: string): never {
  throw new ApiError("UNPROCESSABLE", message);
}

function requireCurrent(snapshot: OracleSnapshot) {
  if (!snapshot.current) throw new ApiError("NOT_READY", "The current oracle question is not indexed yet; try again shortly", { retryAfterSeconds: 30 });
  return snapshot.current;
}

export function registerOraclePlanRoutes({ app, ctx, state }: MarketsRouteDeps): void {
  const manifest = state.manifest;
  const guard = { preHandler: app.requireSession };

  /** Builds a plan from steps, verifies it against the claim's markets and questions, and returns the store input. */
  const finish = (planId: string, account: Address, snapshot: OracleSnapshot, kind: PlanKind, steps: TxStep[], details: Record<string, unknown>, facts: Record<string, unknown> = {}): BuiltPlan => {
    const plan = newPlan(manifest, planId, account, steps);
    verifyPlan(plan, manifest, planContextOf(snapshot.claim, snapshot.questionIds), MARKETS_PLAN_LIMITS);
    return { kind, market: snapshot.claim.market, plan, expiresAt: nowSeconds(ctx) + ORACLE_PLAN_TTL_SECONDS, details, facts };
  };

  const route = <B extends { market: Address }>(
    path: string,
    name: string,
    body: z.ZodType<B>,
    build: (input: { planId: string; account: Address; snapshot: OracleSnapshot; body: B; now: number }) => Promise<BuiltPlan>,
  ) => {
    app.post(path, { ...guard, schema: { body } }, async (request, reply) => {
      const parsed = request.body as B;
      const result = await createOrReplayPlan(ctx, request, {
        route: name,
        action: "answer_oracle",
        body: parsed,
        async build(planId, session) {
          const snapshot = await loadOracle(ctx, state, parsed.market);
          return build({ planId, account: session.wallet.toLowerCase() as Address, snapshot, body: parsed, now: nowSeconds(ctx) });
        },
      });
      return reply.status(result.statusCode).send(result.body);
    });
  };

  route(
    "/api/v1/oracle/plans/submit-answer",
    "oracle.submit_answer",
    z.object({ market: addressParam, outcome: z.enum(["yes", "no", "invalid"]), bond: weiSchema }).strict(),
    async ({ planId, account, snapshot, body, now }) => {
      const question = requireCurrent(snapshot);
      const status = deriveOracleStatus(question, now);
      if (status.state !== "open_unanswered" && status.state !== "answered") refuse(`The question is not open for answers (state ${status.state})`);
      const bond = BigInt(body.bond);
      const doubled = 2n * question.bond;
      const minimum = doubled > question.minBond ? doubled : question.minBond;
      if (bond < minimum) refuse(`The bond must be at least ${minimum.toString()} wei (max(minBond, 2 x current bond))`);
      const answer = ANSWERS[body.outcome];
      const step = buildStep(manifest, { id: "answer", allowlistId: "realitio.submitAnswer", args: [question.questionId, answer, question.bond], value: bond });
      return finish(planId, account, snapshot, "oracle_submit_answer", [step], { questionId: question.questionId, outcome: body.outcome, bond, maxPrevious: question.bond, minimumBond: minimum }, { questionId: question.questionId, answer, bond: bond.toString() });
    },
  );

  route("/api/v1/oracle/plans/fund-bounty", "oracle.fund_bounty", z.object({ market: addressParam, amount: weiSchema }).strict(), async ({ planId, account, snapshot, body, now }) => {
    const question = requireCurrent(snapshot);
    const status = deriveOracleStatus(question, now);
    if (status.state !== "open_unanswered" && status.state !== "answered") refuse(`Bounties can only be added while the question is open (state ${status.state})`);
    const amount = BigInt(body.amount);
    const step = buildStep(manifest, { id: "fund-bounty", allowlistId: "realitio.fundAnswerBounty", args: [question.questionId], value: amount });
    return finish(planId, account, snapshot, "oracle_fund_bounty", [step], { questionId: question.questionId, amount });
  });

  route("/api/v1/oracle/plans/resolve", "oracle.resolve", marketBody, async ({ planId, account, snapshot, now }) => {
    const question = requireCurrent(snapshot);
    const status = deriveOracleStatus(question, now);
    if (status.state !== "finalized") refuse("The question is not finalized yet");
    if (status.outcome === "answered_too_soon") refuse("The question settled as answered too soon; reopen it first");
    if (snapshot.resolution) refuse("The market is already resolved");
    const step = buildStep(manifest, { id: "resolve", allowlistId: "realityProxy.resolve", args: [snapshot.claim.market] });
    return finish(planId, account, snapshot, "oracle_resolve", [step], { questionId: question.questionId, outcome: status.outcome });
  });

  route("/api/v1/oracle/plans/reopen", "oracle.reopen", marketBody, async ({ planId, account, snapshot, now }) => {
    const question = requireCurrent(snapshot);
    if (!settledTooSoon(question, now)) refuse("Only a question that settled as answered too soon can be reopened");
    const plan = await reopenArgs(ctx, state, snapshot, account);
    const step = buildStep(manifest, {
      id: "reopen",
      allowlistId: "realitio.reopenQuestion",
      args: [REALITY_TEMPLATE_CATEGORICAL, plan.question, plan.arbitrator, plan.timeout, plan.openingTs, plan.nonce, plan.minBond, snapshot.claim.questionId],
    });
    return finish(planId, account, snapshot, "oracle_reopen", [step], { reopens: snapshot.claim.questionId, nonce: plan.nonce, expectedQuestionId: plan.newQuestionId });
  });

  const arbitrationRoute = (path: string, name: string, kind: PlanKind, stage: "RequestNotified" | "RequestRejected", allowlistId: string) =>
    route(path, name, marketBody, async ({ planId, account, snapshot }) => {
      requireCurrent(snapshot);
      const arbitration = snapshot.arbitration;
      if (!arbitration || arbitration.stage !== stage || !arbitration.requester) refuse(`No arbitration request is waiting in stage ${stage}`);
      const step = buildStep(manifest, { id: "relay", allowlistId, args: [snapshot.currentId, arbitration.requester] });
      return finish(planId, account, snapshot, kind, [step], { questionId: snapshot.currentId, requester: arbitration.requester, stage });
    });
  arbitrationRoute("/api/v1/oracle/plans/handle-notified-request", "oracle.handle_notified", "oracle_handle_notified", "RequestNotified", "klerosHomeProxy.handleNotifiedRequest");
  arbitrationRoute("/api/v1/oracle/plans/handle-rejected-request", "oracle.handle_rejected", "oracle_handle_rejected", "RequestRejected", "klerosHomeProxy.handleRejectedRequest");

  route("/api/v1/oracle/plans/report-arbitration-answer", "oracle.report_answer", marketBody, async ({ planId, account, snapshot }) => {
    requireCurrent(snapshot);
    if (snapshot.arbitration?.stage !== "ArbitratorAnswered") refuse("The arbitrator has not answered (or the answer was already reported)");
    const args = reportArgs(snapshot.answers);
    if (!args) refuse("The question has no answers to report against");
    const onChain = await chainRead(() => reality(ctx, state).historyHash(snapshot.currentId));
    if (!verifyReportArgs(onChain, args)) refuse("The indexed answer history does not match Reality's history hash; try again later");
    const step = buildStep(manifest, {
      id: "report",
      allowlistId: "klerosHomeProxy.reportArbitrationAnswer",
      args: [snapshot.currentId, args.lastHistoryHash, args.lastAnswerOrCommitmentId, args.lastAnswerer],
    });
    return finish(planId, account, snapshot, "oracle_report_answer", [step], { questionId: snapshot.currentId, lastHistoryHash: args.lastHistoryHash, lastAnswerOrCommitmentId: args.lastAnswerOrCommitmentId, lastAnswerer: args.lastAnswerer });
  });

  route("/api/v1/oracle/plans/claim-winnings", "oracle.claim_winnings", marketBody, async ({ planId, account, snapshot, now }) => {
    const r = reality(ctx, state);
    const targets: { id: Hex32; stepId: string }[] = [];
    if (snapshot.current && deriveOracleStatus(snapshot.current, now).state === "finalized") targets.push({ id: snapshot.currentId, stepId: "claim" });
    if (snapshot.currentId !== snapshot.claim.questionId && settledTooSoon(snapshot.original, now)) targets.push({ id: snapshot.claim.questionId, stepId: "claim-original" });
    const steps: TxStep[] = [];
    const claimed: Record<string, unknown>[] = [];
    for (const target of targets) {
      const onChain = await chainRead(() => r.historyHash(target.id));
      if (onChain === NULL_HASH) continue;
      const records = target.id === snapshot.currentId ? snapshot.answers : await ctx.readModel.listOracleAnswers(target.id);
      let args;
      try {
        args = claimWinningsArgs(records, onChain);
      } catch (error) {
        if (error instanceof HistoryMismatchError) refuse("The indexed answer history does not match Reality's history hash; try again later");
        throw error;
      }
      if (!args) continue;
      if (!verifyClaimArgs(onChain, args)) refuse("The indexed answer history does not match Reality's history hash; try again later");
      steps.push(buildStep(manifest, { id: target.stepId, allowlistId: "realitio.claimWinnings", args: [target.id, args.historyHashes, args.addrs, args.bonds, args.answers] }));
      claimed.push({ questionId: target.id, entries: args.answers.length, complete: args.historyHashes[args.historyHashes.length - 1] === NULL_HASH });
    }
    if (steps.length === 0) refuse("There are no unclaimed winnings for this market's questions");
    return finish(planId, account, snapshot, "oracle_claim_winnings", steps, { claims: claimed, note: "Winnings are credited to the answerers' Reality balances; each answerer withdraws with the withdraw plan." });
  });

  app.post("/api/v1/oracle/plans/withdraw", { ...guard, schema: { body: z.object({}).strict() } }, async (request, reply) => {
    const result = await createOrReplayPlan(ctx, request, {
      route: "oracle.withdraw",
      action: "answer_oracle",
      body: {},
      async build(planId, session) {
        const account = session.wallet.toLowerCase() as Address;
        const balance = await chainRead(() => reality(ctx, state).balanceOf(account));
        if (balance <= 0n) refuse("There is no Reality balance to withdraw");
        const step = buildStep(manifest, { id: "withdraw", allowlistId: "realitio.withdraw", args: [] });
        const plan = newPlan(manifest, planId, account, [step]);
        verifyPlan(plan, manifest, { markets: new Map(), questionIds: new Set() }, MARKETS_PLAN_LIMITS);
        return { kind: "oracle_withdraw", market: null, plan, expiresAt: nowSeconds(ctx) + ORACLE_PLAN_TTL_SECONDS, details: { balance }, facts: {} };
      },
    });
    return reply.status(result.statusCode).send(result.body);
  });
}

/**
 * reopenQuestion arguments: the ORIGINAL claim question re-created exactly (template 2, Seer's question text, and the
 * arbitrator, timeout, opening time and min bond read from Reality), checked by recomputing the original question id
 * (asked by the Seer MarketFactory with nonce 0). The nonce is the smallest n in 0..15 whose question id for this
 * account does not exist yet (getTimeout == 0).
 */
export async function reopenArgs(ctx: AppContext, state: MarketsState, snapshot: OracleSnapshot, account: Address) {
  const r = reality(ctx, state);
  const original = snapshot.claim.questionId;
  if (snapshot.original && snapshot.original.reopens !== null) refuse("Reality refuses to reopen a question that reopens another");
  const [arbitrator, timeout, openingTs, minBond] = await chainRead(() => Promise.all([r.arbitrator(original), r.timeout(original), r.openingTs(original), r.minBond(original)]));
  if (timeout === 0) refuse("The original question does not exist on Reality");
  const question = seerQuestionText(snapshot.claim.marketName, ctx.config.claims.questionCategory, ctx.config.claims.questionLanguage);
  const contentHash = realityContentHash(REALITY_TEMPLATE_CATEGORICAL, openingTs, question);
  const realitio = state.manifest.seer.realitio;
  const askedId = realityQuestionId({ contentHash, arbitrator, timeout, minBond, realitio, asker: state.manifest.seer.marketFactory, nonce: 0n });
  if (askedId !== original) refuse("The original question cannot be re-created exactly from the indexed claim; refusing to reopen");
  for (let n = 0; n <= MAX_REOPEN_NONCE; n += 1) {
    const nonce = BigInt(n);
    const newQuestionId = realityQuestionId({ contentHash, arbitrator, timeout, minBond, realitio, asker: account, nonce });
    const exists = (await chainRead(() => r.timeout(newQuestionId))) !== 0;
    if (!exists) return { question, arbitrator, timeout, openingTs, minBond, nonce, newQuestionId };
  }
  throw new ApiError("CONFLICT", "No free reopen nonce (0..15) for this account; reopen from another account");
}

