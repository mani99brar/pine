// Jobs runner (PRD-02 2.5). One loop per job, never overlapping itself. Cross-process exclusion uses lease rows in
// job_leases written with database time only: acquire is one INSERT ... ON CONFLICT DO UPDATE ... WHERE expired, the
// holder renews every ttl/3 and aborts the run when renewal finds no row, and release sets expires_at = started_at +
// interval (and marks the holder released) so no process starts the job again before one interval has passed since this
// run started, and no late renewal of this run can extend the released row. This keeps the
// JobDefinition guarantee ("at most one execution at a time across all API processes") without holding a connection.
// A local deadline guards against renewals that fail or hang: a monotonic timestamp is taken just before each acquire
// or renewal is sent, and every confirmed one moves a single timer to sentAt + ttl - renewalPeriod. When it fires the
// run is aborted while the lease is still ours (the database expiry is at least sentAt + ttl). Abort is cooperative:
// the loop awaits the aborted run() before it tries to acquire the job again.

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { sql } from "drizzle-orm";
import type { AppContext, Database, JobDefinition, Metrics } from "../../contracts/app.js";
import { safeErrorMessage, type Redactor } from "../../contracts/redact.js";
import { queryRows } from "./db.js";

export interface JobLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface JobRunnerOptions {
  db: Database;
  ctx: AppContext;
  jobs: readonly JobDefinition[];
  logger: JobLogger;
  metrics: Metrics;
  redact: Redactor;
  /** Random per-process id by default. */
  holderId?: string;
  /** Lease TTL (default 60 s): a crashed holder blocks a job for at most this long. */
  leaseTtlMs?: number;
  /** Renewal period (default ttl/3); must be below ttl/2 so the local deadline falls after the next renewal. */
  renewMs?: number;
  /** Upper bound of the acquisition polling period (default 15 s); the loop polls every min(interval, pollMs). */
  pollMs?: number;
  /** Lease store override (tests); defaults to JobLeases over `db` with this runner's holder id and TTL. */
  leases?: (holderId: string, ttlMs: number) => LeaseStore;
}

export const DEFAULT_LEASE_TTL_MS = 60_000;
/** How long the runner waits for an in-flight renewal before releasing (a courtesy; the release statement is the guarantee). */
export const RENEWAL_SETTLE_MS = 2_000;

/** The lease primitives the runner uses (JobLeases in production; tests may wrap it to simulate failing renewals). */
export interface LeaseStore {
  readonly holderId: string;
  acquire(name: string): Promise<boolean>;
  renew(name: string): Promise<boolean>;
  release(name: string, intervalMs: number): Promise<boolean>;
}

const ms = (value: number) => sql`(${value}::double precision * interval '1 millisecond')`;

/** Lease primitives (database time only). */
export class JobLeases implements LeaseStore {
  constructor(
    private readonly db: Database,
    readonly holderId: string,
    private readonly ttlMs: number,
  ) {}

  /** Acquired iff a row is returned: inserted, or taken over because the previous lease expired. */
  async acquire(name: string): Promise<boolean> {
    const rows = await queryRows<{ holder: string }>(
      this.db,
      sql`INSERT INTO job_leases (name, holder, started_at, expires_at)
          VALUES (${name}, ${this.holderId}, now(), now() + ${ms(this.ttlMs)})
          ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, started_at = now(), expires_at = now() + ${ms(this.ttlMs)}
          WHERE job_leases.expires_at <= now()
          RETURNING holder`,
    );
    return rows.length === 1 && rows[0]?.holder === this.holderId;
  }

  /** False when the lease is no longer ours (the run must abort). */
  async renew(name: string): Promise<boolean> {
    const rows = await queryRows<{ name: string }>(
      this.db,
      sql`UPDATE job_leases SET expires_at = now() + ${ms(this.ttlMs)} WHERE name = ${name} AND holder = ${this.holderId} RETURNING name`,
    );
    return rows.length === 1;
  }

  /**
   * Keeps the job blocked until one interval after this run started and marks the holder released, so a late or hung
   * renewal of this run (WHERE holder = us) updates zero rows and can never overwrite the release. Acquire ignores the
   * holder, so the released row is taken over normally once it expires.
   */
  async release(name: string, intervalMs: number): Promise<boolean> {
    const rows = await queryRows<{ name: string }>(
      this.db,
      sql`UPDATE job_leases SET expires_at = started_at + ${ms(intervalMs)}, holder = holder || ':released'
          WHERE name = ${name} AND holder = ${this.holderId} RETURNING name`,
    );
    return rows.length === 1;
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Resolves when `promise` settles or after `milliseconds`, whichever comes first (never rejects). */
async function settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, milliseconds);
    }),
  ]);
  clearTimeout(timer);
}

export class JobRunner {
  readonly leases: LeaseStore;
  private readonly ttlMs: number;
  private readonly renewMs: number;
  private readonly pollMs: number;
  private readonly controller = new AbortController();
  private loops: Promise<void>[] = [];

  constructor(private readonly options: JobRunnerOptions) {
    this.ttlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.renewMs = options.renewMs ?? Math.floor(this.ttlMs / 3);
    this.pollMs = options.pollMs ?? 15_000;
    if (this.ttlMs < 1 || this.renewMs < 1 || this.pollMs < 1) throw new Error("job runner timings must be positive");
    if (this.renewMs * 2 >= this.ttlMs) throw new Error("job lease renewal period must be below half the lease TTL");
    const names = new Set<string>();
    for (const job of options.jobs) {
      if (names.has(job.name)) throw new Error(`Duplicate job name ${job.name}`);
      if (!Number.isFinite(job.intervalMs) || job.intervalMs < 1) throw new Error(`Job ${job.name} has an invalid interval`);
      names.add(job.name);
    }
    const holderId = options.holderId ?? `${process.pid}-${randomUUID()}`;
    this.leases = options.leases ? options.leases(holderId, this.ttlMs) : new JobLeases(options.db, holderId, this.ttlMs);
  }

  /** The names of the jobs this runner drives. */
  get jobNames(): string[] {
    return this.options.jobs.map((job) => job.name);
  }

  /** Effective lease timing (defaults applied). */
  get timing(): { ttlMs: number; renewMs: number; pollMs: number } {
    return { ttlMs: this.ttlMs, renewMs: this.renewMs, pollMs: this.pollMs };
  }

  /** The acquisition polling period of a job: min(interval, pollMs). */
  pollPeriod(job: Pick<JobDefinition, "intervalMs">): number {
    return Math.min(job.intervalMs, this.pollMs);
  }

  start(): void {
    if (this.loops.length > 0) return;
    this.loops = this.options.jobs.map((job) => this.loop(job));
  }

  /** Aborts running jobs and waits for every loop (and so every run) to finish. */
  async stop(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled(this.loops);
  }

  private async loop(job: JobDefinition): Promise<void> {
    const stop = this.controller.signal;
    const period = this.pollPeriod(job);
    while (!stop.aborted) {
      try {
        const sentAt = performance.now();
        // runOnce settles only after job.run() has settled, so an aborted run is never overlapped by a new one here.
        if (await this.leases.acquire(job.name)) await this.runOnce(job, sentAt);
      } catch (error) {
        this.options.logger.error("job lease error", { job: job.name, error: safeErrorMessage(error, this.options.redact) });
      }
      await sleep(period, stop);
    }
  }

  private async runOnce(job: JobDefinition, acquiredSentAt: number): Promise<void> {
    const { logger, metrics, redact } = this.options;
    const run = new AbortController();
    const onStop = () => run.abort();
    this.controller.signal.addEventListener("abort", onStop, { once: true });
    // stop() may have landed while the acquire was in flight: the run then starts already aborted.
    if (this.controller.signal.aborted) run.abort();
    let lost = false;
    let renewing: Promise<void> | null = null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const giveUp = (reason: "lost" | "deadline") => {
      if (run.signal.aborted) return;
      if (reason === "lost") lost = true;
      logger.error(reason === "lost" ? "job lease lost; aborting run" : "job lease not renewed in time; aborting run", { job: job.name });
      metrics.increment("job_lease_lost", { job: job.name, reason });
      run.abort();
    };
    // One timer: the lease confirmed at sentAt is ours until at least sentAt + ttl; abort one renewal period earlier.
    const armDeadline = (sentAt: number) => {
      clearTimeout(deadline);
      deadline = setTimeout(() => giveUp("deadline"), Math.max(0, sentAt + this.ttlMs - this.renewMs - performance.now()));
    };
    armDeadline(acquiredSentAt);
    const timer = setInterval(() => {
      if (renewing || run.signal.aborted) return;
      const sentAt = performance.now();
      renewing = this.leases
        .renew(job.name)
        .then(
          (held) => {
            if (run.signal.aborted) return;
            if (held) armDeadline(sentAt);
            else giveUp("lost");
          },
          // A failed renewal leaves the deadline where it was: the next renewal may still confirm the lease in time.
          (error: unknown) => logger.error("job lease renewal failed", { job: job.name, error: safeErrorMessage(error, redact) }),
        )
        .finally(() => {
          renewing = null;
        });
    }, this.renewMs);
    const started = Date.now();
    try {
      await job.run(this.options.ctx, run.signal);
      metrics.increment("job_runs", { job: job.name, result: "ok" });
    } catch (error) {
      metrics.increment("job_runs", { job: job.name, result: "error" });
      logger.error("job failed", { job: job.name, error: safeErrorMessage(error, redact) });
    } finally {
      clearInterval(timer);
      clearTimeout(deadline);
      this.controller.signal.removeEventListener("abort", onStop);
      metrics.observe("job_run", (Date.now() - started) / 1000, { job: job.name });
      // Let an in-flight renewal land before the release, for at most RENEWAL_SETTLE_MS. A renewal that is still in flight
      // afterwards cannot undo the release: the release renames the holder, and renewals match on it.
      if (renewing) await settleWithin(renewing, RENEWAL_SETTLE_MS);
      // The release only touches a row this holder still owns (WHERE holder = us), so it is safe after a deadline abort.
      if (!lost) {
        try {
          await this.leases.release(job.name, job.intervalMs);
        } catch (error) {
          logger.error("job lease release failed", { job: job.name, error: safeErrorMessage(error, redact) });
        }
      }
    }
  }
}
