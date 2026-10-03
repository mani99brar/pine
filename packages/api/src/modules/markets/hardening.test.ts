// Must stay the first import: serializes the memory-heavy markets test files (see test/lock.ts).
import "./test/lock.js";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@pine/shared/canonical";
import { REALITY_ANSWERED_TOO_SOON, type OracleQuestionRecord } from "@pine/shared/read-model";
import { SCENARIO_ADDRESSES } from "@pine/shared/testing/read-model-scenarios";
import type { Address, Hex32 } from "@pine/shared/types";
import type { AuditEntry } from "../../contracts/app.js";
import { MemoryAuditLog } from "../../contracts/testing.js";
import { flushAudit, queueAudit, settledAudit } from "./audit.js";
import { addClaim, EVIDENCE_REGISTRY, postJson, rawInject, upload, useHarness, type Harness } from "./test/helpers.js";

// PRD-07 section 3 (api-hardening) for the markets module: cooperative job abort, the finalized-block gate of expiry, the
// audit outbox (SEC-OPS-07, with the 3c single-flight and request-path fixes) and loadOracle's reopenedBy link. Fan-out
// and listing-cache items are in evidence-browse.test.ts.

const harnessOf = useHarness();
const XDAI = 10n ** 18n;
const TIMEOUT = 302_400;
const REALITY = SCENARIO_ADDRESSES.reality as Address;
const ALICE = "0x0000000000000000000000000000000000a1a1a1" as Address;
const commitment = (n: number) => `0x${n.toString(16).padStart(64, "c")}` as Hex32;
const txHash = (n: number) => `0x${n.toString(16).padStart(64, "e")}` as Hex32;

const reconcileJob = (h: Harness) => h.module.jobs!.find((item) => item.name === "markets.reconcile")!;
const reconcile = (h: Harness, signal = new AbortController().signal) => reconcileJob(h).run(h.ctx, signal);
const watchJob = (h: Harness) => h.module.jobs!.find((item) => item.name === "markets.watch")!;
const watch = (h: Harness, signal = new AbortController().signal) => watchJob(h).run(h.ctx, signal);
const plans = (h: Harness) => h.ctx.database.sql.query<{ id: string; state: string; reconciled_at: unknown }>("SELECT id::text AS id, state, reconciled_at FROM markets_plans ORDER BY id");
const outbox = async (h: Harness) => (await h.ctx.database.sql.query<{ entry: AuditEntry }>("SELECT entry FROM markets_audit_outbox ORDER BY created_at, id")).map((row) => row.entry);
const syntheticEntry = (n: number): AuditEntry => ({ actorUserId: null, action: "markets.plan.confirmed", subjectType: "markets_plan", subjectId: `single-flight-${n}`, details: { n }, ip: null });
const recorded = (h: Harness, action: string) => h.ctx.audit.entries.filter((entry) => entry.action === action);
const submitted = (h: Harness, id: string, stepId: string, hash: string) =>
  h.app.inject({ method: "POST", url: `/api/v1/markets/plans/${id}/submitted`, headers: h.headers, payload: { stepId, txHash: hash } });

async function commitPlan(h: Harness, market: Address, n: number, key?: string): Promise<string> {
  const response = await postJson(h, "/api/v1/evidence/plans/commit", { market, commitment: commitment(n) }, key ? { key } : {});
  expect([200, 201]).toContain(response.statusCode);
  return (response.json() as { planState: { id: string } }).planState.id;
}

async function indexCommit(h: Harness, market: Address, n: number) {
  h.b.nextBlock();
  await h.apply({ ...h.b.envelope(EVIDENCE_REGISTRY), kind: "EvidenceCommitted", submissionId: BigInt(n), market, submitter: h.session.wallet, commitment: commitment(n), committedAt: h.b.now() });
}

describe("cooperative abort of markets.reconcile (PRD-07 section 3)", () => {
  it("an abort before the run starts no plan: nothing confirmed, no reconciled_at written", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "ab1");
    await commitPlan(h, claim.market, 1);
    await commitPlan(h, claim.market, 2);
    await indexCommit(h, claim.market, 1);
    await indexCommit(h, claim.market, 2);
    const controller = new AbortController();
    controller.abort();
    await reconcile(h, controller.signal);
    expect((await plans(h)).map((row) => [row.state, row.reconciled_at])).toEqual([
      ["planned", null],
      ["planned", null],
    ]);
    // Positive control: the same run without an abort confirms both.
    await reconcile(h);
    expect((await plans(h)).map((row) => row.state)).toEqual(["confirmed", "confirmed"]);
  });

  it("an abort during the first plan finishes that plan and leaves the second untouched", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "ab2");
    await commitPlan(h, claim.market, 1);
    await commitPlan(h, claim.market, 2);
    await indexCommit(h, claim.market, 1);
    await indexCommit(h, claim.market, 2);
    const controller = new AbortController();
    const listEvidence = h.ctx.readModel.listEvidence.bind(h.ctx.readModel);
    // The read-model call of the first plan's confirmation aborts the run (as a shutdown would).
    vi.spyOn(h.ctx.readModel, "listEvidence").mockImplementation(async (query) => {
      controller.abort();
      return listEvidence(query);
    });
    await reconcile(h, controller.signal);
    const rows = await plans(h);
    expect(rows.filter((row) => row.state === "confirmed" && row.reconciled_at !== null)).toHaveLength(1);
    expect(rows.filter((row) => row.state === "planned" && row.reconciled_at === null)).toHaveLength(1);
    // The transition's audit entry was queued by the same statement; the aborted run does not flush it, the next run does.
    expect(recorded(h, "markets.plan.confirmed")).toEqual([]);
    expect((await outbox(h)).map((entry) => entry.action)).toEqual(["markets.plan.confirmed"]);
    vi.restoreAllMocks();
    await reconcile(h);
    expect((await plans(h)).map((row) => row.state)).toEqual(["confirmed", "confirmed"]);
    expect(recorded(h, "markets.plan.confirmed")).toHaveLength(2);
    expect(await outbox(h)).toEqual([]);
  });
});

describe("cooperative abort of the registered markets.watch job (PRD-07 sections 3 and 3c)", () => {
  const notifiedMarkets = async (h: Harness) => (await h.ctx.database.sql.query<{ market: string }>("SELECT DISTINCT market FROM markets_notifications ORDER BY market")).map((row) => row.market);
  const watchState = (h: Harness) => h.ctx.database.sql.query("SELECT cursor FROM markets_watch_state");

  async function twoClosingClaims(h: Harness) {
    const first = await addClaim(h, "w1", { creator: h.session.wallet });
    const second = await addClaim(h, "w2", { creator: h.session.wallet });
    h.at(Math.max(first.evidenceDeadline, second.evidenceDeadline) - 3_600);
    await h.fresh();
    return [first, second];
  }

  it("an abort before the run lists no claim, inserts nothing and keeps the cursor", async () => {
    const h = harnessOf();
    const claims = await twoClosingClaims(h);
    const listClaims = vi.spyOn(h.ctx.readModel, "listClaims");
    const controller = new AbortController();
    controller.abort();
    await watch(h, controller.signal);
    expect(listClaims).not.toHaveBeenCalled();
    expect(await notifiedMarkets(h)).toEqual([]);
    expect(await watchState(h)).toEqual([]);
    // Positive control: without the abort both claims are notified.
    await watch(h);
    expect(await notifiedMarkets(h)).toEqual(claims.map((claim) => claim.market).sort());
  });

  it("an abort during the first claim leaves the second claim untouched and the cursor where it was", async () => {
    const h = harnessOf();
    await twoClosingClaims(h);
    const controller = new AbortController();
    const getOracleQuestion = h.ctx.readModel.getOracleQuestion.bind(h.ctx.readModel);
    vi.spyOn(h.ctx.readModel, "getOracleQuestion").mockImplementation(async (questionId) => {
      controller.abort();
      return getOracleQuestion(questionId);
    });
    await watch(h, controller.signal);
    expect(await notifiedMarkets(h)).toHaveLength(1);
    // The rotated cursor is not persisted past claims this run never processed.
    expect(await watchState(h)).toEqual([]);
  });
});

describe("markets.reconcile decides expiry only with a finalized block from this attempt (PRD-07 section 3)", () => {
  it("finalizedBlock() throws for a plan past expires_at + 1 h: the plan state is unchanged; the next run expires it", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "fin1", { evidenceDeadline: h.b.now() + 7_200 });
    const id = await commitPlan(h, claim.market, 1);
    const expiresAt = claim.evidenceDeadline - 60;
    h.at(expiresAt + 3_601);
    await h.fresh();
    h.ctx.chain.setHandler(async (method) => {
      throw new Error(`rpc down for ${method}`);
    });
    try {
      await reconcile(h);
    } finally {
      h.chain.install(h.ctx);
    }
    expect((await plans(h)).map((row) => [row.id, row.state])).toEqual([[id, "planned"]]);
    expect(recorded(h, "markets.plan.expired")).toEqual([]);
    await reconcile(h);
    expect((await plans(h)).map((row) => row.state)).toEqual(["expired"]);
  });
});

describe("SEC-OPS-07 audit outbox (PRD-07 section 3)", () => {
  it("SEC-OPS-07 an audit outage keeps the plan-created entry in the outbox; the next write records it exactly once", async () => {
    const h = harnessOf();
    vi.spyOn(h.ctx.audit, "record").mockRejectedValueOnce(new Error("audit store down"));
    const claim = await addClaim(h, "ob1");
    const id = await commitPlan(h, claim.market, 1);
    expect(recorded(h, "markets.plan.created")).toEqual([]);
    expect(await outbox(h)).toMatchObject([{ action: "markets.plan.created", subjectId: id }]);
    // A later audited write (a new tx-hash hint) flushes the pending entry, then its own.
    expect((await submitted(h, id, "commit", txHash(1))).statusCode).toBe(200);
    expect(recorded(h, "markets.plan.created")).toMatchObject([{ actorUserId: h.session.userId, subjectType: "markets_plan", subjectId: id, details: { route: "evidence.commit", kind: "evidence_commit", market: claim.market, steps: 1 } }]);
    expect(recorded(h, "markets.plan.tx_reported")).toHaveLength(1);
    expect(await outbox(h)).toEqual([]);
    await reconcile(h);
    expect(recorded(h, "markets.plan.created")).toHaveLength(1);
  });

  it("SEC-OPS-07 a same-key replay flushes an entry left by an outage", async () => {
    const h = harnessOf();
    vi.spyOn(h.ctx.audit, "record").mockRejectedValueOnce(new Error("audit store down"));
    const claim = await addClaim(h, "ob2");
    const id = await commitPlan(h, claim.market, 1, "replay-key");
    expect(await outbox(h)).toHaveLength(1);
    expect(await commitPlan(h, claim.market, 1, "replay-key")).toBe(id);
    expect(recorded(h, "markets.plan.created").map((entry) => entry.subjectId)).toEqual([id]);
    expect(await outbox(h)).toEqual([]);
  });

  it("SEC-OPS-07 a reconcile run with no open plans flushes an entry left by an outage", async () => {
    const h = harnessOf();
    vi.spyOn(h.ctx.audit, "record").mockRejectedValueOnce(new Error("audit store down"));
    const claim = await addClaim(h, "ob3");
    const id = await commitPlan(h, claim.market, 1);
    await h.ctx.database.sql.query("UPDATE markets_plans SET state = 'expired'");
    expect(await outbox(h)).toHaveLength(1);
    await reconcile(h);
    expect(recorded(h, "markets.plan.created").map((entry) => entry.subjectId)).toEqual([id]);
    expect(await outbox(h)).toEqual([]);
  });

  it("SEC-OPS-07 several pending entries of one plan (created, tx_reported, confirmed) all survive an outage", async () => {
    const h = harnessOf();
    const record = vi.spyOn(h.ctx.audit, "record").mockRejectedValue(new Error("audit store down"));
    const claim = await addClaim(h, "ob4");
    const id = await commitPlan(h, claim.market, 1);
    expect((await submitted(h, id, "commit", txHash(2))).statusCode).toBe(200);
    await indexCommit(h, claim.market, 1);
    await reconcile(h);
    expect((await plans(h)).map((row) => row.state)).toEqual(["confirmed"]);
    expect(h.ctx.audit.entries).toEqual([]);
    expect((await outbox(h)).map((entry) => entry.action).sort()).toEqual(["markets.plan.confirmed", "markets.plan.created", "markets.plan.tx_reported"]);
    record.mockRestore();
    await reconcile(h);
    expect(h.ctx.audit.entries.map((entry) => [entry.action, entry.subjectId]).sort()).toEqual([
      ["markets.plan.confirmed", id],
      ["markets.plan.created", id],
      ["markets.plan.tx_reported", id],
    ]);
    expect(recorded(h, "markets.plan.tx_reported")[0]?.details).toEqual({ stepId: "commit", txHash: txHash(2) });
    expect(recorded(h, "markets.plan.confirmed")[0]?.details).toEqual({ from: "submitted", kind: "evidence_commit" });
    expect(await outbox(h)).toEqual([]);
  });

  it("SEC-OPS-07 an abort between entries leaves the unrecorded rows in the outbox", async () => {
    const h = harnessOf();
    const record = vi.spyOn(h.ctx.audit, "record").mockRejectedValue(new Error("audit store down"));
    const claim = await addClaim(h, "ob5");
    const id = await commitPlan(h, claim.market, 1);
    await submitted(h, id, "commit", txHash(3));
    await submitted(h, id, "commit", txHash(4));
    expect(await outbox(h)).toHaveLength(3);
    const controller = new AbortController();
    const real = MemoryAuditLog.prototype.record;
    record.mockImplementation(async (entry) => {
      await real.call(h.ctx.audit, entry);
      controller.abort();
    });
    await flushAudit(h.ctx, controller.signal);
    expect(h.ctx.audit.entries).toHaveLength(1);
    expect(await outbox(h)).toHaveLength(2);
    expect([...h.ctx.audit.entries, ...(await outbox(h))].map((entry) => entry.action).sort()).toEqual(["markets.plan.created", "markets.plan.tx_reported", "markets.plan.tx_reported"]);
  });

  it("SEC-OPS-07 single-flight: a flush called while one is recording drains again; both entries are recorded once when it resolves", async () => {
    const h = harnessOf();
    await h.ctx.db.execute(queueAudit(syntheticEntry(1), h.ctx.clock.now()));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = MemoryAuditLog.prototype.record;
    const record = vi.spyOn(h.ctx.audit, "record").mockImplementation(async (entry) => {
      await gate;
      await real.call(h.ctx.audit, entry);
    });
    const first = flushAudit(h.ctx);
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    // Queued after the first flush read the outbox: only a second drain can see it.
    await h.ctx.db.execute(queueAudit(syntheticEntry(2), h.ctx.clock.now()));
    const second = flushAudit(h.ctx);
    release();
    await second;
    expect(h.ctx.audit.entries.map((entry) => entry.subjectId)).toEqual(["single-flight-1", "single-flight-2"]);
    expect(await outbox(h)).toEqual([]);
    await first;
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("SEC-OPS-07 a drain that rejects clears the single-flight entry: the next flush still records the pending entry", async () => {
    const h = harnessOf();
    await h.ctx.db.execute(queueAudit(syntheticEntry(3), h.ctx.clock.now()));
    // The audit store fails and the failure path itself throws: the drain rejects once.
    vi.spyOn(h.ctx.audit, "record").mockRejectedValueOnce(new Error("audit store down"));
    vi.spyOn(h.ctx.metrics, "increment").mockImplementationOnce(() => {
      throw new Error("metrics sink down");
    });
    await expect(flushAudit(h.ctx)).rejects.toThrow("metrics sink down");
    expect(await outbox(h)).toHaveLength(1);
    await flushAudit(h.ctx);
    expect(h.ctx.audit.entries).toEqual([syntheticEntry(3)]);
    expect(await outbox(h)).toEqual([]);
  });

  it("SEC-OPS-07 an audit store that never resolves does not delay the plan response; the committed row is recorded later", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "nr1");
    let release: () => void = () => {};
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = MemoryAuditLog.prototype.record;
    vi.spyOn(h.ctx.audit, "record").mockImplementation(async (entry) => {
      await stuck;
      await real.call(h.ctx.audit, entry);
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      // A raw inject: the harness would otherwise wait for the request's flush.
      const response = await Promise.race([
        rawInject(h.app, { method: "POST", url: "/api/v1/evidence/plans/commit", headers: { ...h.headers, "idempotency-key": "never-resolves" }, payload: { market: claim.market, commitment: commitment(1) } }),
        new Promise<"delayed">((resolve) => {
          timer = setTimeout(() => resolve("delayed"), 5_000);
        }),
      ]);
      if (response === "delayed") throw new Error("the plan response waited for the audit store");
      expect(response.statusCode, response.body).toBe(201);
      expect(h.ctx.audit.entries).toEqual([]);
      expect(await outbox(h)).toMatchObject([{ action: "markets.plan.created", subjectId: response.json().planState.id }]);
    } finally {
      clearTimeout(timer);
      release();
    }
    await settledAudit(h.ctx);
    expect(recorded(h, "markets.plan.created")).toHaveLength(1);
    expect(await outbox(h)).toEqual([]);
  });

  it("SEC-OPS-07 a failing background flush never fails the response and is logged redacted", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "lg1");
    vi.spyOn(h.ctx.audit, "record").mockRejectedValueOnce(new Error("audit store down"));
    const increment = h.ctx.metrics.increment.bind(h.ctx.metrics);
    vi.spyOn(h.ctx.metrics, "increment").mockImplementation((name, labels) => {
      if (name === "markets_audit_outbox") throw new Error("metrics sink down token=test-secret-value");
      increment(name, labels);
    });
    const response = await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: commitment(1) });
    expect(response.statusCode, response.body).toBe(201);
    const logged = h.logLines.filter((line) => line.includes("markets audit flush failed"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("metrics sink down");
    expect(logged[0]).not.toContain("test-secret-value");
    expect(await outbox(h)).toHaveLength(1);
  });

  it("SEC-OPS-07 an audit outage during evidence uploads loses no entry (first upload and restored upload)", async () => {
    const h = harnessOf();
    const data = new Uint8Array(32).fill(5);
    vi.spyOn(h.ctx.audit, "record").mockRejectedValueOnce(new Error("audit store down"));
    expect((await upload(h, [{ name: "file", filename: "a", contentType: "text/plain", data }])).statusCode).toBe(201);
    expect(h.ctx.audit.entries).toEqual([]);
    expect(await outbox(h)).toMatchObject([{ action: "markets.evidence.artifact_uploaded", subjectId: sha256Hex(data), details: { size: 32, restored: false } }]);
    // The bytes vanish and are uploaded again during another outage: the restored upload (its row already exists) is
    // queued by its own outbox INSERT.
    h.ctx.contentStore.items.delete(sha256Hex(data));
    vi.spyOn(h.ctx.audit, "record").mockRejectedValueOnce(new Error("audit store down"));
    expect((await upload(h, [{ name: "file", filename: "b", contentType: "text/plain", data }])).statusCode).toBe(201);
    expect(h.ctx.audit.entries).toEqual([]);
    expect((await outbox(h)).map((entry) => entry.details.restored).sort()).toEqual([false, true]);
    await reconcile(h);
    const uploads = recorded(h, "markets.evidence.artifact_uploaded");
    expect(uploads.map((entry) => [entry.subjectId, entry.details.restored]).sort()).toEqual([
      [sha256Hex(data), false],
      [sha256Hex(data), true],
    ]);
    expect(uploads[0]).toMatchObject({ actorUserId: h.session.userId, subjectType: "content", details: { size: 32, cid: expect.stringMatching(/^bafkrei/) } });
    expect(await outbox(h)).toEqual([]);
  });
});

describe("SEC-OPS-07 outbox atomicity: an audited write commits only together with its outbox row (PRD-07 3d)", () => {
  const count = async (h: Harness, table: string) => (await h.ctx.database.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0]?.n;

  /** Every outbox INSERT fails while `run` runs (a NOT VALID check skips existing rows and refuses every new one). */
  async function withFailingOutbox(h: Harness, run: () => Promise<void>): Promise<void> {
    await h.ctx.database.sql.exec("ALTER TABLE markets_audit_outbox ADD CONSTRAINT outbox_fail CHECK (false) NOT VALID");
    try {
      await run();
    } finally {
      await h.ctx.database.sql.exec("ALTER TABLE markets_audit_outbox DROP CONSTRAINT outbox_fail");
    }
  }

  it("SEC-OPS-07 a plan insert whose outbox INSERT fails is refused and commits no plan and no step", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "at1");
    await withFailingOutbox(h, async () => {
      const response = await postJson(h, "/api/v1/evidence/plans/commit", { market: claim.market, commitment: commitment(1) }, { key: "atomic-plan" });
      expect(response.statusCode, response.body).toBe(500);
    });
    expect(await count(h, "markets_plans")).toBe(0);
    expect(await count(h, "markets_plan_steps")).toBe(0);
    expect(await outbox(h)).toEqual([]);
    // Positive control: the same key then creates the plan and its entry is recorded.
    const id = await commitPlan(h, claim.market, 1, "atomic-plan");
    expect(recorded(h, "markets.plan.created").map((entry) => entry.subjectId)).toEqual([id]);
  });

  it("SEC-OPS-07 a new tx-hash hint whose outbox INSERT fails is refused: no hint stored, the plan stays planned", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "at2");
    const id = await commitPlan(h, claim.market, 1);
    await withFailingOutbox(h, async () => {
      expect((await submitted(h, id, "commit", txHash(1))).statusCode).toBe(500);
    });
    expect(await count(h, "markets_plan_txs")).toBe(0);
    expect((await plans(h)).map((row) => row.state)).toEqual(["planned"]);
    expect(recorded(h, "markets.plan.tx_reported")).toEqual([]);
    // Positive control: the same hint afterwards is stored and audited once.
    expect((await submitted(h, id, "commit", txHash(1))).statusCode).toBe(200);
    expect(await count(h, "markets_plan_txs")).toBe(1);
    expect(recorded(h, "markets.plan.tx_reported")).toHaveLength(1);
  });

  it("SEC-OPS-07 a confirmed transition whose outbox INSERT fails is not committed; the next run confirms and audits it", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "at3");
    await commitPlan(h, claim.market, 1);
    await indexCommit(h, claim.market, 1);
    await withFailingOutbox(h, () => reconcile(h));
    expect((await plans(h)).map((row) => row.state)).toEqual(["planned"]);
    expect(recorded(h, "markets.plan.confirmed")).toEqual([]);
    expect(await outbox(h)).toEqual([]);
    await reconcile(h);
    expect((await plans(h)).map((row) => row.state)).toEqual(["confirmed"]);
    expect(recorded(h, "markets.plan.confirmed")).toHaveLength(1);
  });

  it("SEC-OPS-07 an expired transition whose outbox INSERT fails is not committed; the next run expires and audits it", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "at4", { evidenceDeadline: h.b.now() + 7_200 });
    await commitPlan(h, claim.market, 1);
    h.at(claim.evidenceDeadline - 60 + 3_601);
    await h.fresh();
    await withFailingOutbox(h, () => reconcile(h));
    expect((await plans(h)).map((row) => row.state)).toEqual(["planned"]);
    expect(recorded(h, "markets.plan.expired")).toEqual([]);
    await reconcile(h);
    expect((await plans(h)).map((row) => row.state)).toEqual(["expired"]);
    expect(recorded(h, "markets.plan.expired")).toHaveLength(1);
  });

  it("SEC-OPS-07 an evidence upload whose outbox INSERT fails is refused: no upload row (first upload), no silent loss (restored upload)", async () => {
    const h = harnessOf();
    const data = new Uint8Array(32).fill(7);
    const part = (filename: string) => [{ name: "file", filename, contentType: "text/plain", data }];
    const uploads = () => recorded(h, "markets.evidence.artifact_uploaded").map((entry) => entry.details.restored);
    await withFailingOutbox(h, async () => {
      const response = await upload(h, part("a"));
      expect(response.statusCode, response.body).toBe(500);
    });
    expect(await count(h, "markets_uploads")).toBe(0);
    expect(uploads()).toEqual([]);
    // Positive control: the first upload then commits its row and its entry.
    expect((await upload(h, part("a"))).statusCode).toBe(201);
    expect(await count(h, "markets_uploads")).toBe(1);
    expect(uploads()).toEqual([false]);
    // Restored upload (the row exists, the bytes vanished): its single-statement outbox INSERT fails, so the request fails
    // instead of answering 201 without a queued entry.
    h.ctx.contentStore.items.delete(sha256Hex(data));
    await withFailingOutbox(h, async () => {
      expect((await upload(h, part("b"))).statusCode).toBe(500);
    });
    expect(await count(h, "markets_uploads")).toBe(1);
    expect(uploads()).toEqual([false]);
    expect(await outbox(h)).toEqual([]);
  });
});

describe("loadOracle and reopenedBy (PRD-07 section 3)", () => {
  it("accepts a replacement linked only through the original's reopenedBy, and refuses one linked by neither", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "lo1");
    const other = await addClaim(h, "lo1-other");
    h.b.nextBlock(claim.revealDeadline + 10 - h.b.now());
    h.at(h.b.now());
    await h.apply({ ...h.b.envelope(REALITY), kind: "RealityNewAnswer", questionId: claim.questionId, answer: REALITY_ANSWERED_TOO_SOON, historyHash: `0x${"a7".repeat(32)}`, user: ALICE, bond: XDAI, ts: h.b.now(), isCommitment: false });
    h.b.nextBlock(TIMEOUT + 1);
    h.at(h.b.now());
    await h.fresh();
    const replacement = `0x${"7e".repeat(32)}` as Hex32;
    h.b.nextBlock();
    await h.apply({ ...h.b.envelope(REALITY), kind: "RealityQuestionReopened", questionId: replacement, reopenedQuestionId: claim.questionId });
    expect(await h.ctx.readModel.getOracleQuestion(claim.questionId)).toMatchObject({ reopenedBy: replacement });
    // The replacement's own record does not name the claim's question: the only link is the original's reopenedBy.
    const getOracleQuestion = h.ctx.readModel.getOracleQuestion.bind(h.ctx.readModel);
    vi.spyOn(h.ctx.readModel, "getOracleQuestion").mockImplementation(async (questionId): Promise<OracleQuestionRecord | null> => {
      const record = await getOracleQuestion(questionId);
      return record && questionId.toLowerCase() === replacement ? { ...record, reopens: null } : record;
    });
    h.chain.reopened.set(claim.questionId, replacement);
    const status = (account: string) => h.app.inject({ method: "GET", url: `/api/v1/markets/${claim.market}/oracle?account=${account}` });
    const accepted = await status(`0x${"1".padStart(40, "0")}`);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({ currentQuestionId: replacement, reopened: true });
    // Another indexed question that neither reopens the claim's question nor is named by its reopenedBy: refused.
    expect(await getOracleQuestion(other.questionId)).toMatchObject({ reopens: null });
    h.chain.reopened.set(claim.questionId, other.questionId);
    const refused = await status(`0x${"2".padStart(40, "0")}`);
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe("NOT_READY");
  });
});
