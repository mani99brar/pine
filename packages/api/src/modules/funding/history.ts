// Funding history (PRD-04 3.3): the session user's plans with states, reported and confirmed transaction hashes, and
// the `/submitted` hint route of the shared plan-store contract. Owner only: another user's plan is NOT_FOUND.

import { z } from "zod";
import type { AppContext } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { sessionOf, type ZodApp } from "./common.js";
import { findOwnedPlan, listOwnedPlans, recordSubmitted, toView } from "./store.js";

export const HISTORY_PAGE_DEFAULT = 20;
export const HISTORY_PAGE_MAX = 50;

const planIdParams = z.object({ planId: z.uuid() }).strict();

const encodeCursor = (createdMs: number, id: string): string => Buffer.from(`${createdMs}:${id}`, "utf8").toString("base64url");

function decodeCursor(cursor: string): { createdMs: number; id: string } {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^(\d{1,15}):([0-9a-f-]{36})$/.exec(text);
  const createdMs = Number(match?.[1]);
  const id = match?.[2];
  if (!match || !Number.isSafeInteger(createdMs) || id === undefined || !z.uuid().safeParse(id).success) throw new ApiError("VALIDATION_FAILED", "Invalid cursor");
  return { createdMs, id };
}

export function registerHistoryRoutes(deps: { app: ZodApp; ctx: AppContext }): void {
  const { app, ctx } = deps;

  app.get(
    "/api/v1/funding/history",
    {
      preHandler: app.requireSession,
      schema: {
        querystring: z
          .object({ cursor: z.string().max(200).regex(/^[A-Za-z0-9_-]+$/).optional(), limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).default(HISTORY_PAGE_DEFAULT) })
          .strict(),
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const before = request.query.cursor ? decodeCursor(request.query.cursor) : null;
      const plans = await listOwnedPlans(ctx.db, session.userId, before, request.query.limit + 1);
      const page = plans.slice(0, request.query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toView),
        nextCursor: plans.length > request.query.limit && last ? encodeCursor(new Date(last.createdAt).getTime(), last.planId) : null,
      };
    },
  );

  app.get("/api/v1/funding/plans/:planId", { preHandler: app.requireSession, schema: { params: planIdParams } }, async (request) => {
    const session = sessionOf(request);
    const plan = await findOwnedPlan(ctx.db, session.userId, request.params.planId);
    if (!plan) throw new ApiError("NOT_FOUND", "Plan not found");
    return toView(plan);
  });

  app.post(
    "/api/v1/funding/plans/:planId/submitted",
    {
      preHandler: app.requireSession,
      schema: {
        params: planIdParams,
        body: z.object({ stepId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict(),
      },
    },
    async (request) => {
      const session = sessionOf(request);
      return recordSubmitted(ctx, request, session.userId, request.params.planId, request.body.stepId, request.body.txHash);
    },
  );
}
