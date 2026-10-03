// Must stay the first import: blocks this file until no other PGlite-backed core test file runs.
import "./testing/suite-lock.js";
// Lease tests run in real time on PGlite (database now()) with intervals of at least 1 s, TTLs of at least 2 s,
// renewal >= 500 ms and a 100 ms poll period. Timing assertions are ranges with >= 1 s slack, or wait for a condition
// with a generous timeout; never exact counts after a fixed sleep. Tests never write job_leases directly: failing,
// hanging or zero-row renewals are simulated by wrapping the lease store the runner takes as a dependency.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppContext, JobDefinition } from "../../contracts/app.js";
import { createRedactor } from "../../contracts/redact.js";
import { MemoryMetrics } from "../../contracts/testing.js";
import { DEFAULT_LEASE_TTL_MS, JobLeases, JobRunner, RENEWAL_SETTLE_MS, type JobLogger, type LeaseStore } from "./jobs.js";
import { POOL_CONNECTION_TIMEOUT_MS } from "./pg.js";
import { useSharedDatabase } from "./testing/harness.js";

const db = useSharedDatabase({ beforeAll, afterAll, beforeEach });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SECRET = "job-secret-password-123";

/** Polls `condition` every 25 ms; fails the test when it does not hold within `timeoutMs`. */
async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await wait(25);
  }
}

function logger(): JobLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message, fields) => void lines.push(`${message} ${JSON.stringify(fields ?? {})}`),
    error: (message, fields) => void lines.push(`${message} ${JSON.stringify(fields ?? {})}`),
  };
}

function runner(
  holderId: string | null,
  jobs: JobDefinition[],
  options: {
    leaseTtlMs?: number | null;
    renewMs?: number | null;
    pollMs?: number | null;
    log?: JobLogger;
    leases?: (holderId: string, ttlMs: number) => LeaseStore;
    metrics?: MemoryMetrics;
  } = {},
) {
  return new JobRunner({
    db: db().db,
    ctx: {} as AppContext,
    jobs,
    logger: options.log ?? logger(),
    metrics: options.metrics ?? new MemoryMetrics(),
    redact: createRedactor([SECRET]),
    // null holder = the runner's own random per-process id
    ...(holderId === null ? {} : { holderId }),
    ...(options.leaseTtlMs === null ? {} : { leaseTtlMs: options.leaseTtlMs ?? 3_000 }),
    // null = the runner's default
    ...(options.renewMs === null ? {} : { renewMs: options.renewMs ?? 500 }),
    ...(options.pollMs === null ? {} : { pollMs: options.pollMs ?? 100 }),
    ...(options.leases ? { leases: options.leases } : {}),
  });
}

/** A lease store over the real JobLeases whose methods a test may override. */
function wrappedStore(overrides: (real: JobLeases) => Partial<LeaseStore>): (holderId: string, ttlMs: number) => LeaseStore {
  return (holderId, ttlMs) => {
    const real = new JobLeases(db().db, holderId, ttlMs);
    return {
      holderId,
      acquire: (name) => real.acquire(name),
      renew: (name) => real.renew(name),
      release: (name, intervalMs) => real.release(name, intervalMs),
      ...overrides(real),
    };
  };
}

describe("job leases (two holders on PGlite)", () => {
  it("B cannot acquire while A holds; after A releases B cannot acquire before the interval; B acquires after it", async () => {
    const a = new JobLeases(db().db, "holder-a", 5_000);
    const b = new JobLeases(db().db, "holder-b", 5_000);
    expect(await a.acquire("job.x")).toBe(true);
    expect(await b.acquire("job.x")).toBe(false);
    expect(await a.release("job.x", 2_000)).toBe(true);
    expect(await b.acquire("job.x")).toBe(false);
    await wait(500);
    expect(await b.acquire("job.x")).toBe(false);
    await wait(2_500);
    expect(await b.acquire("job.x")).toBe(true);
    expect(await a.renew("job.x")).toBe(false);
  });

  it("a renewal that lands after the release updates zero rows and cannot extend the released lease", async () => {
    const a = new JobLeases(db().db, "holder-a", 5_000);
    const b = new JobLeases(db().db, "holder-b", 5_000);
    expect(await a.acquire("job.late")).toBe(true);
    expect(await a.release("job.late", 1_000)).toBe(true);
    // The late renewal of the finished run (e.g. one that hung on another pool connection) must not revive the lease.
    expect(await a.renew("job.late")).toBe(false);
    expect(await a.release("job.late", 60_000)).toBe(false);
    await wait(2_000);
    expect(await b.acquire("job.late")).toBe(true);
  });

  it("an expired (crashed) holder is taken over after the TTL", async () => {
    const a = new JobLeases(db().db, "holder-a", 2_000);
    const b = new JobLeases(db().db, "holder-b", 2_000);
    expect(await a.acquire("job.crash")).toBe(true);
    await wait(300);
    expect(await b.acquire("job.crash")).toBe(false);
    await wait(3_000);
    expect(await b.acquire("job.crash")).toBe(true);
    expect(await a.release("job.crash", 1_000)).toBe(false);
  });

  it("each successful renewal moves the local deadline: a run lasting twice the TTL is not aborted and keeps its lease", async () => {
    // TTL 3 s, renewal 500 ms: the deadline armed at acquire would fire at ~2.5 s; renewals must keep pushing it.
    let finish: () => void = () => undefined;
    let aborted = false;
    let renewals = 0;
    const job: JobDefinition = {
      name: "job.long",
      intervalMs: 1_000,
      run: (_ctx, signal) =>
        new Promise<void>((resolve) => {
          finish = resolve;
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
    };
    const log = logger();
    const leases = wrappedStore((real) => ({
      renew: async (name) => {
        renewals += 1;
        return real.renew(name);
      },
    }));
    const a = runner("holder-a", [job], { leaseTtlMs: 3_000, renewMs: 500, log, leases });
    const b = new JobLeases(db().db, "holder-b", 3_000);
    a.start();
    await wait(4_000);
    // Past the TTL and past the unrenewed deadline: B still cannot take the lease.
    expect(await b.acquire("job.long")).toBe(false);
    await wait(2_000);
    expect(await b.acquire("job.long")).toBe(false);
    expect(aborted).toBe(false);
    // ~12 renewals in 6 s; the range only proves renewals kept happening.
    expect(renewals).toBeGreaterThanOrEqual(4);
    expect(log.lines.join("\n")).not.toContain("not renewed in time");
    finish();
    await a.stop();
  });

  it("a holder whose renewal updates zero rows aborts its run and does not release the new holder's lease", async () => {
    let aborted = false;
    const job: JobDefinition = {
      name: "job.lost",
      intervalMs: 1_000,
      run: (_ctx, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
    };
    const log = logger();
    let acquired = false;
    const leases = wrappedStore((real) => ({
      acquire: async (name) => {
        const ok = await real.acquire(name);
        if (ok) acquired = true;
        return ok;
      },
    }));
    const a = runner("holder-a", [job], { leaseTtlMs: 3_000, renewMs: 500, log, leases });
    const b = new JobLeases(db().db, "holder-b", 10_000);
    a.start();
    await waitFor(() => acquired, 10_000, "A to acquire");
    // Lose A's lease through the lease API: a release with interval 0 expires it at once and B takes it over, so A's
    // next renewal (~500 ms, long before its local deadline at ~2500 ms) finds no row of its own.
    expect(await new JobLeases(db().db, "holder-a", 3_000).release("job.lost", 0)).toBe(true);
    expect(await b.acquire("job.lost")).toBe(true);
    await waitFor(() => aborted, 10_000, "A's run to abort");
    expect(log.lines.some((line) => line.startsWith("job lease lost"))).toBe(true);
    expect(log.lines.join("\n")).not.toContain("not renewed in time");
    await a.stop();
    expect(await b.renew("job.lost")).toBe(true);
    expect(await new JobLeases(db().db, "holder-c", 3_000).acquire("job.lost")).toBe(false);
  });

  it("does not re-acquire a job before its aborted run settles (zero-row renewal, no other holder)", async () => {
    // TTL 2 s: the renewal at ~500 ms reports zero rows (the wrapper never touches the table), so the run is aborted
    // while the database lease of holder-a expires at ~2 s. The aborted run settles only 3.5 s after the abort, so a
    // runner that polled again before the run settled would acquire the expired lease at ~2 s.
    let starts = 0;
    let abortedAt = 0;
    let settledAt = 0;
    const startTimes: number[] = [];
    const job: JobDefinition = {
      name: "job.unsettled",
      intervalMs: 1_000,
      run: (_ctx, signal) => {
        starts += 1;
        startTimes.push(Date.now());
        const first = starts === 1;
        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            if (!first) return resolve();
            abortedAt = Date.now();
            setTimeout(() => {
              settledAt = Date.now();
              resolve();
            }, 3_500);
          });
        });
      },
    };
    const log = logger();
    const leases = wrappedStore(() => ({ renew: async () => false }));
    const a = runner("holder-a", [job], { leaseTtlMs: 2_000, renewMs: 500, log, leases });
    a.start();
    await waitFor(() => abortedAt > 0, 10_000, "the zero-row renewal to abort the run");
    expect(log.lines.some((line) => line.startsWith("job lease lost"))).toBe(true);
    // ~2.5 s after the abort: the database lease has expired (>= 1 s ago) but the run is still pending (>= 1 s left).
    await wait(2_500);
    expect(settledAt).toBe(0);
    expect(starts).toBe(1);
    await waitFor(() => starts === 2, 10_000, "the job to start again after the aborted run settled");
    expect(startTimes[1] ?? 0).toBeGreaterThanOrEqual(settledAt);
    await a.stop();
  });

  for (const failure of ["hangs", "fails"] as const) {
    it(`the deadline is armed at acquire: a first renewal that ${failure} aborts the run at sentAt + ttl - renewal, while the lease is still held`, async () => {
      // TTL 4 s, renewal 1.5 s: deadline ~2.5 s after the acquire was sent, 1.5 s before the database expiry.
      const ttl = 4_000;
      const renew = 1_500;
      let acquiredAt = 0;
      const leases = wrappedStore((real) => ({
        acquire: (name) => {
          acquiredAt = Date.now();
          return real.acquire(name);
        },
        renew: () => (failure === "hangs" ? new Promise<boolean>(() => undefined) : Promise.reject(new Error(`connection refused postgres://pine:${SECRET}@db`))),
      }));
      const b = new JobLeases(db().db, "holder-b", ttl);
      let starts = 0;
      let abortedAfter = -1;
      let takenOverAtAbort: Promise<boolean> | null = null;
      let settled = false;
      const job: JobDefinition = {
        name: `job.deadline.${failure}`,
        intervalMs: 1_000,
        run: (_ctx, signal) => {
          starts += 1;
          return new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              abortedAfter = Date.now() - acquiredAt;
              takenOverAtAbort = b.acquire(job.name);
              // Cooperative abort: the run settles a while later; the runner must not start the job again meanwhile.
              setTimeout(() => {
                settled = true;
                resolve();
              }, 1_500);
            });
          });
        },
      };
      const log = logger();
      const a = runner("holder-a", [job], { leaseTtlMs: ttl, renewMs: renew, log, leases });
      a.start();
      await waitFor(() => abortedAfter >= 0, 15_000, "the local deadline to abort the run");
      expect(abortedAfter).toBeGreaterThanOrEqual(ttl - renew - 50);
      expect(abortedAfter).toBeLessThan(ttl + 1_000);
      // The abort happened while the lease was still ours: nobody else could have been running the job.
      expect(await (takenOverAtAbort as Promise<boolean> | null)).toBe(false);
      expect(settled).toBe(false);
      expect(starts).toBe(1);
      const joined = log.lines.join("\n");
      expect(joined).toContain("job lease not renewed in time");
      expect(joined).not.toContain(SECRET);
      await a.stop();
      expect(settled).toBe(true);
      expect(starts).toBe(1);
    });
  }

  it("awaits an in-flight renewal before releasing", async () => {
    const events: string[] = [];
    let renewStarted: () => void = () => undefined;
    const renewing = new Promise<void>((resolve) => (renewStarted = resolve));
    let first = true;
    const leases = wrappedStore((real) => ({
      renew: async (name) => {
        if (!first) return real.renew(name);
        first = false;
        events.push("renew-start");
        renewStarted();
        await wait(800);
        const held = await real.renew(name);
        events.push("renew-end");
        return held;
      },
      release: async (name, intervalMs) => {
        events.push("release");
        return real.release(name, intervalMs);
      },
    }));
    const job: JobDefinition = {
      name: "job.inflight",
      intervalMs: 1_000,
      run: async () => {
        await renewing;
        events.push("run-end");
      },
    };
    const a = runner("holder-a", [job], { leaseTtlMs: 3_000, renewMs: 500, leases });
    a.start();
    await waitFor(() => events.includes("release"), 10_000, "the release");
    await a.stop();
    expect(events.slice(0, 4)).toEqual(["renew-start", "run-end", "renew-end", "release"]);
  });

  it(`waits at most ${RENEWAL_SETTLE_MS} ms for a hung renewal, then releases (and the release still wins)`, async () => {
    let runEndedAt = 0;
    let releasedAt = 0;
    let released: boolean | null = null;
    let renewStarted: () => void = () => undefined;
    const renewing = new Promise<void>((resolve) => (renewStarted = resolve));
    const leases = wrappedStore((real) => ({
      renew: () => {
        renewStarted();
        return new Promise<boolean>(() => undefined);
      },
      release: async (name, intervalMs) => {
        if (releasedAt > 0) return real.release(name, intervalMs);
        releasedAt = Date.now();
        released = await real.release(name, intervalMs);
        return released;
      },
    }));
    const job: JobDefinition = {
      name: "job.hungrenew",
      intervalMs: 1_000,
      run: async () => {
        await renewing;
        if (runEndedAt === 0) runEndedAt = Date.now();
      },
    };
    const a = runner("holder-a", [job], { leaseTtlMs: 3_000, renewMs: 500, leases });
    a.start();
    await waitFor(() => releasedAt > 0, 10_000, "the release");
    await a.stop();
    expect(released).toBe(true);
    expect(releasedAt - runEndedAt).toBeGreaterThanOrEqual(RENEWAL_SETTLE_MS - 100);
    expect(releasedAt - runEndedAt).toBeLessThan(RENEWAL_SETTLE_MS + 2_000);
    // The renewal that never came back cannot extend the released row either (holder renamed on release).
    expect(await new JobLeases(db().db, "holder-a", 3_000).renew("job.hungrenew")).toBe(false);
  });

  it("defaults: renewal every ttl/3 and acquisition polled every min(interval, 15 s)", async () => {
    // TTL 15 s with the default renewal period: the first renewal comes ttl/3 = 5 s after the acquire. The assertion
    // only asks that the observed period is closer to ttl/3 than to ttl/2 (7.5 s): >= 1.25 s of slack under contention,
    // and a timer never fires early (PRD-02 3b).
    let acquiredAt = 0;
    const renewedAt: number[] = [];
    const starts: number[] = [];
    let finish: () => void = () => undefined;
    const leases = wrappedStore((real) => ({
      acquire: async (name) => {
        const ok = await real.acquire(name);
        if (ok && acquiredAt === 0) acquiredAt = Date.now();
        return ok;
      },
      renew: async (name) => {
        renewedAt.push(Date.now());
        return real.renew(name);
      },
    }));
    const slow: JobDefinition = { name: "job.defaults.renew", intervalMs: 1_000, run: () => new Promise<void>((resolve) => (finish = resolve)) };
    const ttl = 15_000;
    const a = runner("holder-a", [slow], { leaseTtlMs: ttl, renewMs: null, leases });
    a.start();
    await waitFor(() => renewedAt.length >= 1, 25_000, "the first renewal");
    finish();
    await a.stop();
    const period = (renewedAt[0] ?? 0) - acquiredAt;
    expect(period).toBeGreaterThanOrEqual(ttl / 3 - 100);
    expect(Math.abs(period - ttl / 3)).toBeLessThan(Math.abs(period - ttl / 2));
    // Default poll period: a 1 s job is retried after ~1 s (min(interval, 15 s)), not after 15 s.
    const quick: JobDefinition = { name: "job.defaults.poll", intervalMs: 1_000, run: async () => void starts.push(Date.now()) };
    const b = runner("holder-b", [quick], { pollMs: null });
    b.start();
    await waitFor(() => starts.length >= 2, 10_000, "the second run with the default poll period");
    await b.stop();
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(900);
  }, 90_000);

  it("refuses a renewal period that would put the local deadline before the next renewal", () => {
    const job: JobDefinition = { name: "job.timing", intervalMs: 1_000, run: async () => undefined };
    expect(() => runner("x", [job], { leaseTtlMs: 2_000, renewMs: 1_000 })).toThrow(/below half the lease TTL/);
  });

  it("the pool connection timeout is below the default renewal period", () => {
    expect(POOL_CONNECTION_TIMEOUT_MS).toBeLessThan(DEFAULT_LEASE_TTL_MS / 3);
  });
});

describe("job runner", () => {
  it("a job never overlaps itself across two processes and runs at most once per interval", async () => {
    let active = 0;
    let maxActive = 0;
    const starts: number[] = [];
    const job: JobDefinition = {
      name: "job.shared",
      intervalMs: 1_000,
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        starts.push(Date.now());
        await wait(300);
        active -= 1;
      },
    };
    const a = runner("holder-a", [job]);
    const b = runner("holder-b", [job]);
    a.start();
    b.start();
    await waitFor(() => starts.length >= 2, 10_000, "a second run");
    const observedFrom = starts[0] ?? 0;
    await wait(Math.max(0, observedFrom + 2_600 - Date.now()));
    await Promise.all([a.stop(), b.stop()]);
    expect(maxActive).toBe(1);
    // Starts are at least one interval apart (database time), so at most 3 fit in the 2.6 s after the first one.
    expect(starts.filter((at) => at <= observedFrom + 2_600).length).toBeLessThanOrEqual(3);
    for (let i = 1; i < starts.length; i += 1) expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(900);
  });

  it("logs failures redacted and retries at the next interval", async () => {
    const runs: number[] = [];
    const log = logger();
    const job: JobDefinition = {
      name: "job.fail",
      intervalMs: 1_000,
      run: async () => {
        runs.push(Date.now());
        throw new Error(`cannot connect postgres://pine:${SECRET}@db/pine`);
      },
    };
    const ok: JobDefinition = { name: "job.ok", intervalMs: 1_000, run: async () => undefined };
    const metrics = new MemoryMetrics();
    const a = runner("holder-a", [job, ok], { log, metrics });
    a.start();
    await waitFor(() => runs.length >= 2, 10_000, "the retry");
    await a.stop();
    expect((runs[1] ?? 0) - (runs[0] ?? 0)).toBeGreaterThanOrEqual(900);
    const joined = log.lines.join("\n");
    expect(joined).toContain("job failed");
    expect(joined).not.toContain(SECRET);
    // Failures are counted per job; successes separately.
    expect(metrics.counters.get(`job_runs${JSON.stringify({ job: "job.fail", result: "error" })}`) ?? 0).toBeGreaterThanOrEqual(2);
    expect(metrics.counters.get(`job_runs${JSON.stringify({ job: "job.ok", result: "ok" })}`) ?? 0).toBeGreaterThanOrEqual(1);
    expect(metrics.counters.get(`job_runs${JSON.stringify({ job: "job.fail", result: "ok" })}`)).toBeUndefined();
  });

  it("defaults: lease TTL 60 s, poll period min(interval, 15 s), and a random holder id per runner", async () => {
    let finish: () => void = () => undefined;
    const job: JobDefinition = { name: "job.defaults.ttl", intervalMs: 60_000, run: () => new Promise<void>((resolve) => (finish = resolve)) };
    const a = runner(null, [job], { leaseTtlMs: null, renewMs: null, pollMs: null });
    expect(a.timing).toEqual({ ttlMs: 60_000, renewMs: 20_000, pollMs: 15_000 });
    expect(a.pollPeriod({ intervalMs: 60_000 })).toBe(15_000);
    expect(a.pollPeriod({ intervalMs: 1_000 })).toBe(1_000);
    a.start();
    let rows: { holder: string; ttl_ms: number }[] = [];
    const deadline = Date.now() + 10_000;
    while (rows.length === 0) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the default lease");
      // Read-only: tests never write job_leases.
      rows = await db().sql.query<{ holder: string; ttl_ms: number }>(
        "SELECT holder, (extract(epoch FROM (expires_at - started_at)) * 1000)::int AS ttl_ms FROM job_leases WHERE name = 'job.defaults.ttl'",
      );
      if (rows.length === 0) await wait(25);
    }
    finish();
    await a.stop();
    expect(rows[0]?.ttl_ms).toBe(60_000);
    expect(rows[0]?.holder).toBe(a.leases.holderId);
    const b = runner(null, [job], { leaseTtlMs: null, renewMs: null, pollMs: null });
    expect(b.leases.holderId).not.toBe(a.leases.holderId);
    expect(a.leases.holderId).toMatch(new RegExp(`^${process.pid}-[0-9a-f-]{36}$`));
  });

  it("stop() aborts a running job", async () => {
    let signalSeen: AbortSignal | null = null;
    const job: JobDefinition = {
      name: "job.stop",
      intervalMs: 1_000,
      run: (_ctx, signal) =>
        new Promise<void>((resolve) => {
          signalSeen = signal;
          signal.addEventListener("abort", () => resolve());
        }),
    };
    const a = runner("holder-a", [job]);
    a.start();
    await waitFor(() => signalSeen !== null, 10_000, "the job to start");
    await a.stop();
    expect((signalSeen as AbortSignal | null)?.aborted).toBe(true);
  });

  it("refuses duplicate job names", () => {
    const job: JobDefinition = { name: "dup", intervalMs: 1_000, run: async () => undefined };
    expect(() => runner("x", [job, job])).toThrow(/Duplicate job name/);
  });
});
