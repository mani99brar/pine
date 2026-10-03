// Moderation (SEC-OPS-06, SEC-EVID-11): hide or block a subject with a reason. It never edits documents, content
// bytes or chain data. Admin routes require a fresh admin signature (requireAdmin) and audit every change in the
// change's own transaction: a failing audit insert rolls the change back.

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AuditEntry, Clock, Database, ModerationGateway, ModerationState, ModerationSubject } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { iso, queryRows, toDate, type Executor } from "./db.js";

export const MODERATION_SUBJECTS = ["claim", "evidence", "content", "wallet", "repository"] as const satisfies readonly ModerationSubject[];

const SUBJECT_ID_PATTERNS: Record<ModerationSubject, RegExp> = {
  claim: /^0x[0-9a-f]{40}$/,
  wallet: /^0x[0-9a-f]{40}$/,
  content: /^0x[0-9a-f]{64}$/,
  evidence: /^0x[0-9a-f]{40}:(?:0|[1-9][0-9]{0,77})$/,
  repository: /^[1-9][0-9]{0,15}$/,
};

export function normalizeSubjectId(subject: ModerationSubject, id: string): string | null {
  const lower = id.trim().toLowerCase();
  return SUBJECT_ID_PATTERNS[subject].test(lower) ? lower : null;
}

export interface ModerationRecord extends ModerationState {
  subject: ModerationSubject;
  id: string;
  actorUserId: string | null;
}

const MAX_IDS = 1000;

export interface ModerationChange {
  subject: ModerationSubject;
  id: string;
  action: "hide" | "block";
  reason: string;
  actorUserId: string;
}

/** The audit log as the moderation routes use it: always inside the moderation change's transaction. */
export interface TransactionalAuditLog {
  recordWith(executor: Executor, entry: AuditEntry): Promise<void>;
}

export class PostgresModeration implements ModerationGateway {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async states(subject: ModerationSubject, ids: readonly string[]): Promise<Map<string, ModerationState>> {
    const result = new Map<string, ModerationState>();
    if (ids.length === 0) return result;
    if (ids.length > MAX_IDS) throw new ApiError("BAD_REQUEST", "Too many ids");
    const lowered = [...new Set(ids.map((id) => id.toLowerCase()))];
    const rows = await queryRows<{ subject_id: string; action: "hide" | "block"; reason: string; created_at: unknown }>(
      this.db,
      sql`SELECT subject_id, action, reason, created_at FROM moderation_states
          WHERE subject = ${subject} AND subject_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(lowered)}::jsonb))`,
    );
    const byId = new Map(rows.map((row) => [row.subject_id, { action: row.action, reason: row.reason, at: toDate(row.created_at) } satisfies ModerationState]));
    for (const id of ids) {
      const state = byId.get(id.toLowerCase());
      if (state) result.set(id, { ...state });
    }
    return result;
  }

  async list(subject: ModerationSubject | undefined, limit: number): Promise<ModerationRecord[]> {
    const rows = await queryRows<{ subject: ModerationSubject; subject_id: string; action: "hide" | "block"; reason: string; actor_user_id: string | null; created_at: unknown }>(
      this.db,
      sql`SELECT subject, subject_id, action, reason, actor_user_id::text AS actor_user_id, created_at FROM moderation_states
          WHERE ${subject ?? null}::text IS NULL OR subject = ${subject ?? null}::text
          ORDER BY created_at DESC, subject, subject_id LIMIT ${limit}::integer`,
    );
    return rows.map((row) => ({ subject: row.subject, id: row.subject_id, action: row.action, reason: row.reason, actorUserId: row.actor_user_id, at: toDate(row.created_at) }));
  }

  /** Upserts a state; returns the previous one (null when none). */
  async set(input: ModerationChange): Promise<{ previous: ModerationState | null; current: ModerationState }> {
    return this.db.transaction(async (tx) => this.setWith(tx, input));
  }

  /** Upserts a state inside the caller's transaction (pass the transaction handle). */
  async setWith(tx: Executor, input: ModerationChange): Promise<{ previous: ModerationState | null; current: ModerationState }> {
    const now = this.clock.now();
    const before = await queryRows<{ action: "hide" | "block"; reason: string; created_at: unknown }>(
      tx,
      sql`SELECT action, reason, created_at FROM moderation_states WHERE subject = ${input.subject} AND subject_id = ${input.id} FOR UPDATE`,
    );
    await queryRows(
      tx,
      sql`INSERT INTO moderation_states (subject, subject_id, action, reason, actor_user_id, created_at)
          VALUES (${input.subject}, ${input.id}, ${input.action}, ${input.reason}, ${input.actorUserId}::uuid, ${iso(now)}::timestamptz)
          ON CONFLICT (subject, subject_id) DO UPDATE
            SET action = EXCLUDED.action, reason = EXCLUDED.reason, actor_user_id = EXCLUDED.actor_user_id, created_at = EXCLUDED.created_at
          RETURNING subject`,
    );
    const previous = before[0] ? { action: before[0].action, reason: before[0].reason, at: toDate(before[0].created_at) } : null;
    return { previous, current: { action: input.action, reason: input.reason, at: now } };
  }

  /** Removes a state; returns the removed one (null when none existed). */
  async remove(subject: ModerationSubject, id: string): Promise<ModerationState | null> {
    return this.removeWith(this.db, subject, id);
  }

  /** Removes a state with the given executor (inside a transaction always the transaction handle). */
  async removeWith(executor: Executor, subject: ModerationSubject, id: string): Promise<ModerationState | null> {
    const rows = await queryRows<{ action: "hide" | "block"; reason: string; created_at: unknown }>(
      executor,
      sql`DELETE FROM moderation_states WHERE subject = ${subject} AND subject_id = ${id} RETURNING action, reason, created_at`,
    );
    const row = rows[0];
    return row ? { action: row.action, reason: row.reason, at: toDate(row.created_at) } : null;
  }
}

const subjectSchema = z.enum(MODERATION_SUBJECTS);
const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[^\p{Cc}]*$/u, "must not contain control characters");

const stateSchema = z.object({
  subject: subjectSchema,
  id: z.string(),
  action: z.enum(["hide", "block"]),
  reason: z.string(),
  actorUserId: z.string().nullable(),
  at: z.string(),
});

export function registerModerationRoutes(app: FastifyInstance, deps: { db: Database; moderation: PostgresModeration; audit: TransactionalAuditLog }): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const subjectId = (subject: ModerationSubject, id: string): string => {
    const normalized = normalizeSubjectId(subject, id);
    if (!normalized) throw new ApiError("VALIDATION_FAILED", "Invalid subject id", { issues: [{ path: ["id"], message: `not a valid ${subject} id` }] });
    return normalized;
  };

  typed.get(
    "/api/v1/admin/moderation",
    {
      preHandler: app.requireAdmin,
      schema: {
        querystring: z.object({ subject: subjectSchema.optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).strict(),
        response: { 200: z.object({ items: z.array(stateSchema) }) },
      },
    },
    async (request) => {
      const items = await deps.moderation.list(request.query.subject, request.query.limit);
      return { items: items.map((item) => ({ ...item, at: item.at.toISOString() })) };
    },
  );

  typed.post(
    "/api/v1/admin/moderation",
    {
      preHandler: app.requireAdmin,
      schema: {
        body: z.object({ subject: subjectSchema, id: z.string().min(1).max(256), action: z.enum(["hide", "block"]), reason: reasonSchema }).strict(),
        response: { 200: stateSchema },
      },
    },
    async (request) => {
      const session = request.session;
      if (!session) throw new ApiError("UNAUTHENTICATED", "Sign in required");
      const { subject, action, reason } = request.body;
      const id = subjectId(subject, request.body.id);
      const { current } = await deps.db.transaction(async (tx) => {
        const change = await deps.moderation.setWith(tx, { subject, id, action, reason, actorUserId: session.userId });
        const { previous } = change;
        await deps.audit.recordWith(tx, {
          actorUserId: session.userId,
          action: action === "block" ? "moderation.blocked" : "moderation.hidden",
          subjectType: subject,
          subjectId: id,
          details: { action, reason, previous: previous ? { action: previous.action, reason: previous.reason } : null },
          ip: request.ip,
        });
        return change;
      });
      return { subject, id, action: current.action, reason: current.reason, actorUserId: session.userId, at: current.at.toISOString() };
    },
  );

  typed.delete(
    "/api/v1/admin/moderation",
    {
      preHandler: app.requireAdmin,
      schema: { body: z.object({ subject: subjectSchema, id: z.string().min(1).max(256), reason: reasonSchema }).strict() },
    },
    async (request, reply) => {
      const session = request.session;
      if (!session) throw new ApiError("UNAUTHENTICATED", "Sign in required");
      const { subject, reason } = request.body;
      const id = subjectId(subject, request.body.id);
      await deps.db.transaction(async (tx) => {
        const removed = await deps.moderation.removeWith(tx, subject, id);
        if (!removed) throw new ApiError("NOT_FOUND", "No moderation state for this subject");
        await deps.audit.recordWith(tx, {
          actorUserId: session.userId,
          action: "moderation.removed",
          subjectType: subject,
          subjectId: id,
          details: { reason, previous: { action: removed.action, reason: removed.reason } },
          ip: request.ip,
        });
      });
      return reply.status(204).send();
    },
  );
}
