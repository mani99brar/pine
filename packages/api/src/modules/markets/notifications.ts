// Notifications (PRD-04 section 2.4, operator-settled routes under /api/v1/accounts/me): job markets.watch derives due
// actions and deadline proximity from read-model facts only (no eth_call), at most 200 claims per run with a persisted
// rotating cursor, and inserts idempotent rows (unique per user, claim, kind and target time) for the claim creator and
// the evidence submitters that have a Pine account. Nothing is notified while the read model is stale or halted. The
// abort signal is checked between listing pages and between claims; an aborted run keeps the persisted cursor, so the
// claims it fetched but did not process are not skipped (the next run repeats them; inserts are idempotent).

import { z } from "zod";
import { deriveOracleStatus, InvalidCursorError, type ClaimRecord, type Page } from "@pine/shared/read-model";
import type { Address } from "@pine/shared/types";
import type { AppContext, JobDefinition } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { DAY, freshness, HOUR, isoSeconds, nowSeconds, sessionOf, type MarketsRouteDeps, type MarketsState } from "./common.js";
import { fromJson, fromMs, jsonb, msOf, one, rows, sql, toNumber, ts } from "./db.js";
import { dueActions } from "./due-actions.js";

export const WATCH_MAX_CLAIMS = 200;
const WATCH_PAGE = 100;
const SUBMITTER_PAGES = 5;
const NOTIFICATION_PAGE = 50;

export interface PendingNotification {
  kind: string;
  /** Unix seconds the notification is about (deadline, answer time, stage time). */
  target: number;
  message: string;
  payload: Record<string, unknown>;
}

/** Pure: the notifications a claim warrants now, from read-model facts. */
export async function notificationsFor(ctx: AppContext, state: MarketsState, claim: ClaimRecord, now: number): Promise<PendingNotification[]> {
  const out: PendingNotification[] = [];
  const base = { market: claim.market };
  if (now < claim.evidenceDeadline && claim.evidenceDeadline - now <= DAY) {
    out.push({ kind: "evidence_closing", target: claim.evidenceDeadline, message: `Evidence submission closes at ${isoSeconds(claim.evidenceDeadline)} UTC.`, payload: base });
  }
  if (now >= claim.evidenceDeadline && now < claim.revealDeadline && claim.revealDeadline - now <= 6 * HOUR) {
    out.push({ kind: "reveal_closing", target: claim.revealDeadline, message: `Evidence reveals close at ${isoSeconds(claim.revealDeadline)} UTC.`, payload: base });
  }
  const original = await ctx.readModel.getOracleQuestion(claim.questionId);
  const question = original?.reopenedBy ? await ctx.readModel.getOracleQuestion(original.reopenedBy) : original;
  const resolution = await ctx.readModel.getConditionResolution(claim.conditionId);
  if (question) {
    const status = deriveOracleStatus(question, now);
    if (now >= question.openingTs && status.state !== "not_open") {
      out.push({ kind: "answers_open", target: question.openingTs, message: "The oracle question is open for answers.", payload: { ...base, questionId: question.questionId } });
    }
    if (status.state === "answered" && status.finalizesAt - now <= DAY) {
      out.push({ kind: "finalization_soon", target: status.finalizesAt, message: `The current answer finalizes at ${isoSeconds(status.finalizesAt)} UTC unless challenged.`, payload: { ...base, questionId: question.questionId, outcome: status.outcome } });
    }
    const arbitration = await ctx.readModel.getArbitration(question.questionId);
    for (const entry of (arbitration?.history ?? []).slice(-10)) {
      out.push({ kind: `arbitration_${entry.stage}`, target: entry.at, message: `Arbitration stage changed: ${entry.stage}.`, payload: { ...base, questionId: question.questionId, stage: entry.stage } });
    }
    if (status.state === "finalized") {
      const answers = await ctx.readModel.listOracleAnswers(question.questionId);
      const due = dueActions({
        now,
        claim,
        question,
        original,
        answerCount: answers.length,
        arbitration,
        resolution,
        chain: null,
        account: null,
        klerosForeignProxy: state.manifest.kleros.foreignProxy,
        klerosForeignChainId: state.manifest.kleros.foreignChainId,
      });
      out.push({ kind: "finalized", target: question.finalizeTs, message: `The oracle question finalized (${status.outcome}).`, payload: { ...base, questionId: question.questionId, outcome: status.outcome, dueActions: due.map((action) => action.action) } });
    }
  }
  if (resolution) out.push({ kind: "resolved", target: resolution.resolvedAt, message: "The market was resolved.", payload: { ...base, payoutNumerators: resolution.payoutNumerators.map(String) } });
  return out;
}

async function recipientsOf(ctx: AppContext, claim: ClaimRecord): Promise<Address[]> {
  const wallets = new Set<Address>([claim.creator]);
  let cursor: string | undefined;
  for (let page = 0; page < SUBMITTER_PAGES; page += 1) {
    const result = await ctx.readModel.listEvidence({ market: claim.market, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const record of result.items) wallets.add(record.submitter);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return [...wallets];
}

export async function runWatch(ctx: AppContext, state: MarketsState, signal?: AbortSignal): Promise<{ claims: number; inserted: number; skipped: boolean }> {
  if ((await freshness(ctx)).stale) return { claims: 0, inserted: 0, skipped: true };
  const now = nowSeconds(ctx);
  const saved = await one<{ cursor: string | null }>(ctx.db, sql`SELECT cursor FROM markets_watch_state WHERE id = 1`);
  let cursor: string | null = saved?.cursor ?? null;
  const claims: ClaimRecord[] = [];
  while (claims.length < WATCH_MAX_CLAIMS && !signal?.aborted) {
    let page: Page<ClaimRecord>;
    try {
      page = await ctx.readModel.listClaims({ order: "created_desc", limit: Math.min(WATCH_PAGE, WATCH_MAX_CLAIMS - claims.length), ...(cursor ? { cursor } : {}) });
    } catch (error) {
      if (!(error instanceof InvalidCursorError) || cursor === null) throw error;
      cursor = null;
      continue;
    }
    claims.push(...page.items);
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  let inserted = 0;
  for (const claim of claims) {
    if (signal?.aborted) break;
    const pending = await notificationsFor(ctx, state, claim, now);
    if (pending.length === 0) continue;
    const wallets = await recipientsOf(ctx, claim);
    for (const item of pending) {
      // One statement per notification: only wallets with a Pine account receive it; duplicates are ignored.
      const added = await rows<{ id: string }>(
        ctx.db,
        sql`INSERT INTO markets_notifications (id, user_id, market, kind, target, message, payload, created_at)
            SELECT gen_random_uuid(), u.id, ${claim.market}, ${item.kind}, ${String(item.target)}::bigint, ${ctx.redact(item.message)}, ${jsonb(item.payload)}, ${ts(ctx.clock.now())}
            FROM users u WHERE u.wallet_address IN (SELECT jsonb_array_elements_text(${jsonb(wallets)}))
            ON CONFLICT (user_id, market, kind, target) DO NOTHING
            RETURNING id::text AS id`,
      );
      inserted += added.length;
    }
  }
  // Aborted: no further claim, and the cursor is not advanced past claims this run never processed.
  if (signal?.aborted) return { claims: claims.length, inserted, skipped: false };
  // The cursor rotates: after the last page the next run starts again from the newest claim.
  await ctx.db.execute(
    sql`INSERT INTO markets_watch_state (id, cursor, updated_at) VALUES (1, ${cursor}, ${ts(ctx.clock.now())})
        ON CONFLICT (id) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = EXCLUDED.updated_at`,
  );
  if (inserted > 0) ctx.metrics.increment("markets_notifications", { outcome: "inserted" });
  return { claims: claims.length, inserted, skipped: false };
}

export function watchJob(stateFor: (ctx: AppContext) => MarketsState): JobDefinition {
  return {
    name: "markets.watch",
    intervalMs: 60_000,
    async run(ctx, signal) {
      await runWatch(ctx, stateFor(ctx), signal);
    },
  };
}

const notificationCursor = z.object({ v: z.literal(1), ms: z.number().int().nonnegative(), id: z.uuid() }).strict();

function decodeNotificationCursor(cursor: string): { ms: number; id: string } {
  try {
    return notificationCursor.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new ApiError("BAD_REQUEST", "Invalid cursor");
  }
}

export function registerNotificationRoutes({ app, ctx }: MarketsRouteDeps): void {
  const guard = { preHandler: app.requireSession };
  app.get(
    "/api/v1/accounts/me/notifications",
    { ...guard, schema: { querystring: z.object({ cursor: z.string().min(1).max(256).optional(), unread: z.enum(["true", "false"]).optional() }).strict() } },
    async (request) => {
      const session = sessionOf(request);
      const after = request.query.cursor ? decodeNotificationCursor(request.query.cursor) : null;
      const unreadOnly = request.query.unread === "true";
      const list = await rows<{ id: string; market: string; kind: string; target: unknown; message: string; payload: unknown; created_ms: unknown; read_ms: unknown }>(
        ctx.db,
        sql`SELECT id::text AS id, market, kind, target::text AS target, message, payload, ${msOf(sql`created_at`)} AS created_ms,
              CASE WHEN read_at IS NULL THEN NULL ELSE ${msOf(sql`read_at`)} END AS read_ms
            FROM markets_notifications
            WHERE user_id = ${session.userId}::uuid
              ${unreadOnly ? sql`AND read_at IS NULL` : sql``}
              ${after ? sql`AND (created_at, id) < (${ts(new Date(after.ms))}, ${after.id}::uuid)` : sql``}
            ORDER BY created_at DESC, id DESC
            LIMIT ${NOTIFICATION_PAGE + 1}`,
      );
      const page = list.slice(0, NOTIFICATION_PAGE);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          id: row.id,
          market: row.market,
          kind: row.kind,
          target: toNumber(row.target),
          message: row.message,
          payload: fromJson<Record<string, unknown>>(row.payload),
          createdAt: fromMs(row.created_ms).toISOString(),
          readAt: row.read_ms === null ? null : fromMs(row.read_ms).toISOString(),
        })),
        nextCursor: list.length > NOTIFICATION_PAGE && last ? Buffer.from(JSON.stringify({ v: 1, ms: toNumber(last.created_ms), id: last.id }), "utf8").toString("base64url") : null,
      };
    },
  );

  // An empty (or absent) strict body: like every other route, unknown fields such as `salt` are refused.
  const readSchema = { params: z.object({ id: z.uuid() }).strict(), body: z.object({}).strict().nullish() };
  app.post("/api/v1/accounts/me/notifications/:id/read", { ...guard, schema: readSchema }, async (request) => {
    const session = sessionOf(request);
    const now = ctx.clock.now();
    // Idempotent: the first read time is kept; another user's notification is indistinguishable from a missing one.
    const row = await one<{ id: string; read_ms: unknown }>(
      ctx.db,
      sql`UPDATE markets_notifications SET read_at = COALESCE(read_at, ${ts(now)})
          WHERE id = ${request.params.id}::uuid AND user_id = ${session.userId}::uuid
          RETURNING id::text AS id, ${msOf(sql`read_at`)} AS read_ms`,
    );
    if (!row) throw new ApiError("NOT_FOUND", "Notification not found");
    return { id: row.id, readAt: fromMs(row.read_ms).toISOString() };
  });
}
