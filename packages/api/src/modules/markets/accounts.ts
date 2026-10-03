// Public account activity (PRD-04 section 2.4): claims created and evidence submitted by a wallet, from the read model,
// with one opaque cursor over both lists. Oracle answers by wallet are deferred (the frozen ReadModel has no lookup by
// answerer). Hidden claims and evidence are excluded (moderation "hide").

import { z } from "zod";
import { rawCidFromSha256 } from "@pine/shared/canonical";
import type { Address } from "@pine/shared/types";
import { ApiError } from "../../contracts/errors.js";
import { addressParam, CONTENT_TRUST, freshness, PUBLIC_ROUTE, sendPublic, withCursor, type MarketsRouteDeps } from "./common.js";

const PAGE = 20;

/** Per list: an inner read-model cursor, null for "from the start", or false when the list is exhausted. */
const activityCursor = z
  .object({ v: z.literal(1), claims: z.union([z.string().min(1).max(512), z.null(), z.literal(false)]), evidence: z.union([z.string().min(1).max(512), z.null(), z.literal(false)]) })
  .strict();
type ActivityCursor = z.infer<typeof activityCursor>;

function decode(cursor: string | undefined): ActivityCursor {
  if (cursor === undefined) return { v: 1, claims: null, evidence: null };
  try {
    return activityCursor.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new ApiError("BAD_REQUEST", "Invalid cursor");
  }
}

const encode = (cursor: ActivityCursor): string => Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

export function registerAccountRoutes({ app, ctx, state }: MarketsRouteDeps): void {
  app.get(
    "/api/v1/accounts/:wallet/activity",
    { config: PUBLIC_ROUTE, schema: { params: z.object({ wallet: addressParam }).strict(), querystring: z.object({ cursor: z.string().min(1).max(2048).optional() }).strict() } },
    async (request, reply) => {
      const wallet: Address = request.params.wallet;
      const cursor = decode(request.query.cursor);
      const claimsPage =
        cursor.claims === false
          ? { items: [], nextCursor: null }
          : await withCursor(() => ctx.readModel.listClaims({ creator: wallet, order: "created_desc", limit: PAGE, ...(cursor.claims ? { cursor: cursor.claims } : {}) }));
      const evidencePage =
        cursor.evidence === false
          ? { items: [], nextCursor: null }
          : await withCursor(() => ctx.readModel.listEvidence({ submitter: wallet, limit: PAGE, ...(cursor.evidence ? { cursor: cursor.evidence } : {}) }));
      const [hiddenClaims, hiddenEvidence] = await Promise.all([
        ctx.moderation.states("claim", claimsPage.items.map((claim) => claim.market)),
        ctx.moderation.states("evidence", evidencePage.items.map((record) => `${record.registry}:${record.submissionId.toString()}`)),
      ]);
      const isHidden = (map: Map<string, { action: string }>, id: string) => [...map].some(([key, value]) => key.toLowerCase() === id.toLowerCase() && value.action === "hide");
      const claims = claimsPage.items
        .filter((claim) => claim.registry === state.manifest.pine.claimRegistry && !isHidden(hiddenClaims, claim.market))
        .map((claim) => ({
          market: claim.market,
          title: claim.title,
          claimDocumentSha256: claim.claimDocumentSha256,
          evidenceDeadline: claim.evidenceDeadline,
          revealDeadline: claim.revealDeadline,
          createdAt: claim.createdAt,
          createdTxHash: claim.createdTxHash,
          contentTrust: CONTENT_TRUST,
        }));
      const evidence = evidencePage.items
        .filter((record) => !isHidden(hiddenEvidence, `${record.registry}:${record.submissionId.toString()}`))
        .map((record) => ({
          registry: record.registry,
          submissionId: record.submissionId.toString(),
          market: record.market,
          status: record.status,
          contentSha256: record.contentSha256,
          contentCid: record.contentSha256 ? rawCidFromSha256(record.contentSha256) : null,
          committedAt: record.committedAt,
          revealedAt: record.revealedAt,
          committedTxHash: record.committedTxHash,
        }));
      const next: ActivityCursor = { v: 1, claims: claimsPage.nextCursor ?? false, evidence: evidencePage.nextCursor ?? false };
      return sendPublic(request, reply, {
        wallet,
        claims,
        evidence,
        nextCursor: next.claims === false && next.evidence === false ? null : encode(next),
        oracleAnswers: { available: false, reason: "Oracle answers by wallet are not indexed by the read model yet." },
        freshness: await freshness(ctx),
      });
    },
  );
}
