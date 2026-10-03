// Must stay the first import: serializes the memory-heavy claims test files (see test/lock.ts).
import "./test/lock.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeQuotas } from "../../contracts/testing.js";
import { createDraft, draftBody, useHarness } from "./test/helpers.js";

const harnessOf = useHarness();

describe("drafts", () => {
  it("creates, reads, lists, updates (revision) and deletes the owner's drafts", async () => {
    const h = harnessOf();
    const created = await h.app.inject({ method: "POST", url: "/api/v1/drafts", headers: h.headers, payload: draftBody() });
    expect(created.statusCode).toBe(201);
    const draft = (created.json() as { draft: { id: string; revision: number; input: { baseCommit: unknown; evidenceWindowSeconds: number } } }).draft;
    expect(draft.revision).toBe(1);
    expect(draft.input.baseCommit).toBeNull();
    expect(h.ctx.audit.entries.map((entry) => entry.action)).toContain("claim.draft.created");

    const read = await h.app.inject({ method: "GET", url: `/api/v1/drafts/${draft.id}`, headers: h.headers });
    expect(read.statusCode).toBe(200);
    const list = await h.app.inject({ method: "GET", url: "/api/v1/drafts", headers: h.headers });
    expect((list.json() as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([draft.id]);

    const updated = await h.app.inject({ method: "PUT", url: `/api/v1/drafts/${draft.id}`, headers: h.headers, payload: { input: draftBody({ title: "A different title" }) } });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { draft: { revision: number } }).draft.revision).toBe(2);
    const stale = await h.app.inject({ method: "PUT", url: `/api/v1/drafts/${draft.id}`, headers: h.headers, payload: { input: draftBody(), expectedRevision: 1 } });
    expect(stale.statusCode).toBe(409);

    const deleted = await h.app.inject({ method: "DELETE", url: `/api/v1/drafts/${draft.id}`, headers: h.headers });
    expect(deleted.statusCode).toBe(204);
    expect((await h.app.inject({ method: "GET", url: `/api/v1/drafts/${draft.id}`, headers: h.headers })).statusCode).toBe(404);
  });

  it("requires a session", async () => {
    const h = harnessOf();
    expect((await h.app.inject({ method: "POST", url: "/api/v1/drafts", payload: draftBody() })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/drafts" })).statusCode).toBe(401);
  });

  it("another user's draft id is NOT_FOUND for read, update, delete and preview (IDOR)", async () => {
    const h = harnessOf();
    const draft = await createDraft(h);
    const mallory = await h.user();
    const read = await h.app.inject({ method: "GET", url: `/api/v1/drafts/${draft.id}`, headers: mallory.headers });
    const missing = await h.app.inject({ method: "GET", url: "/api/v1/drafts/00000000-0000-4000-8000-00000000ffff", headers: mallory.headers });
    expect(read.statusCode).toBe(404);
    // No existence oracle: the same response as for an id that does not exist.
    expect(read.json().error.code).toBe(missing.json().error.code);
    expect(read.json().error.message).toBe(missing.json().error.message);
    expect((await h.app.inject({ method: "PUT", url: `/api/v1/drafts/${draft.id}`, headers: mallory.headers, payload: { input: draftBody() } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "DELETE", url: `/api/v1/drafts/${draft.id}`, headers: mallory.headers })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "POST", url: `/api/v1/drafts/${draft.id}/preview`, headers: mallory.headers, payload: { attestLiveSystemImpactNone: true } })).statusCode).toBe(404);
    const list = await h.app.inject({ method: "GET", url: "/api/v1/drafts", headers: mallory.headers });
    expect((list.json() as { items: unknown[] }).items).toEqual([]);
    // The owner's draft is untouched.
    expect((await h.app.inject({ method: "GET", url: `/api/v1/drafts/${draft.id}`, headers: h.headers })).statusCode).toBe(200);
  });

  it("refuses SC-001 on update with FEATURE_DISABLED (SEC-CLAIM-06)", async () => {
    const h = harnessOf();
    const draft = await createDraft(h);
    const response = await h.app.inject({ method: "PUT", url: `/api/v1/drafts/${draft.id}`, headers: h.headers, payload: { input: draftBody({ policy: { id: "SC-001", version: "0.1.0" }, policyParameters: {} }) } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("FEATURE_DISABLED");
  });

  it("validates text with the claim document rules so errors surface early (SEC-CLAIM-02)", async () => {
    const h = harnessOf();
    const cases: Record<string, unknown>[] = [
      { requirement: "Hidden \u202e override" },
      { violation: "zero\u200bwidth" },
      { faultModel: "separator \u241f inside" },
      { requirement: "e\u0301 not NFC" },
      { title: "Quote \" in title" },
      { title: "Backslash \\ in title" },
      { title: "Bracket ]: fake terms [ in title" },
      { title: "Open [ only" },
      { title: "x".repeat(121) },
      { commit: "abc" },
      { repository: { owner: "-bad", name: "repo" } },
      { regressionOnly: true, baseCommit: null },
      { baseCommit: "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12" },
      { minBondWei: "0" },
      { unknownField: true },
    ];
    for (const overrides of cases) {
      const response = await h.app.inject({ method: "POST", url: "/api/v1/drafts", headers: h.headers, payload: draftBody(overrides) });
      expect(response.statusCode, JSON.stringify(overrides)).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("checks window and bond bounds at draft time", async () => {
    const h = harnessOf();
    const short = await h.app.inject({ method: "POST", url: "/api/v1/drafts", headers: h.headers, payload: draftBody({ evidenceWindowSeconds: 3 * 86_400 - 1 }) });
    expect(short.statusCode).toBe(400);
    expect(short.json().error.message).toContain(String(30 * 86_400 - 60));
    const long = await h.app.inject({ method: "POST", url: "/api/v1/drafts", headers: h.headers, payload: draftBody({ evidenceWindowSeconds: 30 * 86_400 + 1 }) });
    expect(long.statusCode).toBe(400);
    const bond = await h.app.inject({ method: "POST", url: "/api/v1/drafts", headers: h.headers, payload: draftBody({ minBondWei: (101n * 10n ** 18n).toString() }) });
    expect(bond.statusCode).toBe(400);
    const ok = await h.app.inject({ method: "POST", url: "/api/v1/drafts", headers: h.headers, payload: draftBody({ minBondWei: (10n ** 18n).toString(), evidenceWindowSeconds: 3 * 86_400 }) });
    expect(ok.statusCode).toBe(201);
  });

  it("consumes claim_drafts_per_day on create only", async () => {
    const h = harnessOf();
    h.ctx.quotas = new FakeQuotas({ claim_drafts_per_day: 1 });
    const draft = await createDraft(h);
    const second = await h.app.inject({ method: "POST", url: "/api/v1/drafts", headers: h.headers, payload: draftBody() });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("QUOTA_EXCEEDED");
    expect(second.headers["retry-after"]).toBe("3600");
    // Updates do not consume the creation quota.
    const update = await h.app.inject({ method: "PUT", url: `/api/v1/drafts/${draft.id}`, headers: h.headers, payload: { input: draftBody() } });
    expect(update.statusCode).toBe(200);
  });
});

describe("drafts stored under older rules (claims-006)", () => {
  it("still list and load, and are revalidated at preview and update with a validation error instead of 500", async () => {
    const h = harnessOf();
    const good = await createDraft(h);
    // A title saved before titles refused brackets.
    const id = randomUUID();
    const at = h.ctx.clock.now().toISOString();
    await h.ctx.database.sql.query("INSERT INTO claim_drafts (id, user_id, revision, input, created_at, updated_at) VALUES ($1, $2, 1, $3::jsonb, $4, $4)", [
      id,
      h.session.userId,
      JSON.stringify({ ...draftBody({ title: "Rule [1]: fake terms [x" }), baseCommit: null }),
      at,
    ]);
    const list = await h.app.inject({ method: "GET", url: "/api/v1/drafts", headers: h.headers });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: { id: string; valid: boolean; issues: { path: string[] }[]; input: { title: string } }[] }).items;
    expect(items.map((item) => item.id).sort()).toEqual([good.id, id].sort());
    const stale = items.find((item) => item.id === id)!;
    expect(stale).toMatchObject({ valid: false, input: { title: "Rule [1]: fake terms [x" } });
    expect(stale.issues.map((issue) => issue.path.join("."))).toContain("title");
    expect(items.find((item) => item.id === good.id)).toMatchObject({ valid: true, issues: [] });

    const read = await h.app.inject({ method: "GET", url: `/api/v1/drafts/${id}`, headers: h.headers });
    expect(read.statusCode).toBe(200);
    expect(read.json().draft).toMatchObject({ valid: false });

    const preview = await h.app.inject({ method: "POST", url: `/api/v1/drafts/${id}/preview`, headers: h.headers, payload: { attestLiveSystemImpactNone: true } });
    expect(preview.statusCode).toBe(400);
    expect(preview.json().error.code).toBe("VALIDATION_FAILED");
    expect(preview.json().error.issues.map((issue: { path: string[] }) => issue.path.join("."))).toContain("title");
    const [count] = await h.ctx.database.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM claim_previews");
    expect(count!.n).toBe(0);

    // An update with the old input is refused by the current rules; a corrected one is accepted.
    const stillBad = await h.app.inject({ method: "PUT", url: `/api/v1/drafts/${id}`, headers: h.headers, payload: { input: draftBody({ title: "Rule [1]: fake terms [x" }) } });
    expect(stillBad.statusCode).toBe(400);
    const fixed = await h.app.inject({ method: "PUT", url: `/api/v1/drafts/${id}`, headers: h.headers, payload: { input: draftBody({ title: "Rule one holds" }) } });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().draft).toMatchObject({ revision: 2, valid: true });
  });
});
