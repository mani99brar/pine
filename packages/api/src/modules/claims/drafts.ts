// Drafts (PRD-03 §4): owner-only, mutable inputs validated with the claim document's own text rules. Another user's
// draft id is NOT_FOUND (no existence oracle). Policies are gated on create and update (SEC-CLAIM-06).

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { safeText } from "@pine/shared/claim-document";
import { MAX_TITLE_BYTES, validateTitle } from "@pine/shared/question";
import type { AppContext } from "../../contracts/app.js";
import { ApiError, type ErrorIssue } from "../../contracts/errors.js";
import type { PolicyEntry } from "./catalog.js";
import { policyIdSchema, policyVersionSchema } from "./catalog.js";
import { auditIp, evidenceWindowBounds, MIN_BOND_LOWER, MIN_BOND_UPPER, sessionOf } from "./common.js";
import { fromMs, msOf, one, rows, sql, toNumber, ts, type Executor } from "./db.js";
import { branchNameSchema, commitShaSchema, githubOwnerSchema, githubRepoNameSchema } from "./github.js";
import { draftDeleteRaceError } from "./races.js";
import type { ClaimsRouteDeps, ClaimsState } from "./state.js";

const titleSchema = z
  .string()
  .max(MAX_TITLE_BYTES)
  .superRefine((value, issue) => {
    try {
      validateTitle(value);
    } catch (error) {
      issue.addIssue({ code: "custom", message: (error as Error).message });
    }
  });

export const draftInputSchema = z
  .object({
    repository: z.object({ owner: githubOwnerSchema, name: githubRepoNameSchema }).strict(),
    commit: commitShaSchema,
    baseCommit: commitShaSchema.nullable().default(null),
    membership: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("pull"), number: z.number().int().positive().max(2 ** 31 - 1) }).strict(),
      z.object({ kind: z.literal("branch"), name: branchNameSchema }).strict(),
    ]),
    policy: z.object({ id: policyIdSchema, version: policyVersionSchema }).strict(),
    title: titleSchema,
    requirement: safeText(4_000),
    violation: safeText(4_000),
    scope: z.object({ components: z.array(safeText(300)).min(1).max(50), outOfScope: z.array(safeText(300)).max(50) }).strict(),
    allowedInputs: safeText(4_000),
    assumptions: z.array(safeText(1_000)).max(50),
    faultModel: safeText(4_000),
    regressionOnly: z.boolean(),
    exclusions: z.array(safeText(1_000)).max(50),
    policyParameters: z.record(z.string(), z.unknown()),
    environment: z
      .object({
        runtime: safeText(2_000),
        dependencies: safeText(4_000),
        configuration: safeText(8_000),
        externalState: safeText(4_000),
        reproduction: z.object({ setup: safeText(8_000), command: safeText(2_000), notes: safeText(8_000, 0) }).strict(),
      })
      .strict(),
    /** Seconds from preview time to the evidence deadline (rounded up to the minute at preview). */
    evidenceWindowSeconds: z.number().int().positive().nullable().default(null),
    /** Reality minimum bond, native wei, decimal string. */
    minBondWei: z.string().regex(/^[1-9][0-9]{0,30}$/, "must be a positive base-10 integer string").nullable().default(null),
  })
  .strict()
  .superRefine((input, issue) => {
    if (input.regressionOnly && input.baseCommit === null) issue.addIssue({ code: "custom", path: ["baseCommit"], message: "regression-only claims need a base commit" });
    if (input.baseCommit !== null && input.baseCommit === input.commit) issue.addIssue({ code: "custom", path: ["baseCommit"], message: "base commit must differ from the target commit" });
  });

export type DraftInput = z.output<typeof draftInputSchema>;

export interface DraftRow {
  id: string;
  userId: string;
  revision: number;
  /** The stored input exactly as saved (it may predate a tightened rule). */
  stored: unknown;
  /** The stored input under the current rules, or null with the issues explaining why it no longer passes. */
  input: DraftInput | null;
  issues: ErrorIssue[];
  createdAt: Date;
  updatedAt: Date;
}

const draftColumns = sql`id::text AS id, user_id::text AS user_id, revision::int AS revision, input, ${msOf(sql`created_at`)} AS created_ms, ${msOf(sql`updated_at`)} AS updated_ms`;

interface RawDraft {
  id: string;
  user_id: string;
  revision: unknown;
  input: unknown;
  created_ms: unknown;
  updated_ms: unknown;
}

const issuesOf = (error: z.ZodError, prefix: (string | number)[] = []): ErrorIssue[] =>
  error.issues.map((item) => ({ path: [...prefix, ...item.path.map((part) => (typeof part === "number" ? part : String(part)))], message: item.message }));

/** Tolerant read: a draft saved under an older rule still lists and loads; it is revalidated at update and preview. */
function toDraft(row: RawDraft): DraftRow {
  const parsed = draftInputSchema.safeParse(row.input);
  return {
    id: row.id,
    userId: row.user_id,
    revision: toNumber(row.revision),
    stored: row.input,
    input: parsed.success ? parsed.data : null,
    issues: parsed.success ? [] : issuesOf(parsed.error),
    createdAt: fromMs(row.created_ms),
    updatedAt: fromMs(row.updated_ms),
  };
}

/** The draft's input under the current rules, or a validation error (never a 500) when it no longer passes them. */
export function currentInput(draft: DraftRow): DraftInput {
  if (draft.input === null) throw new ApiError("VALIDATION_FAILED", "The draft no longer passes the current rules; edit it and try again", { issues: draft.issues });
  return draft.input;
}

/** Owner-scoped lookup: another user's draft is indistinguishable from a missing one. */
export async function findDraft(db: Executor, userId: string, id: string): Promise<DraftRow | null> {
  const row = await one<RawDraft>(db, sql`SELECT ${draftColumns} FROM claim_drafts WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`);
  return row ? toDraft(row) : null;
}

/** Policy gate plus policy-parameter and window/bond checks shared by drafts and previews. */
export function validateDraftPolicy(state: ClaimsState, ctx: AppContext, input: DraftInput): PolicyEntry {
  const entry = state.catalog.requirePublishable(input.policy.id, input.policy.version, ctx.config);
  const schema = state.catalog.parameterSchema(entry.id, entry.version);
  if (!schema) throw new ApiError("FEATURE_DISABLED", "This policy version cannot be published");
  const parsed = schema.safeParse(input.policyParameters);
  if (!parsed.success) {
    throw new ApiError("VALIDATION_FAILED", "Policy parameters are invalid", { issues: issuesOf(parsed.error, ["policyParameters"]) });
  }
  const bounds = evidenceWindowBounds(ctx.config);
  const window = input.evidenceWindowSeconds ?? ctx.config.claims.defaultEvidenceWindowSeconds;
  if (window < bounds.min || window > bounds.max) {
    throw new ApiError("VALIDATION_FAILED", `The evidence window must be between ${bounds.min} and ${bounds.max - 60} seconds (the deadline is rounded up to the minute)`, {
      issues: [{ path: ["evidenceWindowSeconds"], message: `must be between ${bounds.min} and ${bounds.max - 60}` }],
    });
  }
  const bond = input.minBondWei === null ? ctx.config.claims.defaultMinBondWei : BigInt(input.minBondWei);
  if (bond < MIN_BOND_LOWER || bond > MIN_BOND_UPPER) {
    throw new ApiError("VALIDATION_FAILED", "The minimum bond must be between 1 and 100 xDAI", { issues: [{ path: ["minBondWei"], message: "must be between 1 and 100 xDAI (in wei)" }] });
  }
  return entry;
}

const draftResponse = (draft: DraftRow) => ({
  id: draft.id,
  revision: draft.revision,
  input: draft.input ?? draft.stored,
  valid: draft.input !== null,
  issues: draft.issues,
  createdAt: draft.createdAt.toISOString(),
  updatedAt: draft.updatedAt.toISOString(),
});

const idParams = z.object({ id: z.uuid() }).strict();

export function registerDraftRoutes({ app, ctx, state }: ClaimsRouteDeps): void {
  const guard = { preHandler: app.requireSession };

  app.post("/api/v1/drafts", { ...guard, schema: { body: draftInputSchema } }, async (request, reply) => {
    const session = sessionOf(request);
    validateDraftPolicy(state, ctx, request.body);
    await ctx.quotas.consume(session.userId, "claim_drafts_per_day");
    const now = ctx.clock.now();
    const id = randomUUID();
    const [row] = await rows<RawDraft>(
      ctx.db,
      sql`INSERT INTO claim_drafts (id, user_id, revision, input, created_at, updated_at)
          VALUES (${id}::uuid, ${session.userId}::uuid, 1, ${JSON.stringify(request.body)}::jsonb, ${ts(now)}, ${ts(now)})
          RETURNING ${draftColumns}`,
    );
    if (!row) throw new Error("draft insert returned nothing");
    await ctx.audit.record({ actorUserId: session.userId, action: "claim.draft.created", subjectType: "claim_draft", subjectId: id, details: { policy: `${request.body.policy.id}@${request.body.policy.version}` }, ip: auditIp(request) });
    return reply.status(201).send({ draft: draftResponse(toDraft(row)) });
  });

  app.get(
    "/api/v1/drafts",
    { ...guard, schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict() } },
    async (request) => {
      const session = sessionOf(request);
      const list = await rows<RawDraft>(ctx.db, sql`SELECT ${draftColumns} FROM claim_drafts WHERE user_id = ${session.userId}::uuid ORDER BY created_at DESC, id LIMIT ${request.query.limit}`);
      return { items: list.map((row) => draftResponse(toDraft(row))) };
    },
  );

  app.get("/api/v1/drafts/:id", { ...guard, schema: { params: idParams } }, async (request) => {
    const session = sessionOf(request);
    const draft = await findDraft(ctx.db, session.userId, request.params.id);
    if (!draft) throw new ApiError("NOT_FOUND", "Draft not found");
    return { draft: draftResponse(draft) };
  });

  app.put(
    "/api/v1/drafts/:id",
    { ...guard, schema: { params: idParams, body: z.object({ input: draftInputSchema, expectedRevision: z.number().int().positive().optional() }).strict() } },
    async (request) => {
      const session = sessionOf(request);
      const { input, expectedRevision } = request.body;
      const existing = await findDraft(ctx.db, session.userId, request.params.id);
      if (!existing) throw new ApiError("NOT_FOUND", "Draft not found");
      validateDraftPolicy(state, ctx, input);
      const revision = expectedRevision ?? existing.revision;
      const [row] = await rows<RawDraft>(
        ctx.db,
        sql`UPDATE claim_drafts SET input = ${JSON.stringify(input)}::jsonb, revision = revision + 1, updated_at = ${ts(ctx.clock.now())}
            WHERE id = ${existing.id}::uuid AND user_id = ${session.userId}::uuid AND revision = ${revision}
            RETURNING ${draftColumns}`,
      );
      if (!row) throw new ApiError("CONFLICT", "The draft was changed concurrently; reload it and try again");
      await ctx.audit.record({ actorUserId: session.userId, action: "claim.draft.updated", subjectType: "claim_draft", subjectId: existing.id, details: { revision: revision + 1 }, ip: auditIp(request) });
      return { draft: draftResponse(toDraft(row)) };
    },
  );

  app.delete("/api/v1/drafts/:id", { ...guard, schema: { params: idParams } }, async (request, reply) => {
    const session = sessionOf(request);
    const id = request.params.id;
    let outcome: "deleted" | "missing" | "published";
    try {
      // Lock order (PRD-03 §8b): the draft row first, then its previews, then the publication check. A first publication
      // takes FOR SHARE on the same draft row before its insert, so the two paths serialize on the draft.
      outcome = await ctx.db.transaction(async (tx) => {
        const draft = await one<{ id: string }>(tx, sql`SELECT id::text AS id FROM claim_drafts WHERE id = ${id}::uuid AND user_id = ${session.userId}::uuid FOR UPDATE`);
        if (!draft) return "missing" as const;
        await tx.execute(sql`SELECT id FROM claim_previews WHERE draft_id = ${id}::uuid ORDER BY id FOR UPDATE`);
        const published = await one<{ id: string }>(tx, sql`SELECT id::text AS id FROM claim_publications WHERE draft_id = ${id}::uuid LIMIT 1`);
        if (published) return "published" as const;
        await tx.execute(sql`DELETE FROM claim_previews WHERE draft_id = ${id}::uuid`);
        const deleted = await rows<{ id: string }>(tx, sql`DELETE FROM claim_drafts WHERE id = ${id}::uuid AND user_id = ${session.userId}::uuid RETURNING id::text AS id`);
        return deleted.length === 1 ? ("deleted" as const) : ("missing" as const);
      });
    } catch (error) {
      // A publication created concurrently (FK/RESTRICT) or a lost deadlock/serialization race: 409, never 500.
      const mapped = draftDeleteRaceError(error);
      if (mapped) throw mapped;
      throw error;
    }
    if (outcome === "missing") throw new ApiError("NOT_FOUND", "Draft not found");
    if (outcome === "published") throw new ApiError("CONFLICT", "This draft has a publication and cannot be deleted");
    await ctx.audit.record({ actorUserId: session.userId, action: "claim.draft.deleted", subjectType: "claim_draft", subjectId: id, details: {}, ip: auditIp(request) });
    return reply.status(204).send();
  });
}
