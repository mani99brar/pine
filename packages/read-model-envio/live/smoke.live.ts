// Live smoke checks against a real Envio deployment (`pnpm --filter @pine/read-model-envio test:live`, excluded from
// `test`). Operator-settled scope: a real deployment never indexed the frozen scenarios, so the differential
// conformance suite cannot run here. Instead this proves, against ENVIO_GRAPHQL_URL, that every query the read model
// issues succeeds, every response validates against the zod schemas, status() parses (the unverified _meta /
// IndexerProgress names in src/envio-meta.ts), and pagination returns ordered, non-overlapping pages.
// Env: ENVIO_GRAPHQL_URL (required), ENVIO_GRAPHQL_ADMIN_SECRET (optional), ENVIO_CHAIN_ID (default 100).

import { describe, expect, it } from "vitest";
import { InvalidCursorError, type ClaimRecord, type EvidenceRecord, type ListClaimsQuery, type ReadModel } from "@pine/shared/read-model";
import type { Hex32 } from "@pine/shared/types";
import { createEnvioReadModel } from "../src/index.js";

const url = process.env.ENVIO_GRAPHQL_URL;
if (url === undefined || url === "") throw new Error("test:live needs ENVIO_GRAPHQL_URL (the Envio Hasura GraphQL endpoint)");
const chainId = process.env.ENVIO_CHAIN_ID === undefined ? 100 : Number(process.env.ENVIO_CHAIN_ID);
const adminSecret = process.env.ENVIO_GRAPHQL_ADMIN_SECRET;

const model: ReadModel = createEnvioReadModel({ graphqlUrl: url, chainId, ...(adminSecret ? { adminSecret } : {}) });
const UNKNOWN_ADDRESS = "0x000000000000000000000000000000000000dead";
const UNKNOWN_HASH: Hex32 = `0x${"00".repeat(31)}01`;

async function walkClaims(query: Omit<ListClaimsQuery, "cursor">): Promise<ClaimRecord[]> {
  const items: ClaimRecord[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const page = await model.listClaims(cursor === undefined ? query : { ...query, cursor });
    expect(page.items.length).toBeLessThanOrEqual(query.limit);
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

async function walkEvidence(limit: number): Promise<EvidenceRecord[]> {
  const items: EvidenceRecord[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const page = await model.listEvidence(cursor === undefined ? { limit } : { limit, cursor });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

describe(`live Envio read model (chain ${chainId})`, { timeout: 300_000 }, () => {
  it("status() parses _meta and the progress singleton", async () => {
    const status = await model.status();
    expect(status.backend).toBe("envio");
    expect(status.chainId).toBe(chainId);
    expect(status.indexedBlock >= 0n).toBe(true);
    expect(status.halted).toBe(false);
    console.info(`indexedBlock ${status.indexedBlock} at ${status.indexedBlockTimestamp}, head ${status.headBlock}`);
  });

  it("claim pages are ordered and non-overlapping in both orders, and every claim lookup validates", async () => {
    const created = await walkClaims({ order: "created_desc", limit: 7 });
    expect(new Set(created.map((claim) => claim.market)).size).toBe(created.length);
    for (let index = 1; index < created.length; index += 1) {
      const [a, b] = [created[index - 1]!, created[index]!];
      expect(a.createdBlock > b.createdBlock || (a.createdBlock === b.createdBlock && a.createdLogIndex > b.createdLogIndex)).toBe(true);
    }
    const byDeadline = await walkClaims({ order: "evidence_deadline_asc", limit: 7 });
    expect(new Set(byDeadline.map((claim) => claim.market)).size).toBe(byDeadline.length);
    for (let index = 1; index < byDeadline.length; index += 1) {
      const [a, b] = [byDeadline[index - 1]!, byDeadline[index]!];
      expect(a.evidenceDeadline < b.evidenceDeadline || (a.evidenceDeadline === b.evidenceDeadline && a.market < b.market)).toBe(true);
    }
    const first = created.at(-1);
    if (first) {
      await walkClaims({ order: "created_desc", limit: 3, creator: first.creator, claimDocumentSha256: first.claimDocumentSha256 });
      await walkClaims({ order: "evidence_deadline_asc", limit: 3, evidenceDeadlineAfter: first.evidenceDeadline - 1, evidenceDeadlineAtOrBefore: first.evidenceDeadline });
      expect(await model.getClaim(first.market)).toEqual(first);
      expect((await model.listClaimsByQuestion(first.questionId)).map((claim) => claim.market)).toContain(first.market);
      const question = await model.getOracleQuestion(first.questionId);
      expect(question?.markets).toContain(first.market);
      await model.listOracleAnswers(first.questionId);
      await model.getArbitration(first.questionId);
      await model.getConditionResolution(first.conditionId);
    }
    expect(await model.getClaim(UNKNOWN_ADDRESS)).toBeNull();
    expect(await model.listClaimsByQuestion(UNKNOWN_HASH)).toEqual([]);
    expect(await model.getOracleQuestion(UNKNOWN_HASH)).toBeNull();
    expect(await model.listOracleAnswers(UNKNOWN_HASH)).toEqual([]);
    expect(await model.getArbitration(UNKNOWN_HASH)).toBeNull();
    expect(await model.getConditionResolution(UNKNOWN_HASH)).toBeNull();
    await expect(model.listClaims({ order: "created_desc", limit: 5, cursor: "not-a-cursor" })).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("evidence pages are ordered and non-overlapping, and evidence lookups validate", async () => {
    const all = await walkEvidence(7);
    expect(new Set(all.map((item) => `${item.registry}:${item.submissionId}`)).size).toBe(all.length);
    for (let index = 1; index < all.length; index += 1) {
      const [a, b] = [all[index - 1]!, all[index]!];
      expect(a.committedBlock < b.committedBlock || (a.committedBlock === b.committedBlock && a.committedLogIndex < b.committedLogIndex)).toBe(true);
    }
    const first = all[0];
    if (first) {
      expect(await model.getEvidence(first.registry, first.submissionId)).toEqual(first);
      await model.listEvidence({ limit: 3, market: first.market, submitter: first.submitter, status: first.status });
    }
    expect(await model.getEvidence(UNKNOWN_ADDRESS, 1n)).toBeNull();
  });
});
