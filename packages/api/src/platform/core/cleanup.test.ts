// Must stay the first import: blocks this file until no other PGlite-backed core test file runs.
import "./testing/suite-lock.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLEANUP_BATCH, cleanupJob, runCleanup } from "./cleanup.js";
import { consumeRateLimits } from "./limits.js";
import { createHarness, csrfHeaders, signIn, testAccount, useSharedDatabase, type CoreHarness } from "./testing/harness.js";

const db = useSharedDatabase({ beforeAll, afterAll, beforeEach });
let h: CoreHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function count(hh: CoreHarness, table: string): Promise<number> {
  const rows = await hh.database.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]?.n ?? 0;
}

describe("cleanup job", () => {
  it("purges expired nonces, pre-sessions, sessions, old rate-limit windows and old audit IPs; keeps live rows", async () => {
    const hh = await createHarness({ database: db() });
    h = hh;
    const expiredUser = await signIn(hh, testAccount(1));
    await hh.app.inject({ method: "POST", url: "/api/v1/auth/siwe/challenge", headers: csrfHeaders(), payload: { address: testAccount(2).address } });
    await consumeRateLimits(hh.database.db, hh.clock.now(), [{ key: "user:old", limit: 10 }]);
    await hh.database.sql.exec(`INSERT INTO audit_log (action, subject_type, subject_id, ip, created_at) VALUES ('old', 'x', '1', '198.51.100.1', now() - interval '40 days')`);
    const oldWindows = await count(hh, "rate_limit_windows");
    hh.clock.advance(25 * 3_600_000);
    const liveUser = await signIn(hh, testAccount(3));
    await hh.app.inject({ method: "POST", url: "/api/v1/auth/siwe/challenge", headers: csrfHeaders(), payload: { address: testAccount(4).address } });

    expect(await count(hh, "siwe_nonces")).toBe(2);
    expect(await count(hh, "sessions")).toBe(2);
    const newWindows = (await count(hh, "rate_limit_windows")) - oldWindows;
    const result = await runCleanup(hh.ctx, new AbortController().signal);
    expect(result).toMatchObject({ nonces: 1, presessions: 1, sessions: 1, rateLimitWindows: oldWindows, auditIps: 1 });
    expect(await count(hh, "rate_limit_windows")).toBe(newWindows);
    expect(await count(hh, "siwe_nonces")).toBe(1);
    expect(await count(hh, "siwe_presessions")).toBe(1);
    expect(await count(hh, "sessions")).toBe(1);
    expect((await hh.app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: liveUser.cookie } })).statusCode).toBe(200);
    expect((await hh.app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: expiredUser.cookie } })).statusCode).toBe(401);
    expect(await hh.database.sql.query("SELECT ip FROM audit_log WHERE action = 'old'")).toEqual([{ ip: null }]);
    const again = await runCleanup(hh.ctx, new AbortController().signal);
    expect(Object.values(again).every((value) => value === 0)).toBe(true);
  });

  it("checks its AbortSignal between batches: an aborted run deletes nothing", async () => {
    const hh = await createHarness({ database: db() });
    h = hh;
    await consumeRateLimits(hh.database.db, hh.clock.now(), [{ key: "user:old", limit: 10 }]);
    hh.clock.advance(2 * 3_600_000);
    const aborted = new AbortController();
    aborted.abort();
    const result = await runCleanup(hh.ctx, aborted.signal);
    expect(Object.values(result).every((value) => value === 0)).toBe(true);
    expect(await count(hh, "rate_limit_windows")).toBe(1);
  });

  it("runs as a JobDefinition: purges expired rows, nulls old audit IPs and counts tables with deletions", async () => {
    const hh = await createHarness({ database: db() });
    h = hh;
    await signIn(hh, testAccount(1));
    await hh.database.sql.exec(`INSERT INTO audit_log (action, subject_type, subject_id, ip, created_at) VALUES ('old', 'x', '1', '198.51.100.1', now() - interval '40 days')`);
    hh.clock.advance(8 * 24 * 3_600_000);
    expect(await count(hh, "sessions")).toBe(1);
    await cleanupJob.run(hh.ctx, new AbortController().signal);
    expect(cleanupJob.name).toBe("platform.cleanup");
    expect(await count(hh, "sessions")).toBe(0);
    expect(await hh.database.sql.query("SELECT ip FROM audit_log WHERE action = 'old'")).toEqual([{ ip: null }]);
    expect(hh.metrics.counters.get(`cleanup_runs_with_deletions${JSON.stringify({ table: "sessions" })}`)).toBe(1);
    expect(hh.metrics.counters.get(`cleanup_runs_with_deletions${JSON.stringify({ table: "auditIps" })}`)).toBe(1);
  });

  it("purges in bounded batches of at most 1000 rows per statement", async () => {
    const hh = await createHarness({ database: db() });
    h = hh;
    const keys = Array.from({ length: 2_500 }, (_, i) => ({ key: `user:bulk-${i}`, limit: 10 }));
    await consumeRateLimits(hh.database.db, hh.clock.now(), keys);
    hh.clock.advance(2 * 3_600_000);
    const counts: number[] = [];
    const real = hh.ctx.db;
    const spied = {
      ...real,
      execute: async (query: Parameters<typeof real.execute>[0]) => {
        const result = await real.execute(query);
        const rows = (result as unknown as { rows?: { n?: unknown }[] }).rows ?? [];
        counts.push(Number(rows[0]?.n ?? 0));
        return result;
      },
    } as typeof real;
    const result = await runCleanup({ ...hh.ctx, db: spied }, new AbortController().signal);
    expect(result.rateLimitWindows).toBe(2_500);
    expect(await count(hh, "rate_limit_windows")).toBe(0);
    expect(Math.max(...counts)).toBeLessThanOrEqual(CLEANUP_BATCH);
    // nonces, pre-sessions, sessions: one empty batch each; rate-limit windows: 1000 + 1000 + 500; quotas; audit IPs.
    expect(counts).toEqual([0, 0, 0, 1_000, 1_000, 500, 0, 0]);
  });
});
