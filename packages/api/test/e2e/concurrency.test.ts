// Concurrency cases PGlite cannot show (it serialises every query), on real PostgreSQL 16 with the production driver
// (PRD-06 section 3): a draft delete racing a first publication, concurrent quota consumption at the limit, two job
// runners competing for one lease, and two identical publication requests. Skipped on PGlite; with
// PINE_E2E_REQUIRE_PG=1 a missing PINE_E2E_DATABASE_URL fails the suite instead (support/database.ts).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobDefinition } from "../../src/contracts/app.js";
import { JobLeases, JobRunner } from "../../src/platform/core/jobs.js";
import { Browser, createE2e, multipart, type E2e } from "./support/app.js";
import { databaseMode } from "./support/database.js";
import { assertNoSecretLeaks } from "./support/leaks.js";
import { account, createDraft, createPreview, linkGitHub, seedRepository, type PublicationBody } from "./support/scenario.js";

const realPostgres = databaseMode() === "postgres";
const UPLOAD_QUOTA = 4;

let e2e: E2e;
let creator: Browser;
let researcher: Browser;

describe.skipIf(!realPostgres)("concurrency on real PostgreSQL 16", () => {
  beforeAll(async () => {
    e2e = await createE2e({ env: { PINE_QUOTA_EVIDENCE_UPLOADS_PER_DAY: String(UPLOAD_QUOTA), PINE_DATABASE_POOL_MAX: "20" } });
    seedRepository(e2e);
    await e2e.chain.tick();
    creator = new Browser(e2e, account(0xc0ffee));
    researcher = new Browser(e2e, account(0xbeef01));
    await creator.signIn();
    await linkGitHub(creator, { githubUserId: 9_001, login: "maintainer" });
    await researcher.signIn();
  }, 30 * 60_000);

  afterAll(async () => {
    await e2e?.close();
  }, 120_000);

  it("PRD-03 §8b a draft delete racing a first publication never answers 500 and never leaves a publication without its draft", async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      const draftId = await createDraft(creator);
      const preview = await createPreview(creator, draftId);
      const [publication, deletion] = await Promise.all([
        creator.send("POST", "/api/v1/publications", { body: { previewId: preview.previewId, documentSha256: preview.documentSha256 } }),
        creator.send("DELETE", `/api/v1/drafts/${draftId}`),
      ]);
      expect([200, 404, 409], publication.body).toContain(publication.statusCode);
      expect([204, 409], deletion.body).toContain(deletion.statusCode);
      const drafts = await e2e.db.api.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM claim_drafts WHERE id = $1::uuid", [draftId]);
      const publications = await e2e.db.api.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM claim_publications WHERE draft_id = $1::uuid", [draftId]);
      if (deletion.statusCode === 204) {
        expect(drafts[0]?.n).toBe(0);
        expect(publications[0]?.n).toBe(0);
        expect(publication.statusCode).not.toBe(200);
      } else {
        expect(drafts[0]?.n).toBe(1);
      }
      if (publication.statusCode === 200) expect(publications[0]?.n).toBe(1);
      outcomes.push(`${publication.statusCode}/${deletion.statusCode}`);
    }
    expect(outcomes.every((outcome) => !outcome.includes("500"))).toBe(true);
    console.info(`draft delete vs first publication outcomes (publication/delete): ${outcomes.join(", ")}`);
  });

  it("PRD-03 §6 identical concurrent publication requests create one row and one plan; retries consume no quota", async () => {
    const draftId = await createDraft(creator);
    const preview = await createPreview(creator, draftId);
    const quota = async () =>
      (await e2e.db.api.sql.query<{ n: number }>("SELECT coalesce(sum(used), 0)::int AS n FROM quota_usage WHERE user_id = $1::uuid AND quota = 'publications_per_day'", [creator.userId]))[0]?.n ?? 0;
    const before = await quota();
    const responses = await Promise.all(Array.from({ length: 4 }, () => creator.send("POST", "/api/v1/publications", { body: { previewId: preview.previewId, documentSha256: preview.documentSha256 } })));
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    const bodies = responses.map((response) => response.json<PublicationBody>());
    expect(new Set(bodies.map((body) => body.publication.id)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.plan?.planId)).size).toBe(1);
    const rows = await e2e.db.api.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM claim_publications WHERE preview_id = $1::uuid", [preview.previewId]);
    expect(rows[0]?.n).toBe(1);
    // PRD-03 §6: racing FIRST requests may each consume a quota unit (accepted); never more than one per request.
    const consumed = (await quota()) - before;
    expect(consumed).toBeGreaterThanOrEqual(1);
    expect(consumed).toBeLessThanOrEqual(responses.length);
    // A later retry of the same document reuses the row and consumes nothing.
    const retry = await creator.send("POST", "/api/v1/publications", { body: { previewId: preview.previewId, documentSha256: preview.documentSha256 } });
    expect(retry.json<PublicationBody>().publication.id).toBe(bodies[0]?.publication.id);
    expect((await quota()) - before).toBe(consumed);
  });

  it("SEC-EVID-01 concurrent uploads at the quota limit: exactly the limit succeeds, never over-consumed", async () => {
    const uploads = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        researcher.send("POST", "/api/v1/evidence/artifacts", { raw: multipart({}, { bytes: new TextEncoder().encode(`artifact number ${index}\n`), mediaType: "text/plain", name: `a${index}.txt` }) }),
      ),
    );
    const created = uploads.filter((response) => response.statusCode === 201);
    const refused = uploads.filter((response) => response.statusCode === 429);
    expect(created).toHaveLength(UPLOAD_QUOTA);
    expect(refused).toHaveLength(12 - UPLOAD_QUOTA);
    for (const response of refused) expect(response.json<{ error: { code: string } }>().error.code).toBe("QUOTA_EXCEEDED");
    const used = await e2e.db.api.sql.query<{ n: number }>("SELECT coalesce(sum(used), 0)::int AS n FROM quota_usage WHERE user_id = $1::uuid AND quota = 'evidence_uploads_per_day'", [researcher.userId]);
    expect(used[0]?.n).toBe(UPLOAD_QUOTA);
    const stored = await e2e.db.api.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM markets_uploads WHERE user_id = $1::uuid", [researcher.userId]);
    expect(stored[0]?.n).toBe(UPLOAD_QUOTA);
  });

  it("PRD-02 2.5 two API processes competing for one job lease: at most one execution at a time", async () => {
    // Raw acquisition race between two connection pools (two processes): exactly one holder wins.
    const second = await e2e.db.connectApi();
    const contenders = Array.from({ length: 8 }, (_, index) => new JobLeases(index % 2 === 0 ? e2e.db.api.db : second.db, `holder-${index}`, 30_000));
    const won = await Promise.all(contenders.map((lease) => lease.acquire("e2e.race")));
    expect(won.filter(Boolean)).toHaveLength(1);

    // Two full runners with short leases: the probe job never overlaps itself across them.
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const holders = new Set<string>();
    const makeJob = (holder: string): JobDefinition => ({
      name: "e2e.lease-probe",
      intervalMs: 50,
      async run(_ctx, signal) {
        active += 1;
        runs += 1;
        maxActive = Math.max(maxActive, active);
        holders.add(holder);
        await new Promise((resolve) => setTimeout(resolve, 150));
        active -= 1;
        if (signal.aborted) return;
      },
    });
    const logger = { info: () => undefined, error: () => undefined };
    const runners = [
      new JobRunner({ db: e2e.db.api.db, ctx: e2e.ctx, jobs: [makeJob("a")], logger, metrics: e2e.ctx.metrics, redact: e2e.redact, holderId: "runner-a", leaseTtlMs: 3_000, pollMs: 25 }),
      new JobRunner({ db: second.db, ctx: e2e.ctx, jobs: [makeJob("b")], logger, metrics: e2e.ctx.metrics, redact: e2e.redact, holderId: "runner-b", leaseTtlMs: 3_000, pollMs: 25 }),
    ];
    for (const runner of runners) runner.start();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await Promise.all(runners.map((runner) => runner.stop()));
    expect(maxActive).toBe(1);
    const lease = await e2e.db.api.sql.query<{ holder: string }>("SELECT holder FROM job_leases WHERE name = 'e2e.lease-probe'");
    expect(lease).toHaveLength(1);
    expect(runs).toBeGreaterThanOrEqual(3);
    expect(holders.size).toBeGreaterThanOrEqual(1);
  });

  it("leaked no secret into any response or log line", () => {
    expect(assertNoSecretLeaks(e2e).responses).toBeGreaterThan(20);
  });
});

describe.skipIf(realPostgres)("concurrency on PGlite", () => {
  it("is not exercised: PGlite serialises queries (set PINE_E2E_DATABASE_URL; CI sets PINE_E2E_REQUIRE_PG=1)", () => {
    expect(databaseMode()).toBe("pglite");
  });
});
