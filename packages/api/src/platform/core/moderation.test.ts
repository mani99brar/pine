// Must stay the first import: blocks this file until no other PGlite-backed core test file runs.
import "./testing/suite-lock.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bodylessCsrfHeaders, createHarness, csrfHeaders, signIn, testAccount, useSharedDatabase, type CoreHarness, type SignedIn } from "./testing/harness.js";

const db = useSharedDatabase({ beforeAll, afterAll, beforeEach });
let h: CoreHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const admin = testAccount(0xad);
const user = testAccount(0x05e7);
const CONTENT = `0x${"Ab".repeat(32)}`;

async function setup(): Promise<{ hh: CoreHarness; adminSession: SignedIn; userSession: SignedIn }> {
  const hh = await createHarness({ database: db(), settings: { adminWallets: new Set([admin.address.toLowerCase()]) } });
  h = hh;
  return { hh, adminSession: await signIn(hh, admin), userSession: await signIn(hh, user) };
}

const post = (hh: CoreHarness, cookie: string, payload: unknown) => hh.app.inject({ method: "POST", url: "/api/v1/admin/moderation", headers: csrfHeaders({ cookie }), payload: payload as Record<string, unknown> });

describe("moderation admin routes (SEC-OPS-06)", () => {
  it("blocks content, exposes the state case-insensitively and audits the change", async () => {
    const { hh, adminSession } = await setup();
    const res = await post(hh, adminSession.cookie, { subject: "content", id: CONTENT, action: "block", reason: "malware" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ subject: "content", id: CONTENT.toLowerCase(), action: "block", reason: "malware", actorUserId: adminSession.userId });
    const states = await hh.ctx.moderation.states("content", [CONTENT.toUpperCase().replace("0X", "0x")]);
    expect([...states.values()]).toMatchObject([{ action: "block", reason: "malware" }]);
    const audit = await hh.database.sql.query<{ action: string; actor: string; subject_id: string }>(
      "SELECT action, actor_user_id::text AS actor, subject_id FROM audit_log WHERE action LIKE 'moderation.%'",
    );
    expect(audit).toEqual([{ action: "moderation.blocked", actor: adminSession.userId, subject_id: CONTENT.toLowerCase() }]);
  });

  it("lists and removes states; every change is audited with the previous state", async () => {
    const { hh, adminSession } = await setup();
    await post(hh, adminSession.cookie, { subject: "claim", id: "0x00000000000000000000000000000000000c1a10", action: "hide", reason: "spam" });
    await post(hh, adminSession.cookie, { subject: "claim", id: "0x00000000000000000000000000000000000c1a10", action: "block", reason: "abuse" });
    const list = await hh.app.inject({ method: "GET", url: "/api/v1/admin/moderation?subject=claim", headers: { cookie: adminSession.cookie } });
    expect(list.json().items).toMatchObject([{ subject: "claim", action: "block", reason: "abuse" }]);
    const removed = await hh.app.inject({
      method: "DELETE",
      url: "/api/v1/admin/moderation",
      headers: csrfHeaders({ cookie: adminSession.cookie }),
      payload: { subject: "claim", id: "0x00000000000000000000000000000000000C1A10", reason: "appeal granted" },
    });
    expect(removed.statusCode).toBe(204);
    expect((await hh.ctx.moderation.states("claim", ["0x00000000000000000000000000000000000c1a10"])).size).toBe(0);
    const audit = await hh.database.sql.query<{ action: string; details: { previous: unknown } }>("SELECT action, details FROM audit_log WHERE action LIKE 'moderation.%' ORDER BY id");
    expect(audit.map((row) => row.action)).toEqual(["moderation.hidden", "moderation.blocked", "moderation.removed"]);
    expect(audit[1]?.details.previous).toEqual({ action: "hide", reason: "spam" });
    const again = await hh.app.inject({ method: "DELETE", url: "/api/v1/admin/moderation", headers: csrfHeaders({ cookie: adminSession.cookie }), payload: { subject: "claim", id: "0x00000000000000000000000000000000000c1a10", reason: "x" } });
    expect(again.statusCode).toBe(404);
  });

  it("SEC-AUTH-21 non-admins get 403, unauthenticated 401, stale admins STEP_UP_REQUIRED, and nothing changes", async () => {
    const { hh, adminSession, userSession } = await setup();
    const payload = { subject: "content", id: CONTENT, action: "block", reason: "x" };
    expect((await post(hh, userSession.cookie, payload)).json().error.code).toBe("FORBIDDEN");
    expect((await hh.app.inject({ method: "POST", url: "/api/v1/admin/moderation", headers: csrfHeaders(), payload })).json().error.code).toBe("UNAUTHENTICATED");
    hh.clock.advance(301_000);
    expect((await post(hh, adminSession.cookie, payload)).json().error.code).toBe("STEP_UP_REQUIRED");
    expect((await hh.app.inject({ method: "GET", url: "/api/v1/admin/moderation", headers: { cookie: adminSession.cookie } })).json().error.code).toBe("STEP_UP_REQUIRED");
    expect(await hh.database.sql.query("SELECT * FROM moderation_states")).toEqual([]);
  });

  it("SEC-AUTH-21 unblocking (DELETE) needs an admin with a fresh signature; refused attempts change nothing", async () => {
    const { hh, adminSession, userSession } = await setup();
    expect((await post(hh, adminSession.cookie, { subject: "content", id: CONTENT, action: "block", reason: "malware" })).statusCode).toBe(200);
    const remove = (headers: Record<string, string>) =>
      hh.app.inject({ method: "DELETE", url: "/api/v1/admin/moderation", headers: csrfHeaders(headers), payload: { subject: "content", id: CONTENT, reason: "unblock" } });
    const stillBlocked = async () => {
      expect([...(await hh.ctx.moderation.states("content", [CONTENT])).values()]).toMatchObject([{ action: "block", reason: "malware" }]);
      expect(await hh.database.sql.query("SELECT id FROM audit_log WHERE action = 'moderation.removed'")).toEqual([]);
    };
    const asUser = await remove({ cookie: userSession.cookie });
    expect([asUser.statusCode, asUser.json().error.code]).toEqual([403, "FORBIDDEN"]);
    await stillBlocked();
    const anonymous = await remove({});
    expect([anonymous.statusCode, anonymous.json().error.code]).toEqual([401, "UNAUTHENTICATED"]);
    await stillBlocked();
    const listAsUser = await hh.app.inject({ method: "GET", url: "/api/v1/admin/moderation", headers: { cookie: userSession.cookie } });
    expect(listAsUser.json().error.code).toBe("FORBIDDEN");
    hh.clock.advance(301_000);
    const stale = await remove({ cookie: adminSession.cookie });
    expect([stale.statusCode, stale.json().error.code]).toEqual([401, "STEP_UP_REQUIRED"]);
    await stillBlocked();
  });

  it("SEC-OPS-06 validates subject ids and reasons; only hide or block exist", async () => {
    const { hh, adminSession } = await setup();
    expect((await post(hh, adminSession.cookie, { subject: "content", id: "not-a-digest", action: "block", reason: "x" })).statusCode).toBe(400);
    expect((await post(hh, adminSession.cookie, { subject: "content", id: CONTENT, action: "edit", reason: "x" })).statusCode).toBe(400);
    expect((await post(hh, adminSession.cookie, { subject: "content", id: CONTENT, action: "block", reason: "" })).statusCode).toBe(400);
    expect((await post(hh, adminSession.cookie, { subject: "evidence", id: "0x00000000000000000000000000000000000e01de:12", action: "hide", reason: "dup" })).statusCode).toBe(200);
    expect((await post(hh, adminSession.cookie, { subject: "repository", id: "123456", action: "hide", reason: "dup" })).statusCode).toBe(200);
  });

  describe("SEC-OPS-07 a moderation change and its audit entry commit together", () => {
    // A superuser trigger makes the audit insert of moderation actions fail; nothing else touches the tables.
    const failAudit = async (hh: CoreHarness) =>
      hh.database.sql.exec(`
        CREATE OR REPLACE FUNCTION test_fail_moderation_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'audit insert refused for the test'; END $$;
        CREATE TRIGGER test_fail_moderation_audit BEFORE INSERT ON audit_log FOR EACH ROW
          WHEN (NEW.action LIKE 'moderation.%') EXECUTE FUNCTION test_fail_moderation_audit();`);
    const restoreAudit = async (hh: CoreHarness) =>
      hh.database.sql.exec("DROP TRIGGER IF EXISTS test_fail_moderation_audit ON audit_log; DROP FUNCTION IF EXISTS test_fail_moderation_audit()");

    it("a failing audit insert rolls the new state back (POST)", async () => {
      const { hh, adminSession } = await setup();
      await failAudit(hh);
      try {
        const res = await post(hh, adminSession.cookie, { subject: "content", id: CONTENT, action: "block", reason: "malware" });
        expect(res.statusCode).toBe(500);
        expect(await hh.database.sql.query("SELECT * FROM moderation_states")).toEqual([]);
      } finally {
        await restoreAudit(hh);
      }
    });

    it("a failing audit insert rolls the update of an existing state back (POST)", async () => {
      const { hh, adminSession } = await setup();
      expect((await post(hh, adminSession.cookie, { subject: "content", id: CONTENT, action: "hide", reason: "spam" })).statusCode).toBe(200);
      await failAudit(hh);
      try {
        expect((await post(hh, adminSession.cookie, { subject: "content", id: CONTENT, action: "block", reason: "malware" })).statusCode).toBe(500);
        expect(await hh.database.sql.query("SELECT action, reason FROM moderation_states")).toEqual([{ action: "hide", reason: "spam" }]);
      } finally {
        await restoreAudit(hh);
      }
    });

    it("a failing audit insert keeps the removed state (DELETE)", async () => {
      const { hh, adminSession } = await setup();
      expect((await post(hh, adminSession.cookie, { subject: "content", id: CONTENT, action: "block", reason: "malware" })).statusCode).toBe(200);
      await failAudit(hh);
      try {
        const res = await hh.app.inject({ method: "DELETE", url: "/api/v1/admin/moderation", headers: csrfHeaders({ cookie: adminSession.cookie }), payload: { subject: "content", id: CONTENT, reason: "appeal" } });
        expect(res.statusCode).toBe(500);
        expect(await hh.database.sql.query("SELECT action FROM moderation_states")).toEqual([{ action: "block" }]);
        expect((await hh.ctx.moderation.states("content", [CONTENT])).size).toBe(1);
      } finally {
        await restoreAudit(hh);
      }
    });
  });

  it("SEC-AUTH-14 moderation changes require CSRF headers", async () => {
    const { hh, adminSession } = await setup();
    const res = await hh.app.inject({ method: "POST", url: "/api/v1/admin/moderation", headers: { cookie: adminSession.cookie, "content-type": "application/json" }, payload: { subject: "content", id: CONTENT, action: "block", reason: "x" } });
    expect(res.json().error.code).toBe("CSRF_REJECTED");
    void bodylessCsrfHeaders;
  });
});
