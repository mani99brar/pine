// /healthz (process alive) and /readyz (database reachable, migrations verified, read model not halted and fresh).
// Both are public, cookie-free routes; failure details are logged redacted, clients only see check states.
// The readiness result is computed at most once every 5 s (single-flight) and served from that cache, and migrations
// are re-verified at most every 60 s (they are verified at startup), so the public route never costs a database round
// trip per request. Cache ages use ctx.clock; a clock that moves backwards invalidates the cache.

import { sql } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppContext } from "../../contracts/app.js";
import { safeErrorMessage } from "../../contracts/redact.js";
import { queryRows } from "./db.js";

export interface Readiness {
  /** Throws unless every migration file is applied unchanged (verifyMigrations over the runtime role). */
  verifyMigrations(): Promise<void>;
  /** True when the caller verified migrations immediately before building the app (src/main.ts does). */
  verifiedAtStartup?: boolean;
}

export const READINESS_CACHE_MS = 5_000;
export const MIGRATIONS_RECHECK_MS = 60_000;

type CheckState = "ok" | "failed" | "stale" | "halted";
interface ReadinessResult {
  ready: boolean;
  body: { status: "ready" | "not_ready"; checks: { database: CheckState; migrations: CheckState; readModel: CheckState } };
}

const age = (now: number, at: number) => (now < at ? Number.POSITIVE_INFINITY : now - at);

export class ReadinessProbe {
  private cached: { at: number; result: ReadinessResult } | null = null;
  private inflight: Promise<ReadinessResult> | null = null;
  private migrationsCheckedAt: number | null;
  private migrationsOk: boolean;

  constructor(
    private readonly ctx: Pick<AppContext, "db" | "clock" | "readModel" | "redact" | "config">,
    private readonly readiness: Readiness,
  ) {
    this.migrationsOk = readiness.verifiedAtStartup === true;
    this.migrationsCheckedAt = this.migrationsOk ? ctx.clock.now().getTime() : null;
  }

  async check(log: FastifyBaseLogger): Promise<ReadinessResult> {
    const now = this.ctx.clock.now().getTime();
    if (this.cached && age(now, this.cached.at) < READINESS_CACHE_MS) return this.cached.result;
    this.inflight ??= this.compute(log).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async compute(log: FastifyBaseLogger): Promise<ReadinessResult> {
    const { ctx } = this;
    const checks: ReadinessResult["body"]["checks"] = { database: "failed", migrations: "failed", readModel: "failed" };
    try {
      await queryRows(ctx.db, sql`SELECT 1::int AS ok`);
      checks.database = "ok";
    } catch (error) {
      log.warn({ error: safeErrorMessage(error, ctx.redact) }, "readiness: database unreachable");
    }
    if (checks.database === "ok") {
      const now = ctx.clock.now().getTime();
      if (this.migrationsCheckedAt === null || age(now, this.migrationsCheckedAt) >= MIGRATIONS_RECHECK_MS) {
        try {
          await this.readiness.verifyMigrations();
          this.migrationsOk = true;
        } catch (error) {
          this.migrationsOk = false;
          log.warn({ error: safeErrorMessage(error, ctx.redact) }, "readiness: migrations not verified");
        }
        this.migrationsCheckedAt = now;
      }
      checks.migrations = this.migrationsOk ? "ok" : "failed";
    }
    try {
      const status = await ctx.readModel.status();
      const lag = Math.floor(ctx.clock.now().getTime() / 1000) - status.indexedBlockTimestamp;
      checks.readModel = status.halted ? "halted" : lag > ctx.config.maxIndexerLagSeconds ? "stale" : "ok";
    } catch (error) {
      log.warn({ error: safeErrorMessage(error, ctx.redact) }, "readiness: read model unavailable");
    }
    const ready = checks.database === "ok" && checks.migrations === "ok" && checks.readModel === "ok";
    const result: ReadinessResult = { ready, body: { status: ready ? "ready" : "not_ready", checks } };
    this.cached = { at: ctx.clock.now().getTime(), result };
    return result;
  }
}

export function registerHealthRoutes(app: FastifyInstance, deps: { ctx: AppContext; readiness: Readiness }): void {
  const probe = new ReadinessProbe(deps.ctx, deps.readiness);
  app.get("/healthz", { config: { pine: { public: true } }, schema: { hide: true } }, async () => ({ status: "ok" }));

  app.get("/readyz", { config: { pine: { public: true } }, schema: { hide: true } }, async (request, reply) => {
    const result = await probe.check(request.log);
    return reply.status(result.ready ? 200 : 503).send(result.body);
  });
}
