// FROZEN. Conformance suite for ReadModel implementations: differential testing against the in-memory reference
// (MemoryReadModel) over the frozen scenarios, plus absolute expectations that pin the reference itself.
//
// Usage in an implementation's test file:
//   describeReadModelConformance("native", async (events, setup) => ({ readModel, close }))
// The factory must ingest `events` through the implementation's real processing path (decoding excluded) and return
// a ReadModel reading the resulting state. Addresses in `setup.addresses` are the emitters used by the scenarios.

import { describe, expect, it } from "vitest";
import type { ChainEvent } from "../chain-events.js";
import {
  InvalidCursorError,
  REALITY_ANSWERED_TOO_SOON,
  deriveOracleStatus,
  type ListClaimsQuery,
  type ListEvidenceQuery,
  type ReadModel,
} from "../read-model.js";
import type { Address, Hex32 } from "../types.js";
import { MemoryReadModel } from "./memory-read-model.js";
import {
  SCENARIO_ADDRESSES,
  SCENARIO_CHAIN_ID,
  SCENARIO_QUESTION_TIMEOUT,
  scenarioClaimsAndEvidence,
  scenarioManyClaims,
  scenarioOracle,
} from "./read-model-scenarios.js";

export interface ConformanceSetup {
  chainId: number;
  questionTimeout: number;
  addresses: typeof SCENARIO_ADDRESSES;
}

export type ReadModelFactory = (events: ChainEvent[], setup: ConformanceSetup) => Promise<{ readModel: ReadModel; close?: () => Promise<void> }>;

const SETUP: ConformanceSetup = { chainId: SCENARIO_CHAIN_ID, questionTimeout: SCENARIO_QUESTION_TIMEOUT, addresses: SCENARIO_ADDRESSES };

async function build(events: ChainEvent[], factory: ReadModelFactory) {
  const reference = new MemoryReadModel({ chainId: SETUP.chainId, questionTimeout: SETUP.questionTimeout });
  reference.apply(events);
  const implementation = await factory(events, SETUP);
  return { reference, implementation: implementation.readModel, close: implementation.close ?? (async () => {}) };
}

async function walkClaims(model: ReadModel, query: Omit<ListClaimsQuery, "cursor">) {
  const items = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 1_000; guard += 1) {
    const page = await model.listClaims(cursor === undefined ? query : { ...query, cursor });
    expect(page.items.length).toBeLessThanOrEqual(query.limit);
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

async function walkEvidence(model: ReadModel, query: Omit<ListEvidenceQuery, "cursor">) {
  const items = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 1_000; guard += 1) {
    const page = await model.listEvidence(cursor === undefined ? query : { ...query, cursor });
    expect(page.items.length).toBeLessThanOrEqual(query.limit);
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

const UNKNOWN_ADDRESS: Address = "0x000000000000000000000000000000000000dead";
const UNKNOWN_HASH: Hex32 = `0x${"00".repeat(31)}01`;

export function describeReadModelConformance(label: string, factory: ReadModelFactory): void {
  describe(`read model conformance: ${label}`, () => {
    it("claims and evidence match the reference", async () => {
      const { events, claims } = scenarioClaimsAndEvidence();
      const { reference, implementation, close } = await build(events, factory);
      try {
        for (const claim of claims) {
          expect(await implementation.getClaim(claim.market)).toEqual(await reference.getClaim(claim.market));
          expect(await implementation.getClaim(claim.market.toUpperCase().replace("0X", "0x") as Address)).toEqual(await reference.getClaim(claim.market));
        }
        expect(await implementation.getClaim(UNKNOWN_ADDRESS)).toBeNull();
        expect(await implementation.listClaimsByQuestion(claims[0]!.questionId)).toEqual(await reference.listClaimsByQuestion(claims[0]!.questionId));
        expect((await reference.listClaimsByQuestion(claims[0]!.questionId)).length).toBe(2);
        const question = await implementation.getOracleQuestion(claims[0]!.questionId);
        expect(question).toEqual(await reference.getOracleQuestion(claims[0]!.questionId));
        expect(question?.markets).toEqual([claims[0]!.market, claims[1]!.market].map((m) => m.toLowerCase()).sort());

        for (const id of [1n, 2n, 3n, 99n]) {
          expect(await implementation.getEvidence(SCENARIO_ADDRESSES.evidenceRegistry, id)).toEqual(await reference.getEvidence(SCENARIO_ADDRESSES.evidenceRegistry, id));
        }
        const revealed = await reference.getEvidence(SCENARIO_ADDRESSES.evidenceRegistry, 1n);
        expect(revealed?.status).toBe("revealed");
        expect(revealed?.contentSha256).not.toBeNull();
        expect((await reference.getEvidence(SCENARIO_ADDRESSES.evidenceRegistry, 3n))?.status).toBe("committed");
        expect(await reference.getEvidence(SCENARIO_ADDRESSES.evidenceRegistry, 99n)).toBeNull();
        for (const limit of [1, 2, 100]) {
          for (const query of [
            { limit },
            { limit, market: claims[0]!.market },
            { limit, submitter: revealed!.submitter },
            { limit, status: "published" as const },
            { limit, status: "committed" as const },
          ]) {
            expect(await walkEvidence(implementation, query)).toEqual(await walkEvidence(reference, query));
          }
        }
      } finally {
        await close();
      }
    });

    it("pagination and filters over many claims match the reference", async () => {
      const { events, creators } = scenarioManyClaims();
      const { reference, implementation, close } = await build(events, factory);
      try {
        for (const order of ["created_desc", "evidence_deadline_asc"] as const) {
          for (const limit of [1, 3, 7, 100]) {
            for (const filter of [
              {},
              { creator: creators[1]! },
              { evidenceDeadlineAfter: 1_900_018_000 },
              { evidenceDeadlineAtOrBefore: 1_900_018_000 },
              { evidenceDeadlineAfter: 1_900_007_200, evidenceDeadlineAtOrBefore: 1_900_032_400, creator: creators[0]! },
            ]) {
              const query = { order, limit, ...filter };
              const expected = await walkClaims(reference, query);
              expect(await walkClaims(implementation, query)).toEqual(expected);
            }
          }
        }
        const all = await walkClaims(reference, { order: "created_desc", limit: 100 });
        expect(all.length).toBe(23);
        const bySha = { order: "created_desc" as const, limit: 10, claimDocumentSha256: all[5]!.claimDocumentSha256 };
        expect(await walkClaims(implementation, bySha)).toEqual(await walkClaims(reference, bySha));
        await expect(implementation.listClaims({ order: "created_desc", limit: 5, cursor: "not-a-cursor" })).rejects.toSatisfy(
          (error: unknown) => error instanceof InvalidCursorError || (error instanceof Error && error.name === "InvalidCursorError"),
        );
        await expect(implementation.listClaims({ order: "created_desc", limit: 0 })).rejects.toThrow();
        await expect(implementation.listClaims({ order: "created_desc", limit: 101 })).rejects.toThrow();
      } finally {
        await close();
      }
    });

    it("oracle, arbitration and resolution match the reference", async () => {
      const { events, claim, builder, reopenedQuestionId } = scenarioOracle();
      const { reference, implementation, close } = await build(events, factory);
      try {
        const deltaClaims = (await reference.listClaims({ order: "created_desc", limit: 100 })).items.filter((c) => c.market !== claim.market.toLowerCase());
        const delta = deltaClaims[0]!;
        for (const questionId of [claim.questionId, delta.questionId, reopenedQuestionId, UNKNOWN_HASH]) {
          expect(await implementation.getOracleQuestion(questionId)).toEqual(await reference.getOracleQuestion(questionId));
          expect(await implementation.listOracleAnswers(questionId)).toEqual(await reference.listOracleAnswers(questionId));
          expect(await implementation.getArbitration(questionId)).toEqual(await reference.getArbitration(questionId));
        }
        expect(await implementation.getConditionResolution(claim.conditionId)).toEqual(await reference.getConditionResolution(claim.conditionId));
        expect(await implementation.getConditionResolution(UNKNOWN_HASH)).toBeNull();

        // Absolute expectations pinning Reality.eth v3 semantics in the reference itself.
        const q = (await reference.getOracleQuestion(claim.questionId))!;
        expect(q.bestAnswer).toBe(`0x${"0".repeat(64)}`);
        expect(q.answeredByArbitrator).toBe(true);
        expect(q.pendingArbitration).toBe(false);
        expect(q.bond).toBe(4n * 10n ** 18n);
        expect(q.bounty).toBe(5n * 10n ** 17n);
        expect(q.answerCount).toBe(4);
        const answers = await reference.listOracleAnswers(claim.questionId);
        expect(answers.map((a) => a.isCommitment)).toEqual([false, true, false, false]);
        expect(answers[1]!.revealedAnswer).toBe(`0x${"0".repeat(64)}`);
        expect(answers[3]!.bond).toBe(0n);
        expect(q.finalizeTs).toBe(answers[3]!.ts);
        expect(deriveOracleStatus(q, q.finalizeTs)).toEqual({ state: "finalized", outcome: "yes", byArbitrator: true });
        expect(deriveOracleStatus(q, q.finalizeTs - 1)).toEqual({ state: "answered", outcome: "yes", bond: q.bond, finalizesAt: q.finalizeTs });
        const arbitration = (await reference.getArbitration(claim.questionId))!;
        expect(arbitration.stage).toBe("ArbitrationFinished");
        expect(arbitration.arbitratorAnswer).toBe(`0x${"0".repeat(64)}`);
        expect(arbitration.history.map((h) => h.stage)).toEqual(["RequestNotified", "RequestCanceled", "RequestNotified", "RequestAcknowledged", "ArbitratorAnswered", "ArbitrationFinished"]);
        expect((await reference.getConditionResolution(claim.conditionId))!.payoutNumerators).toEqual([1n, 0n, 0n]);

        const tooSoon = (await reference.getOracleQuestion(delta.questionId))!;
        expect(tooSoon.bestAnswer).toBe(REALITY_ANSWERED_TOO_SOON);
        expect(tooSoon.reopenedBy).toBe(reopenedQuestionId);
        const reopened = (await reference.getOracleQuestion(reopenedQuestionId))!;
        expect(reopened.reopens).toBe(delta.questionId);
        expect(reopened.markets).toEqual([delta.market]);
        expect(reopened.openingTs).toBe(delta.revealDeadline);
        expect((await reference.getArbitration(reopenedQuestionId))!.rejectionReason).toBe("Bond has changed");
        expect(deriveOracleStatus(reopened, builder.now())).toMatchObject({ state: "answered", outcome: "no" });

        const status = await implementation.status();
        expect(status.chainId).toBe(SETUP.chainId);
        expect(status.halted).toBe(false);
        expect(status.indexedBlock >= events.at(-1)!.blockNumber).toBe(true);
      } finally {
        await close();
      }
    });
  });
}
