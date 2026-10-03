// Must stay the first import: blocks this file until no other PGlite-backed core test file runs.
import "./testing/suite-lock.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMigrations, MigrationError, verifyMigrations } from "../../contracts/migrations.js";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../contracts/app.js";
import { MIGRATIONS_RECHECK_MS, READINESS_CACHE_MS, ReadinessProbe } from "./health.js";
import { createHarness, signIn, testAccount, useSharedDatabase, type CoreHarness } from "./testing/harness.js";

const db = useSharedDatabase({ beforeAll, afterAll, beforeEach });
let h: CoreHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("/healthz and /readyz", () => {
  it("healthz answers ok publicly", async () => {
    h = await createHarness({ database: db() });
    const res = await h.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("readyz is ready with a reachable database, verified migrations and a fresh read model", async () => {
    h = await createHarness({ database: db() });
    const res = await h.app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", checks: { database: "ok", migrations: "ok", readModel: "ok" } });
  });

  it("readyz is 503 when the read model is stale beyond maxIndexerLagSeconds", async () => {
    h = await createHarness({ database: db() });
    h.clock.advance(900_000);
    expect((await h.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    // The next computation happens once the 5 s cache has aged out (lag 905 s > 900 s).
    h.clock.advance(READINESS_CACHE_MS);
    const res = await h.app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.readModel).toBe("stale");
  });

  it("readyz is not ready when the database is unreachable; the reason is logged redacted and never returned", async () => {
    h = await createHarness({ database: db() });
    const failing = { execute: async () => Promise.reject(new Error("connect ECONNREFUSED postgres://pine:pw-leak-2@db.internal/pine")) } as unknown as Database;
    let migrationsChecked = 0;
    const probe = new ReadinessProbe({ ...h.ctx, db: failing }, { verifyMigrations: async () => void (migrationsChecked += 1) });
    const lines: string[] = [];
    const log = { warn: (fields: unknown, message: string) => void lines.push(`${message} ${JSON.stringify(fields)}`) } as unknown as FastifyBaseLogger;
    const result = await probe.check(log);
    expect(result.ready).toBe(false);
    expect(result.body).toEqual({ status: "not_ready", checks: { database: "failed", migrations: "failed", readModel: "ok" } });
    expect(migrationsChecked).toBe(0);
    expect(lines.join("\n")).toContain("database unreachable");
    expect(JSON.stringify(result.body) + lines.join("\n")).not.toContain("pw-leak-2");
  });

  it("readyz is 503 with readModel failed when the read model status throws", async () => {
    h = await createHarness({ database: db() });
    vi.spyOn(h.readModel, "status").mockRejectedValue(new Error("GraphQL https://envio.internal/v1/graphql-key-leak-3 timeout"));
    const res = await h.app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "not_ready", checks: { database: "ok", migrations: "ok", readModel: "failed" } });
    expect(res.body + h.logs.join("\n")).not.toContain("graphql-key-leak-3");
  });

  it("readyz is 503 when the read model is halted", async () => {
    h = await createHarness({ database: db() });
    h.readModel.setHalted(true);
    const res = await h.app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.readModel).toBe("halted");
  });

  it("readyz is 503 when migrations are not verified, without leaking the reason", async () => {
    h = await createHarness({
      database: db(),
      readiness: {
        verifyMigrations: async () => {
          throw new MigrationError("Pending migrations: platform/0003_x.sql postgres://u:pw-leak-1@db/x");
        },
      },
    });
    const res = await h.app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.migrations).toBe("failed");
    expect(res.body).not.toContain("pw-leak-1");
    expect(h.logs.join("\n")).not.toContain("pw-leak-1");
  });

  it("probes ignore cookies (public routes)", async () => {
    h = await createHarness({ database: db() });
    const user = await signIn(h, testAccount(3));
    h.githubAuth.calls.length = 0;
    await h.app.inject({ method: "GET", url: "/readyz", headers: { cookie: user.cookie } });
    expect(h.githubAuth.calls).toEqual([]);
  });

  it("serves /readyz from a 5 s single-flight cache instead of probing on every request", async () => {
    h = await createHarness({ database: db() });
    const status = vi.spyOn(h.readModel, "status");
    const first = await Promise.all([1, 2, 3].map(() => h!.app.inject({ method: "GET", url: "/readyz" })));
    expect(first.map((res) => res.statusCode)).toEqual([200, 200, 200]);
    expect(status).toHaveBeenCalledTimes(1);
    h.readModel.setHalted(true);
    h.clock.advance(READINESS_CACHE_MS - 1);
    expect((await h.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    expect(status).toHaveBeenCalledTimes(1);
    h.clock.advance(1);
    const res = await h.app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.readModel).toBe("halted");
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("re-verifies migrations at most every 60 s and trusts a startup verification", async () => {
    const files = await loadMigrations();
    let verifications = 0;
    const database = db();
    h = await createHarness({
      database,
      readiness: {
        verifiedAtStartup: true,
        verifyMigrations: async () => {
          verifications += 1;
          await verifyMigrations(database.sql, files);
        },
      },
    });
    expect((await h.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    expect(verifications).toBe(0);
    for (let elapsed = READINESS_CACHE_MS; elapsed < MIGRATIONS_RECHECK_MS; elapsed += READINESS_CACHE_MS) {
      h.clock.advance(READINESS_CACHE_MS);
      await h.app.inject({ method: "GET", url: "/readyz" });
    }
    expect(verifications).toBe(0);
    h.clock.advance(READINESS_CACHE_MS);
    expect((await h.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    expect(verifications).toBe(1);
  });
});
