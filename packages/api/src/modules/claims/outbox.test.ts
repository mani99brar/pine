// Must stay the first import: serializes the memory-heavy claims test files (see test/lock.ts).
import "./test/lock.js";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Hex32 } from "@pine/shared/types";
import type { AuditEntry } from "../../contracts/app.js";
import { MemoryAuditLog } from "../../contracts/testing.js";
import { flushAudit, outboxInsert } from "./audit.js";
import { addOnChainClaim, claimCreatedLog, claimEventFor, createDraft, createPreview, documentWith, markFresh, newMarketLog, publish, useHarness, type Harness } from "./test/helpers.js";

// Audit atomicity (PRD-07 §3b with the flush design of §3, SEC-OPS-07): every audited claims write commits its entry to
// claims_audit_outbox together with the write; flushAudit records and then deletes each row, at the start of every job
// run and after each audited write. At-least-once: an audit outage never loses an entry.

const harnessOf = useHarness();

/** The frozen in-memory audit log with an outage switch: `failures` upcoming records throw, or all while `down`. */
class FlakyAudit extends MemoryAuditLog {
  failures = 0;
  down = false;
  onRecord: ((entry: AuditEntry) => void) | null = null;
  override async record(entry: AuditEntry): Promise<void> {
    this.onRecord?.(entry);
    if (this.down || this.failures > 0) {
      if (this.failures > 0) this.failures -= 1;
      throw new Error("audit store unavailable");
    }
    return super.record(entry);
  }
}

function flaky(h: Harness): FlakyAudit {
  const audit = new FlakyAudit(h.ctx.redact);
  h.ctx.audit = audit;
  return audit;
}

const outbox = async (h: Harness) => (await h.ctx.database.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM claims_audit_outbox"))[0]!.n;
const actionsOf = (audit: MemoryAuditLog, subjectId: string) => audit.entries.filter((entry) => entry.subjectId === subjectId).map((entry) => entry.action);
const job = (h: Harness, name: string) => h.module.jobs!.find((item) => item.name === name)!;
const reconcile = (h: Harness, signal = new AbortController().signal) => job(h, "claims.reconcile-publications").run(h.ctx, signal);
const integrity = (h: Harness) => job(h, "claims.verify-integrity").run(h.ctx, new AbortController().signal);
const submit = (h: Harness, id: string, txHash: string) => h.app.inject({ method: "POST", url: `/api/v1/publications/${id}/submitted`, headers: h.headers, payload: { txHash } });
const state = async (h: Harness, id: string) => (await h.ctx.database.sql.query<{ state: string }>("SELECT state FROM claim_publications WHERE id = $1", [id]))[0]!.state;

/** A published preview; `arm` runs after the draft and preview (whose audits are not outbox writes) and before the publish. */
async function planned(h: Harness, arm: () => void = () => {}) {
  const preview = await createPreview(h, (await createDraft(h)).id);
  arm();
  const response = await publish(h, preview);
  expect(response.statusCode).toBe(200);
  return { preview, id: response.json().publication.id as string, plan: response.json().plan as unknown };
}

describe("claims audit outbox (SEC-OPS-07)", () => {
  it("the audit gateway throws once at publication: the plan is returned, the row stays, and the next write records it exactly once", async () => {
    const h = harnessOf();
    const audit = new FlakyAudit(h.ctx.redact);
    const { preview, id, plan } = await planned(h, () => {
      h.ctx.audit = audit;
      audit.failures = 1;
    });
    expect(plan).not.toBeNull();
    expect(audit.entries).toEqual([]);
    expect(await outbox(h)).toBe(1);
    // A later write (the fake clock moved on, so created_at orders the pending row first).
    h.ctx.clock.advance(1000);
    const txHash = `0x${"a1".repeat(32)}`;
    expect((await submit(h, id, txHash)).statusCode).toBe(200);
    expect(actionsOf(audit, id)).toEqual(["claim.publication.created", "claim.publication.tx_reported", "claim.publication.submitted"]);
    // Recorded with its original actor, details and ip (details unchanged: no outbox id).
    expect(audit.entries[0]).toEqual({
      actorUserId: h.session.userId,
      action: "claim.publication.created",
      subjectType: "claim_publication",
      subjectId: id,
      details: { previewId: preview.previewId, documentSha256: preview.documentSha256, state: "planned" },
      ip: expect.any(String),
    });
    expect(await outbox(h)).toBe(0);
  });

  it("a same-key replay records an entry an outage left pending, exactly once", async () => {
    const h = harnessOf();
    const audit = new FlakyAudit(h.ctx.redact);
    const { preview, id, plan } = await planned(h, () => {
      h.ctx.audit = audit;
      audit.failures = 1;
    });
    expect(await outbox(h)).toBe(1);
    const replay = await publish(h, preview);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().plan).toEqual(plan);
    expect(actionsOf(audit, id)).toEqual(["claim.publication.created"]);
    expect(await outbox(h)).toBe(0);
    await publish(h, preview);
    expect(actionsOf(audit, id)).toEqual(["claim.publication.created"]);
  });

  it("a reconcile run with no open publication records a transition entry an outage left pending", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    addOnChainClaim(h.ctx, h.chain, preview.document, preview.documentSha256);
    const audit = flaky(h);
    audit.failures = 1;
    await reconcile(h);
    expect(await state(h, id)).toBe("confirmed");
    expect(actionsOf(audit, id)).toEqual([]);
    expect(await outbox(h)).toBe(1);
    const open = await h.ctx.database.sql.query("SELECT id FROM claim_publications WHERE state IN ('planned', 'submitted', 'mined')");
    expect(open).toEqual([]);
    await reconcile(h);
    expect(actionsOf(audit, id)).toEqual(["claim.publication.confirmed"]);
    expect(audit.entries[0]?.details).toMatchObject({ from: "planned", via: "reconcile" });
    expect(await outbox(h)).toBe(0);
    await reconcile(h);
    expect(actionsOf(audit, id)).toEqual(["claim.publication.confirmed"]);
  });

  it("an integrity verdict whose audit fails is recorded once by the next integrity run", async () => {
    const h = harnessOf();
    const { document, bytes, sha256 } = documentWith((doc) => void (doc.nonce = `0x${randomBytes(32).toString("hex")}` as Hex32));
    await h.ctx.contentStore.put({ bytes, declaredMediaType: "application/json", maxBytes: 262_144 });
    const event = addOnChainClaim(h.ctx, h.chain, document, sha256);
    const audit = flaky(h);
    audit.failures = 1;
    await integrity(h);
    const [row] = await h.ctx.database.sql.query<{ integrity_status: string }>("SELECT integrity_status FROM claims_index WHERE market = $1", [event.market]);
    expect(row?.integrity_status).toBe("verified");
    expect(audit.entries).toEqual([]);
    expect(await outbox(h)).toBe(1);
    await integrity(h);
    expect(audit.entries).toEqual([{ actorUserId: null, action: "claim.integrity.verified", subjectType: "claim", subjectId: event.market, details: { fields: [] }, ip: null }]);
    expect(await outbox(h)).toBe(0);
  });

  it("several pending entries for one publication all survive an outage and are each recorded once, in order, afterwards", async () => {
    const h = harnessOf();
    const audit = new FlakyAudit(h.ctx.redact);
    const { preview, id } = await planned(h, () => {
      h.ctx.audit = audit;
      audit.down = true;
    });
    h.ctx.clock.advance(1000);
    const event = claimEventFor(preview.document, preview.documentSha256);
    h.chain.receipts.set(event.transactionHash, { status: "success", logs: [claimCreatedLog(event), newMarketLog(event)] });
    expect((await submit(h, id, event.transactionHash)).statusCode).toBe(200);
    h.ctx.clock.advance(1000);
    // The succeeded hint only sets its own status (PRD-07 §3f): no transition, no entry.
    await reconcile(h);
    expect(await state(h, id)).toBe("submitted");
    h.ctx.clock.advance(1000);
    h.ctx.readModel.apply([event]);
    markFresh(h.ctx, event.blockNumber);
    await reconcile(h);
    expect(await state(h, id)).toBe("confirmed");
    expect(audit.entries).toEqual([]);
    expect(await outbox(h)).toBe(4);

    audit.down = false;
    await reconcile(h);
    const actions = actionsOf(audit, id);
    // tx_reported and submitted share one timestamp (one request): their relative order is not defined.
    expect(actions[0]).toBe("claim.publication.created");
    expect(new Set(actions.slice(1, 3))).toEqual(new Set(["claim.publication.tx_reported", "claim.publication.submitted"]));
    expect(actions.slice(3)).toEqual(["claim.publication.confirmed"]);
    expect(await outbox(h)).toBe(0);
  });

  it("an abort between entries stops the flush and leaves the unrecorded rows in the outbox", async () => {
    const h = harnessOf();
    const audit = new FlakyAudit(h.ctx.redact);
    const { id } = await planned(h, () => {
      h.ctx.audit = audit;
      audit.down = true;
    });
    expect((await submit(h, id, `0x${"b2".repeat(32)}`)).statusCode).toBe(200);
    expect(await outbox(h)).toBe(3);
    audit.down = false;
    const controller = new AbortController();
    audit.onRecord = () => controller.abort();
    await reconcile(h, controller.signal);
    expect(audit.entries).toHaveLength(1);
    expect(await outbox(h)).toBe(2);
    audit.onRecord = null;
    await reconcile(h);
    expect([...actionsOf(audit, id)].sort()).toEqual(["claim.publication.created", "claim.publication.submitted", "claim.publication.tx_reported"]);
    expect(await outbox(h)).toBe(0);
  });

  it("in-process concurrent flushes record each entry once (single flight per database handle)", async () => {
    const h = harnessOf();
    const audit = new FlakyAudit(h.ctx.redact);
    const { id } = await planned(h, () => {
      h.ctx.audit = audit;
      audit.down = true;
    });
    expect((await submit(h, id, `0x${"c3".repeat(32)}`)).statusCode).toBe(200);
    expect(await outbox(h)).toBe(3);
    audit.down = false;
    await Promise.all([flushAudit(h.ctx), flushAudit(h.ctx), flushAudit(h.ctx), reconcile(h)]);
    expect([...actionsOf(audit, id)].sort()).toEqual(["claim.publication.created", "claim.publication.submitted", "claim.publication.tx_reported"]);
    expect(await outbox(h)).toBe(0);
  });

  it("a flush requested while one runs waits for it and then flushes again (a row written meanwhile is recorded)", async () => {
    const h = harnessOf();
    const audit = flaky(h);
    const at = h.ctx.clock.now();
    const entry = (subjectId: string): AuditEntry => ({ actorUserId: null, action: "claim.test.entry", subjectType: "claim", subjectId, details: {}, ip: null });
    await outboxInsert(h.ctx.db, entry("first"), at);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let holding = true;
    const record = audit.record.bind(audit);
    audit.record = async (item) => {
      if (holding) {
        holding = false;
        entered();
        await held;
      }
      return record(item);
    };
    const running = flushAudit(h.ctx);
    // The running flush has read its batch and waits inside record(); a new row and a new flush request arrive.
    await inside;
    await outboxInsert(h.ctx.db, entry("second"), at);
    const again = flushAudit(h.ctx);
    release();
    await Promise.all([running, again]);
    expect(audit.entries.map((item) => item.subjectId)).toEqual(["first", "second"]);
    expect(await outbox(h)).toBe(0);
  });
});

// PRD-07 §3e: each audited write and its outbox row commit together. With the outbox INSERT refused (a CHECK constraint,
// NOT VALID so it binds only new rows), every audited write must leave the publication state, the hint status and the
// outbox exactly as they were. Each test fails if its outbox INSERT is moved out of the write's statement or transaction:
// the write would then commit and only the separate INSERT would fail. After the refusal is lifted the same step succeeds,
// which shows the refused run did reach the audited write.
describe("claims audit outbox atomicity (SEC-OPS-07, PRD-07 §3e)", () => {
  const REFUSAL = "claims_audit_outbox_refuse_test";

  /** Runs `body` while the outbox refuses new rows for which `check` is false (every row by default). */
  async function refusingOutbox(h: Harness, body: () => Promise<void>, check = "false"): Promise<void> {
    await h.ctx.database.sql.exec(`ALTER TABLE claims_audit_outbox ADD CONSTRAINT ${REFUSAL} CHECK (${check}) NOT VALID`);
    try {
      await body();
    } finally {
      await h.ctx.database.sql.exec(`ALTER TABLE claims_audit_outbox DROP CONSTRAINT ${REFUSAL}`);
    }
  }

  /** Publication states, hint statuses and pending outbox entries (what an audited claims write may change). */
  async function snapshot(h: Harness) {
    const query = <T extends Record<string, unknown>>(text: string) => h.ctx.database.sql.query<T>(text);
    return {
      publications: await query<{ id: string; state: string; market: string | null }>("SELECT id::text AS id, state, market FROM claim_publications ORDER BY id"),
      hints: await query<{ tx_hash: string; status: string }>("SELECT tx_hash, status FROM claim_publication_txs ORDER BY tx_hash"),
      outbox: await query<{ action: string; subject: string }>("SELECT entry->>'action' AS action, entry->>'subjectId' AS subject FROM claims_audit_outbox ORDER BY created_at, id"),
    };
  }

  const recorded = (h: Harness) => (h.ctx.audit as MemoryAuditLog).entries;
  const integrityOf = async (h: Harness, market: string) =>
    (
      await h.ctx.database.sql.query<{ integrity_status: string; final: boolean; attempts: number; last_error: string | null }>(
        "SELECT integrity_status, final, attempts::int AS attempts, last_error FROM claims_index WHERE market = $1",
        [market],
      )
    )[0];

  it("the publication insert: refused outbox row → 500, no publication row, outbox unchanged", async () => {
    const h = harnessOf();
    const preview = await createPreview(h, (await createDraft(h)).id);
    const before = await snapshot(h);
    await refusingOutbox(h, async () => {
      expect((await publish(h, preview)).statusCode).toBe(500);
      expect(await snapshot(h)).toEqual(before);
    });
    // (The draft and preview audits are direct, not outbox writes.)
    const publicationActions = () => recorded(h).map((entry) => entry.action).filter((action) => action.startsWith("claim.publication."));
    expect(publicationActions()).toEqual([]);
    // Without the refusal the same request creates the publication and its entry.
    expect((await publish(h, preview)).statusCode).toBe(200);
    expect(publicationActions()).toEqual(["claim.publication.created"]);
  });

  it("the tx_reported hint (CTE): refused outbox row → 500, no hint, state planned, outbox unchanged", async () => {
    const h = harnessOf();
    const { id } = await planned(h);
    const txHash = `0x${"d4".repeat(32)}`;
    const before = await snapshot(h);
    await refusingOutbox(h, async () => {
      expect((await submit(h, id, txHash)).statusCode).toBe(500);
      expect(await snapshot(h)).toEqual(before);
    });
    expect(actionsOf(h.ctx.audit as MemoryAuditLog, id)).toEqual(["claim.publication.created"]);
    expect((await submit(h, id, txHash)).statusCode).toBe(200);
    expect(actionsOf(h.ctx.audit as MemoryAuditLog, id)).toEqual(["claim.publication.created", "claim.publication.tx_reported", "claim.publication.submitted"]);
  });

  it("the submitted transition (CTE): with only its outbox row refused the hint is kept, the state stays planned and the outbox unchanged", async () => {
    const h = harnessOf();
    const { id } = await planned(h);
    const txHash = `0x${"e5".repeat(32)}`;
    const before = await snapshot(h);
    await refusingOutbox(
      h,
      async () => {
        expect((await submit(h, id, txHash)).statusCode).toBe(500);
        // The hint statement (with its own outbox row) committed and was flushed; the transition did not happen.
        expect(await snapshot(h)).toEqual({ ...before, hints: [{ tx_hash: txHash, status: "unknown" }] });
        expect(before.outbox).toEqual([]);
      },
      "(entry->>'action') <> 'claim.publication.submitted'",
    );
    expect(actionsOf(h.ctx.audit as MemoryAuditLog, id)).toEqual(["claim.publication.created", "claim.publication.tx_reported"]);
    // A same-hash replay without the refusal makes the transition and records its entry.
    expect((await submit(h, id, txHash)).statusCode).toBe(200);
    expect(await state(h, id)).toBe("submitted");
    expect(actionsOf(h.ctx.audit as MemoryAuditLog, id)).toEqual(["claim.publication.created", "claim.publication.tx_reported", "claim.publication.submitted"]);
  });

  it("the request-side mined transition (CTE): refused outbox row → 500, state planned, no market, outbox unchanged", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const event = claimEventFor(preview.document, preview.documentSha256);
    h.ctx.readModel.apply([event]);
    markFresh(h.ctx, event.blockNumber);
    const before = await snapshot(h);
    await refusingOutbox(h, async () => {
      expect((await publish(h, preview)).statusCode).toBe(500);
      expect(await snapshot(h)).toEqual(before);
    });
    expect(actionsOf(h.ctx.audit as MemoryAuditLog, id)).toEqual(["claim.publication.created"]);
    const retry = await publish(h, preview);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().plan).toBeNull();
    expect(await state(h, id)).toBe("mined");
    expect(actionsOf(h.ctx.audit as MemoryAuditLog, id)).toEqual(["claim.publication.created", "claim.publication.mined"]);
  });

  it("a final succeeded hint is not an audited write (the hint→mined transaction is gone, PRD-07 §3f): with the outbox refused it still becomes succeeded, state submitted, outbox unchanged", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const event = claimEventFor(preview.document, preview.documentSha256);
    h.chain.receipts.set(event.transactionHash, { status: "success", logs: [claimCreatedLog(event), newMarketLog(event)] });
    expect((await submit(h, id, event.transactionHash)).statusCode).toBe(200);
    const before = await snapshot(h);
    expect(before.hints).toEqual([{ tx_hash: event.transactionHash, status: "unknown" }]);
    await refusingOutbox(h, async () => {
      await reconcile(h);
      expect(await snapshot(h)).toEqual({ ...before, hints: [{ tx_hash: event.transactionHash, status: "succeeded" }] });
    });
    expect(before.publications).toEqual([{ id, state: "submitted", market: null }]);
    expect(actionsOf(h.ctx.audit as MemoryAuditLog, id)).toEqual(["claim.publication.created", "claim.publication.tx_reported", "claim.publication.submitted"]);
  });

  it("the reconcile confirmed transition (CTE): refused outbox row → state planned, no market, outbox unchanged", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const event = addOnChainClaim(h.ctx, h.chain, preview.document, preview.documentSha256);
    const before = await snapshot(h);
    await refusingOutbox(h, async () => {
      await reconcile(h);
      expect(await snapshot(h)).toEqual(before);
    });
    expect(actionsOf(h.ctx.audit as MemoryAuditLog, id)).toEqual(["claim.publication.created"]);
    await reconcile(h);
    expect(await snapshot(h)).toEqual({ publications: [{ id, state: "confirmed", market: event.market }], hints: [], outbox: [] });
    expect(actionsOf(h.ctx.audit as MemoryAuditLog, id)).toEqual(["claim.publication.created", "claim.publication.confirmed"]);
  });

  it("the integrity verdict (writeResult transaction): refused outbox row → the claim stays pending and not final, outbox unchanged", async () => {
    const h = harnessOf();
    const { document, bytes, sha256 } = documentWith((doc) => void (doc.nonce = `0x${randomBytes(32).toString("hex")}` as Hex32));
    await h.ctx.contentStore.put({ bytes, declaredMediaType: "application/json", maxBytes: 262_144 });
    const claim = addOnChainClaim(h.ctx, h.chain, document, sha256);
    await refusingOutbox(h, async () => {
      await integrity(h);
      // The verdict write rolled back; only the transient retry bookkeeping (attempts, last_error) was written.
      expect(await integrityOf(h, claim.market)).toMatchObject({ integrity_status: "pending", final: false, attempts: 1, last_error: expect.any(String) });
      expect(await outbox(h)).toBe(0);
    });
    expect(recorded(h)).toEqual([]);
    h.ctx.clock.advance(120_000);
    await integrity(h);
    expect(await integrityOf(h, claim.market)).toMatchObject({ integrity_status: "verified", final: true });
    expect(recorded(h).map((entry) => entry.action)).toEqual(["claim.integrity.verified"]);
    expect(await outbox(h)).toBe(0);
  });
});
