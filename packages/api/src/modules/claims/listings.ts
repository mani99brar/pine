// Public claim endpoints (PRD-03 §8, §8a): cookie-free, ETag over the final body, `no-cache` (moderation applies on every
// read), staleness on every response. Lists hold listable, unmoderated claims only; the detail endpoint shows every
// claim with its integrity, listability and moderation status.

import { z } from "zod";
import { ApiError } from "../../contracts/errors.js";
import { freshnessOf, nowSeconds, PUBLIC_ROUTE, sendPublic } from "./common.js";
import type { ClaimsRouteDeps } from "./state.js";
import { addressParam, findIndexRow, integrityJson, isListable, listingQuerySchema, listListable, moderationJson, moderationOf, platformFacts } from "./views.js";

export function registerListingRoutes({ app, ctx, state }: ClaimsRouteDeps): void {
  app.get("/api/v1/claims", { config: PUBLIC_ROUTE, schema: { querystring: listingQuerySchema } }, async (request, reply) => {
    const now = nowSeconds(ctx);
    const status = await ctx.readModel.status();
    const page = await listListable(ctx, request.query, now, state.catalog.publishableDigests(ctx.config));
    const items = [];
    for (const { row } of page.items) {
      const claim = await ctx.readModel.getClaim(row.market);
      if (!claim) continue;
      items.push({ ...(await platformFacts(ctx, claim, now, true)), title: claim.title, policyId: row.policyId, integrity: integrityJson(row), listable: true });
    }
    return sendPublic(request, reply, { items, nextCursor: page.nextCursor, indexer: freshnessOf(status, now, ctx.config) });
  });

  app.get("/api/v1/claims/:market", { config: PUBLIC_ROUTE, schema: { params: z.object({ market: addressParam }).strict() } }, async (request, reply) => {
    const now = nowSeconds(ctx);
    const market = request.params.market;
    const status = await ctx.readModel.status();
    const claim = await ctx.readModel.getClaim(market);
    if (!claim) throw new ApiError("NOT_FOUND", "Claim not found");
    const row = await findIndexRow(ctx, market);
    const moderation = await moderationOf(ctx, market, claim.claimDocumentSha256);
    const listable = isListable(row, state.catalog.publishableDigests(ctx.config));
    return sendPublic(request, reply, {
      claim: {
        ...(await platformFacts(ctx, claim, now, !moderation.blocked)),
        // A blocked claim or document shows metadata only: no user-supplied text and no content link.
        title: moderation.blocked ? null : claim.title,
        marketName: moderation.blocked ? null : claim.marketName,
        policyId: row?.policyId ?? null,
        integrity: integrityJson(row),
        listable,
        moderation: moderationJson(moderation.claim),
        contentModeration: moderationJson(moderation.content),
        hidden: moderation.hidden,
        listed: listable && !moderation.hidden,
      },
      indexer: freshnessOf(status, now, ctx.config),
    });
  });
}
