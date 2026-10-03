// Must stay the first import: blocks this file until no other PGlite-backed core test file runs.
import "./testing/suite-lock.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations, verifyMigrations } from "../../contracts/migrations.js";
import { createRedactor } from "../../contracts/redact.js";
import { AUDIT_DETAILS_MAX_BYTES, PostgresAuditLog } from "./audit.js";
import { readFileSync } from "node:fs";
import { JobLeases } from "./jobs.js";
import { PostgresQuotas } from "./limits.js";
import { createHarness, csrfHeaders, signIn, testAccount, testSettings, useSharedDatabase, type CoreHarness } from "./testing/harness.js";

const db = useSharedDatabase({ beforeAll, afterAll, beforeEach });

const SECRET = "the-database-password-xyz";
const SESSION_TOKEN = `pine_s1_${"Q".repeat(43)}`;
const GH_TOKEN = `ghu_${"a".repeat(36)}`;

async function asApi<T>(fn: () => Promise<T>): Promise<T> {
  await db().sql.exec("SET ROLE pine_api");
  try {
    return await fn();
  } finally {
    await db().sql.exec("RESET ROLE");
  }
}

async function permissionError(sql: string): Promise<string | undefined> {
  return asApi(async () => {
    try {
      await db().sql.exec(sql);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  });
}

describe("audit log (SEC-OPS-07)", () => {
  it("SEC-OPS-07 redacts every string in details recursively, including keys, and stores database time", async () => {
    const audit = new PostgresAuditLog(db().db, createRedactor([SECRET]));
    await audit.record({
      actorUserId: null,
      action: "test.event",
      subjectType: "user",
      subjectId: `subject ${SESSION_TOKEN}`,
      details: { nested: { list: [`password=${SECRET}`, GH_TOKEN], url: `postgres://pine:${SECRET}@db/pine` }, [SESSION_TOKEN]: 1, amount: 10n },
      ip: "203.0.113.9",
    });
    const rows = await db().sql.query<{ details: Record<string, unknown>; subject_id: string; ip: string; created_at: Date }>("SELECT details, subject_id, ip, created_at FROM audit_log");
    const text = JSON.stringify(rows);
    for (const secret of [SECRET, SESSION_TOKEN, GH_TOKEN]) expect(text).not.toContain(secret);
    expect(rows[0]?.ip).toBe("203.0.113.9");
    expect(rows[0]?.details).toMatchObject({ amount: "10" });
    expect(rows[0]?.created_at).toBeInstanceOf(Date);
  });

  it("created_at is database now(), never the application clock", async () => {
    const harness = await createHarness({ database: db() });
    try {
      // The harness FakeClock is fixed at 2026-10-01T00:00:00Z, far from the database clock.
      await harness.ctx.audit.record({ actorUserId: null, action: "test.time", subjectType: "x", subjectId: "y", details: {}, ip: null });
      const rows = await db().sql.query<{ created_at: Date; db_now: Date }>("SELECT created_at, now() AS db_now FROM audit_log WHERE action = 'test.time'");
      const createdAt = new Date(rows[0]?.created_at ?? 0).getTime();
      expect(Math.abs(new Date(rows[0]?.db_now ?? 0).getTime() - createdAt)).toBeLessThan(10_000);
      expect(createdAt).not.toBe(harness.clock.now().getTime());
      expect(Math.abs(createdAt - harness.clock.now().getTime())).toBeGreaterThan(60_000);
    } finally {
      await harness.close();
    }
  });

  it("caps details at 8 KiB", async () => {
    const audit = new PostgresAuditLog(db().db, createRedactor());
    await audit.record({ actorUserId: null, action: "test.big", subjectType: "x", subjectId: "y", details: { items: Array.from({ length: 50 }, () => "z".repeat(1_000)) }, ip: null });
    const rows = await db().sql.query<{ size: number; details: { truncated?: boolean } }>("SELECT octet_length(details::text)::int AS size, details FROM audit_log");
    expect(rows[0]?.details.truncated).toBe(true);
    expect(rows[0]?.size).toBeLessThanOrEqual(AUDIT_DETAILS_MAX_BYTES);
  });

  it("SEC-OPS-07 as pine_api: INSERT works, UPDATE/DELETE/TRUNCATE fail with a permission error", async () => {
    const audit = new PostgresAuditLog(db().db, createRedactor());
    await asApi(() => audit.record({ actorUserId: null, action: "test.api", subjectType: "x", subjectId: "y", details: {}, ip: "198.51.100.1" }));
    expect(await db().sql.query("SELECT action FROM audit_log")).toEqual([{ action: "test.api" }]);
    expect(await permissionError("UPDATE audit_log SET action = 'forged'")).toBe("42501");
    expect(await permissionError("DELETE FROM audit_log")).toBe("42501");
    expect(await permissionError("TRUNCATE audit_log")).toBe("42501");
    expect(await db().sql.query("SELECT action FROM audit_log")).toEqual([{ action: "test.api" }]);
  });

  it("SEC-OPS-07 the retention function nulls IPs older than 30 days only, callable by pine_api", async () => {
    await db().sql.exec(`
      INSERT INTO audit_log (action, subject_type, subject_id, ip, created_at) VALUES
        ('old', 'x', '1', '198.51.100.1', now() - interval '31 days'),
        ('recent', 'x', '2', '198.51.100.2', now() - interval '29 days')`);
    const result = await asApi(() => db().sql.query<{ n: number }>("SELECT pine_audit_expire_ips(1000) AS n"));
    expect(result[0]?.n).toBe(1);
    expect(await db().sql.query("SELECT action, ip FROM audit_log ORDER BY action")).toEqual([
      { action: "old", ip: null },
      { action: "recent", ip: "198.51.100.2" },
    ]);
  });
});

describe("grants (SEC-OPS-10, PRD-02 2.5a)", () => {
  it("SEC-OPS-10 pine_api can verify migrations but cannot alter the ledger or create tables", async () => {
    const files = await loadMigrations();
    await asApi(() => verifyMigrations(db().sql, files));
    expect(await permissionError("UPDATE schema_migrations SET checksum = 'x'")).toBe("42501");
    expect(await permissionError("DELETE FROM schema_migrations")).toBe("42501");
    expect(await permissionError("INSERT INTO schema_migrations (id, checksum) VALUES ('x', 'y')")).toBe("42501");
    expect(await permissionError("CREATE TABLE pine_api_owned (id int)")).toBe("42501");
  });

  it("the whole sign-in flow works as pine_api (DML grants on platform tables)", async () => {
    let harness: CoreHarness | undefined;
    try {
      harness = await createHarness({ database: db() });
      await db().sql.exec("SET ROLE pine_api");
      const user = await signIn(harness, testAccount(5));
      const res = await harness.app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: user.cookie } });
      expect(res.statusCode).toBe(200);
      const role = await db().sql.query<{ current_user: string }>("SELECT current_user");
      expect(role[0]?.current_user).toBe("pine_api");
    } finally {
      await db().sql.exec("RESET ROLE");
      await harness?.close();
    }
  });

  it("default privileges cover a later migration group's table and its identity sequence (no pine_api mention needed)", async () => {
    // Created by the migrator role, as a later group's migration would be; it never mentions pine_api.
    await db().sql.exec("CREATE TABLE later_group_items (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text NOT NULL)");
    try {
      await asApi(async () => {
        await db().sql.exec("INSERT INTO later_group_items (label) VALUES ('a')");
        await db().sql.exec("UPDATE later_group_items SET label = 'b'");
        expect(await db().sql.query("SELECT label FROM later_group_items")).toEqual([{ label: "b" }]);
        await db().sql.exec("DELETE FROM later_group_items");
      });
      expect(await permissionError("DROP TABLE later_group_items")).toBe("42501");
    } finally {
      await db().sql.exec("DROP TABLE IF EXISTS later_group_items");
    }
  });

  it("quotas, moderation and job leases work as pine_api (grants by table name)", async () => {
    const admin = testAccount(6);
    let harness: CoreHarness | undefined;
    try {
      harness = await createHarness({ database: db(), settings: { adminWallets: new Set([admin.address.toLowerCase()]) } });
      await db().sql.exec("SET ROLE pine_api");
      const user = await signIn(harness, admin);
      await new PostgresQuotas(db().db, harness.clock, testSettings().quotas).consume(user.userId, "plans_per_day");
      const id = `0x${"ef".repeat(32)}`;
      const created = await harness.app.inject({ method: "POST", url: "/api/v1/admin/moderation", headers: csrfHeaders({ cookie: user.cookie }), payload: { subject: "content", id, action: "block", reason: "x" } });
      expect(created.statusCode).toBe(200);
      const removed = await harness.app.inject({ method: "DELETE", url: "/api/v1/admin/moderation", headers: csrfHeaders({ cookie: user.cookie }), payload: { subject: "content", id, reason: "y" } });
      expect(removed.statusCode).toBe(204);
      const leases = new JobLeases(db().db, "holder-api", 60_000);
      expect(await leases.acquire("job.grants")).toBe(true);
      expect(await leases.renew("job.grants")).toBe(true);
      expect(await leases.release("job.grants", 1_000)).toBe(true);
      const role = await db().sql.query<{ current_user: string }>("SELECT current_user");
      expect(role[0]?.current_user).toBe("pine_api");
    } finally {
      await db().sql.exec("RESET ROLE");
      await harness?.close();
    }
  });

  it("0002 grants tables by name, never ON ALL TABLES", () => {
    const sql = readFileSync(new URL("../../../migrations/platform/0002_platform_core.sql", import.meta.url), "utf8")
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    expect(sql).not.toMatch(/ON\s+ALL\s+TABLES/i);
    expect(sql).toMatch(/GRANT SELECT ON schema_migrations TO pine_api;/);
  });

  it("the retention function is not executable by PUBLIC", async () => {
    const rows = await db().sql.query<{ granted: boolean }>("SELECT has_function_privilege('public', 'pine_audit_expire_ips(integer)', 'EXECUTE') AS granted");
    expect(rows[0]?.granted).toBe(false);
  });
});

afterEach(async () => {
  await db().sql.exec("RESET ROLE");
});
