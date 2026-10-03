// Must stay the first import: serializes the memory-heavy claims test files (see test/lock.ts).
import "./test/lock.js";
import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ClaimCreatedEvent } from "@pine/shared/chain-events";
import type { Hex32 } from "@pine/shared/types";
import type { AuditEntry } from "../../contracts/app.js";
import { MemoryAuditLog } from "../../contracts/testing.js";
import { flushAudit, flushAuditInBackground, outboxInsert, outboxSelect, settledAudit } from "./audit.js";
import { sql } from "./db.js";
import {
  addOnChainClaim,
  claimCreatedLog,
  claimEventFor,
  createDraft,
  createPreview,
  documentWith,
  markFresh,
  markIndexedAt,
  newMarketLog,
  publish,
  rawInject,
  useHarness,
  type Harness,
} from "./test/helpers.js";

// PRD-07 §3f (SEC-IDX-01, SEC-IDX-06): every irreversible claims decision requires its block to be at or below
// F = status().finalizedBlock ?? chain finalizedBlock() (null on failure: no final decision). The harness default is
// native-like (finalized = indexedBlock); these tests set an Envio-like status (finalizedBlock null, so the chain's
// `finalized` block is asked) or a native status whose finalized block lies below the indexed block.

const harnessOf = useHarness();

const job = (h: Harness, name: string) => h.module.jobs!.find((item) => item.name === name)!;
const reconcile = (h: Harness) => job(h, "claims.reconcile-publications").run(h.ctx, new AbortController().signal);
const submit = (h: Harness, id: string, txHash: string) => h.app.inject({ method: "POST", url: `/api/v1/publications/${id}/submitted`, headers: h.headers, payload: { txHash } });
const row = async (h: Harness, id: string) =>
  (await h.ctx.database.sql.query<{ state: string; market: string | null }>("SELECT state, market FROM claim_publications WHERE id = $1", [id]))[0]!;
const hints = async (h: Harness, id: string) =>
  (await h.ctx.database.sql.query<{ tx_hash: string; status: string }>("SELECT tx_hash, status FROM claim_publication_txs WHERE publication_id = $1 ORDER BY tx_hash", [id])).map(
    (hint) => [hint.tx_hash, hint.status],
  );
const actionsOf = (h: Harness, id: string) => h.ctx.audit.entries.filter((entry) => entry.subjectId === id).map((entry) => entry.action);
const finalizedAt = (h: Harness, number: bigint, timestamps: [bigint, number][] = []) => {
  h.chain.finalized = { number, timestamps: new Map(timestamps) };
};

async function planned(h: Harness) {
  const preview = await createPreview(h, (await createDraft(h)).id);
  const response = await publish(h, preview);
  expect(response.statusCode).toBe(200);
  expect(response.json().plan).not.toBeNull();
  return { preview, id: response.json().publication.id as string };
}

function expectNotReady(response: { statusCode: number; headers: Record<string, unknown>; json(): { error: unknown; plan?: unknown } }) {
  expect(response.statusCode).toBe(503);
  expect(response.json().error).toMatchObject({ code: "NOT_READY", message: "the claim is being created on chain; retry when it is final" });
  expect(response.headers["retry-after"]).toBe("30");
  expect(response.json().plan).toBeUndefined();
}

describe("finality of claims decisions (PRD-07 §3f)", () => {
  it("reconcile confirmed: an Envio-like status (finalizedBlock null) with the claim above the chain's finalized block → not confirmed; at it → confirmed", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const event = addOnChainClaim(h.ctx, h.chain, preview.document, preview.documentSha256, { fresh: false });
    markFresh(h.ctx, event.blockNumber, { finalized: null });
    expect((await h.ctx.readModel.status()).finalizedBlock).toBeNull();
    finalizedAt(h, event.blockNumber - 1n);
    await reconcile(h);
    expect(h.chain.calls).toContain("eth_getBlockByNumber");
    expect(await row(h, id)).toEqual({ state: "planned", market: null });
    // A claim above F is not even checked against its receipt.
    expect(h.chain.receiptLookups).not.toContain(event.transactionHash.toLowerCase());
    expect(actionsOf(h, id)).toEqual(["claim.publication.created"]);
    finalizedAt(h, event.blockNumber);
    await reconcile(h);
    expect(await row(h, id)).toEqual({ state: "confirmed", market: event.market });
    expect(actionsOf(h, id)).toEqual(["claim.publication.created", "claim.publication.confirmed"]);
  });

  it("reconcile confirmed: a native status whose finalizedBlock lies below the claim is not final although indexedBlock covers it (indexedBlock is never finality)", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const event = addOnChainClaim(h.ctx, h.chain, preview.document, preview.documentSha256, { fresh: false });
    const indexed = markFresh(h.ctx, event.blockNumber, { finalized: event.blockNumber - 1n });
    expect(indexed).toBeGreaterThan(event.blockNumber);
    await reconcile(h);
    expect(await row(h, id)).toEqual({ state: "planned", market: null });
    // The read model's own finalized block is F: the chain is not asked.
    expect(h.chain.calls).not.toContain("eth_getBlockByNumber");
    markFresh(h.ctx, 0n, { finalized: event.blockNumber });
    await reconcile(h);
    expect(await row(h, id)).toEqual({ state: "confirmed", market: event.market });
  });

  it("request-path mined: an Envio-like status with the claim above F → 503 NOT_READY, state unchanged, no plan; at or below F → mined without a plan", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const event = addOnChainClaim(h.ctx, h.chain, preview.document, preview.documentSha256, { fresh: false });
    markFresh(h.ctx, event.blockNumber, { finalized: null });
    finalizedAt(h, event.blockNumber - 1n);
    expectNotReady(await publish(h, preview));
    expect(await row(h, id)).toEqual({ state: "planned", market: null });
    expect(actionsOf(h, id)).toEqual(["claim.publication.created"]);
    finalizedAt(h, event.blockNumber + 5n);
    const mined = await publish(h, preview);
    expect(mined.statusCode).toBe(200);
    expect(mined.json()).toMatchObject({ plan: null, publication: { state: "mined", market: event.market } });
    expect(actionsOf(h, id)).toEqual(["claim.publication.created", "claim.publication.mined"]);
  });

  it("request-path mined: a native status whose finalizedBlock lies below the indexed claim → 503 NOT_READY, not mined", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const event = addOnChainClaim(h.ctx, h.chain, preview.document, preview.documentSha256, { fresh: false });
    markFresh(h.ctx, event.blockNumber, { finalized: event.blockNumber - 1n });
    expectNotReady(await publish(h, preview));
    expect(await row(h, id)).toEqual({ state: "planned", market: null });
    expect(h.chain.calls).not.toContain("eth_getBlockByNumber");
  });

  it("a finalizedBlock() failure (Envio-like status) means no final decision: request 503 and reconcile leave the publication unchanged", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const event = addOnChainClaim(h.ctx, h.chain, preview.document, preview.documentSha256, { fresh: false });
    markFresh(h.ctx, event.blockNumber, { finalized: null });
    h.chain.finalized = "error";
    expectNotReady(await publish(h, preview));
    await reconcile(h);
    await reconcile(h);
    expect(await row(h, id)).toEqual({ state: "planned", market: null });
    expect(actionsOf(h, id)).toEqual(["claim.publication.created"]);
    // The node recovers: the same claim is now final.
    finalizedAt(h, event.blockNumber);
    await reconcile(h);
    expect(await row(h, id)).toEqual({ state: "confirmed", market: event.market });
  });

  it("hints: a succeeded or reverted receipt above F stays unknown even at or below indexedBlock (native and Envio-like F); at F both become final", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const event = claimEventFor(preview.document, preview.documentSha256);
    const receiptBlock = markFresh(h.ctx);
    // Native status: indexed one block past the receipts, finalized below them.
    markFresh(h.ctx, 0n, { finalized: receiptBlock - 1n });
    h.chain.receipts.set(event.transactionHash, { status: "success", logs: [claimCreatedLog(event), newMarketLog(event)], blockNumber: receiptBlock });
    const reverted = `0x${"9b".repeat(32)}` as Hex32;
    h.chain.receipts.set(reverted, { status: "reverted", logs: [], blockNumber: receiptBlock });
    await submit(h, id, event.transactionHash);
    await submit(h, id, reverted);
    await reconcile(h);
    expect(await hints(h, id)).toEqual([
      [event.transactionHash, "unknown"],
      [reverted, "unknown"],
    ]);
    // Envio-like: finalizedBlock null, the chain's finalized block still below the receipts.
    markFresh(h.ctx, 0n, { finalized: null });
    finalizedAt(h, receiptBlock - 1n);
    h.chain.receiptLookups.length = 0;
    await reconcile(h);
    expect(h.chain.receiptLookups).toEqual(expect.arrayContaining([event.transactionHash, reverted]));
    expect(await hints(h, id)).toEqual([
      [event.transactionHash, "unknown"],
      [reverted, "unknown"],
    ]);
    finalizedAt(h, receiptBlock);
    await reconcile(h);
    expect(await hints(h, id)).toEqual([
      [event.transactionHash, "succeeded"],
      [reverted, "reverted"],
    ]);
    // A hint only sets its own status.
    expect(await row(h, id)).toEqual({ state: "submitted", market: null });
  });

  it("a final succeeded receipt whose claim the read model does not serve → no plan (503 NOT_READY), not mined, by request or reconcile", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const event = claimEventFor(preview.document, preview.documentSha256);
    h.chain.receipts.set(event.transactionHash, { status: "success", logs: [claimCreatedLog(event), newMarketLog(event)] });
    await submit(h, id, event.transactionHash);
    await reconcile(h);
    expect(await hints(h, id)).toEqual([[event.transactionHash, "succeeded"]]);
    // The latest block does not show the market either (marketOf is zero in this script): the hint alone withholds the plan.
    expectNotReady(await publish(h, preview));
    await reconcile(h);
    expect(await row(h, id)).toEqual({ state: "submitted", market: null });
    expect(actionsOf(h, id)).not.toContain("claim.publication.mined");
  });

  it("expiry coverage counts only up to F: an Envio-like read model past the cutoff does not expire while block F is before it; F's block after it → expired", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const cutoff = preview.document.evidence.evidenceDeadline - 86_400;
    h.ctx.clock.set(new Date((cutoff + 6 * 3_600) * 1000));
    const indexed = markIndexedAt(h.ctx, cutoff + 3_600, { finalized: null });
    const bound = indexed - 5n;
    finalizedAt(h, bound, [[bound, cutoff - 60]]);
    await reconcile(h);
    await reconcile(h);
    expect(await row(h, id)).toEqual({ state: "planned", market: null });
    // F unknown: no decision.
    h.chain.finalized = "error";
    await reconcile(h);
    expect(await row(h, id)).toEqual({ state: "planned", market: null });
    // Block F exactly at the cutoff (createClaim still possible there): still open.
    finalizedAt(h, bound, [[bound, cutoff]]);
    await reconcile(h);
    expect(await row(h, id)).toEqual({ state: "planned", market: null });
    finalizedAt(h, bound, [[bound, cutoff + 1]]);
    await reconcile(h);
    expect(await row(h, id)).toEqual({ state: "expired", market: null });
    expect(actionsOf(h, id)).toEqual(["claim.publication.created", "claim.publication.expired"]);
  });

  it("expiry coverage with a native status whose finalized block lies below the indexed block uses block F's timestamp", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const cutoff = preview.document.evidence.evidenceDeadline - 86_400;
    h.ctx.clock.set(new Date((cutoff + 6 * 3_600) * 1000));
    const previous = markFresh(h.ctx);
    markIndexedAt(h.ctx, cutoff + 3_600, { finalized: previous });
    h.chain.finalized = { number: previous, timestamps: new Map([[previous, cutoff - 1]]) };
    await reconcile(h);
    expect(await row(h, id)).toEqual({ state: "planned", market: null });
    h.chain.finalized = { number: previous, timestamps: new Map([[previous, cutoff + 1]]) };
    await reconcile(h);
    expect(await row(h, id)).toEqual({ state: "expired", market: null });
  });
});

describe("request-path audit flush and outbox ids (PRD-07 §3f)", () => {
  /** Makes ctx.audit.record wait for `release` before recording; returns the release function. */
  function stuckAudit(h: Harness): () => void {
    let release: () => void = () => {};
    const stuck = new Promise<void>((resolve) => (release = resolve));
    const real = MemoryAuditLog.prototype.record;
    vi.spyOn(h.ctx.audit, "record").mockImplementation(async (entry) => {
      await stuck;
      await real.call(h.ctx.audit, entry);
    });
    return release;
  }

  async function withinFiveSeconds<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([work, new Promise<"delayed">((resolve) => (timer = setTimeout(() => resolve("delayed"), 5_000)))]);
      if (result === "delayed") throw new Error("the response waited for the audit store");
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  const outboxActions = async (h: Harness) =>
    (await h.ctx.database.sql.query<{ action: string }>("SELECT entry->>'action' AS action FROM claims_audit_outbox ORDER BY created_at, id")).map((item) => item.action);

  it("SEC-OPS-07 an audit store that never resolves does not delay POST /publications or POST /publications/:id/submitted", async () => {
    const h = harnessOf();
    const preview = await createPreview(h, (await createDraft(h)).id);
    const release = stuckAudit(h);
    let id: string;
    try {
      // Raw injects: the harness would otherwise wait for the request's flush.
      const created = await withinFiveSeconds(
        rawInject(h.app, { method: "POST", url: "/api/v1/publications", headers: h.headers, payload: { previewId: preview.previewId, documentSha256: preview.documentSha256 } }),
      );
      expect(created.statusCode).toBe(200);
      expect(created.json().plan).not.toBeNull();
      id = created.json().publication.id as string;
      const submitted = await withinFiveSeconds(rawInject(h.app, { method: "POST", url: `/api/v1/publications/${id}/submitted`, headers: h.headers, payload: { txHash: `0x${"5e".repeat(32)}` } }));
      expect(submitted.statusCode).toBe(200);
      expect(submitted.json().publication.state).toBe("submitted");
      // (The draft and preview audits are direct, not outbox writes.)
      expect(actionsOf(h, id)).toEqual([]);
      expect(new Set(await outboxActions(h))).toEqual(new Set(["claim.publication.created", "claim.publication.tx_reported", "claim.publication.submitted"]));
    } finally {
      release();
    }
    await settledAudit(h.ctx);
    expect([...actionsOf(h, id)].sort()).toEqual(["claim.publication.created", "claim.publication.submitted", "claim.publication.tx_reported"]);
    expect(await outboxActions(h)).toEqual([]);
  });

  const publishRaw = (h: Harness, preview: { previewId: string; documentSha256: string }) =>
    rawInject(h.app, { method: "POST", url: "/api/v1/publications", headers: h.headers, payload: { previewId: preview.previewId, documentSha256: preview.documentSha256 } });

  it("SEC-OPS-07 (PRD-07 §3g) an audit store that never resolves does not delay POST /publications for an existing row the final read model serves (the flush after the mined transition)", async () => {
    const h = harnessOf();
    // Planned and audited before the outage: in the request below only the mined transition writes an outbox row.
    const { preview, id } = await planned(h);
    expect(await outboxActions(h)).toEqual([]);
    const event = addOnChainClaim(h.ctx, h.chain, preview.document, preview.documentSha256);
    const release = stuckAudit(h);
    try {
      const mined = await withinFiveSeconds(publishRaw(h, preview));
      expect(mined.statusCode).toBe(200);
      expect(mined.json()).toMatchObject({ plan: null, publication: { state: "mined", market: event.market } });
      expect(actionsOf(h, id)).toEqual(["claim.publication.created"]);
      expect(await outboxActions(h)).toEqual(["claim.publication.mined"]);
    } finally {
      release();
    }
    await settledAudit(h.ctx);
    expect(actionsOf(h, id)).toEqual(["claim.publication.created", "claim.publication.mined"]);
    expect(await outboxActions(h)).toEqual([]);
  });

  it("SEC-OPS-07 (PRD-07 §3g) an audit store that never resolves does not delay a first POST /publications that the final read model moves to mined (both flush call sites)", async () => {
    const h = harnessOf();
    const preview = await createPreview(h, (await createDraft(h)).id);
    // The claim is final before the first request: one request inserts the row (created entry) and moves it to mined.
    const event = addOnChainClaim(h.ctx, h.chain, preview.document, preview.documentSha256);
    const release = stuckAudit(h);
    let id: string;
    try {
      const response = await withinFiveSeconds(publishRaw(h, preview));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ plan: null, publication: { state: "mined", market: event.market } });
      id = response.json().publication.id as string;
      expect(actionsOf(h, id)).toEqual([]);
      expect(new Set(await outboxActions(h))).toEqual(new Set(["claim.publication.created", "claim.publication.mined"]));
    } finally {
      release();
    }
    await settledAudit(h.ctx);
    expect([...actionsOf(h, id)].sort()).toEqual(["claim.publication.created", "claim.publication.mined"]);
    expect(await outboxActions(h)).toEqual([]);
  });

  it("harness rule: a claims test inject returns only after the flush its request started (a slow audit store), a raw inject does not wait", async () => {
    const h = harnessOf();
    const preview = await createPreview(h, (await createDraft(h)).id);
    const real = MemoryAuditLog.prototype.record;
    vi.spyOn(h.ctx.audit, "record").mockImplementation(async (entry) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await real.call(h.ctx.audit, entry);
    });
    const id = (await publish(h, preview)).json().publication.id as string;
    expect(actionsOf(h, id)).toEqual(["claim.publication.created"]);
    const raw = await rawInject(h.app, { method: "POST", url: `/api/v1/publications/${id}/submitted`, headers: h.headers, payload: { txHash: `0x${"6f".repeat(32)}` } });
    expect(raw.statusCode).toBe(200);
    expect(actionsOf(h, id)).toEqual(["claim.publication.created"]);
    await settledAudit(h.ctx);
    expect(actionsOf(h, id)).toEqual(["claim.publication.created", "claim.publication.tx_reported", "claim.publication.submitted"]);
  });

  it("SEC-OPS-07 a failing background flush never fails the response and is logged redacted", async () => {
    const h = harnessOf();
    // (The draft and preview audits are direct, not outbox writes: the failures start after them.)
    const preview = await createPreview(h, (await createDraft(h)).id);
    vi.spyOn(h.ctx.audit, "record").mockRejectedValue(new Error("audit store down"));
    const increment = h.ctx.metrics.increment.bind(h.ctx.metrics);
    vi.spyOn(h.ctx.metrics, "increment").mockImplementation((name, labels) => {
      if (name === "claims_audit_flush") throw new Error("metrics sink down token=test-secret-value");
      increment(name, labels);
    });
    // The request: its flush rejects (the metrics sink throws inside the drain), the response is still the plan.
    const response = await publish(h, preview);
    expect(response.statusCode).toBe(200);
    expect(response.json().plan).not.toBeNull();
    expect(await outboxActions(h)).toEqual(["claim.publication.created"]);
    // The same rejection reaches the logger only through the redactor.
    const error = vi.fn();
    flushAuditInBackground(h.ctx, { error } as unknown as FastifyBaseLogger);
    await settledAudit(h.ctx);
    expect(error).toHaveBeenCalledTimes(1);
    const [fields, message] = error.mock.calls[0] as [{ error: string }, string];
    expect(message).toBe("claims audit flush failed");
    expect(fields.error).toContain("metrics sink down");
    expect(fields.error).not.toContain("test-secret-value");
    expect(await outboxActions(h)).toEqual(["claim.publication.created"]);
  });

  it("a drain that rejects once never wedges later flushes (the single-flight entry is cleared on rejection too)", async () => {
    const h = harnessOf();
    const entry: AuditEntry = { actorUserId: null, action: "claim.test.entry", subjectType: "claim", subjectId: "wedge", details: {}, ip: null };
    await outboxInsert(h.ctx.db, entry, h.ctx.clock.now());
    vi.spyOn(h.ctx.audit, "record").mockRejectedValueOnce(new Error("audit store down"));
    const increment = h.ctx.metrics.increment.bind(h.ctx.metrics);
    // The drain's failure counters throw as well, so the drain itself rejects (an unexpected failure).
    vi.spyOn(h.ctx.metrics, "increment").mockImplementation(() => {
      throw new Error("metrics sink down");
    });
    await expect(flushAudit(h.ctx)).rejects.toThrow("metrics sink down");
    expect(await outboxActions(h)).toEqual(["claim.test.entry"]);
    vi.mocked(h.ctx.metrics.increment).mockImplementation(increment);
    await flushAudit(h.ctx);
    expect(h.ctx.audit.entries).toEqual([entry]);
    expect(await outboxActions(h)).toEqual([]);
  });

  it("outboxSelect gives each row of its source its own outbox id (a source returning two rows → two rows, two ids)", async () => {
    const h = harnessOf();
    const now = h.ctx.clock.now();
    const entry: AuditEntry = { actorUserId: null, action: "claim.test.entry", subjectType: "claim", subjectId: "two-rows", details: {}, ip: null };
    await h.ctx.db.execute(outboxSelect(entry, now, sql`(VALUES (1), (2)) AS source(n)`));
    await outboxInsert(h.ctx.db, { ...entry, subjectId: "single" }, now);
    const ids = await h.ctx.database.sql.query<{ id: string; subject: string }>("SELECT id::text AS id, entry->>'subjectId' AS subject FROM claims_audit_outbox ORDER BY subject");
    expect(ids.map((item) => item.subject)).toEqual(["single", "two-rows", "two-rows"]);
    expect(new Set(ids.map((item) => item.id)).size).toBe(3);
  });
});

describe("integrity finality (PRD-07 §3g, SEC-IDX-01)", () => {
  const integrity = (h: Harness) => job(h, "claims.verify-integrity").run(h.ctx, new AbortController().signal);

  /** An on-chain claim with a unique, stored document; the read model status is left as it is. */
  async function indexedClaim(h: Harness, event: Partial<ClaimCreatedEvent> = {}): Promise<ClaimCreatedEvent> {
    const { document, bytes, sha256 } = documentWith((doc) => void (doc.nonce = `0x${randomBytes(32).toString("hex")}` as Hex32));
    await h.ctx.contentStore.put({ bytes, declaredMediaType: "application/json", maxBytes: 262_144 });
    return addOnChainClaim(h.ctx, h.chain, document, sha256, { event, fresh: false });
  }

  const integrityOf = async (h: Harness, market: string) => {
    const [found] = await h.ctx.database.sql.query<{ integrity_status: string; final: boolean; attempts: number; last_error: string | null; next_ms: string | null }>(
      "SELECT integrity_status, final, attempts, last_error, (extract(epoch from next_attempt_at) * 1000)::bigint::text AS next_ms FROM claims_index WHERE market = $1",
      [market],
    );
    return { ...found!, delay: found!.next_ms === null ? null : (Number(found!.next_ms) - h.ctx.clock.now().getTime()) / 1000 };
  };

  it("an Envio-like status with the claims above the chain's finalized block → pending with backoff, no verdict; at or below F → verified and mismatch (one F per run)", async () => {
    const h = harnessOf();
    const good = await indexedClaim(h);
    const bad = await indexedClaim(h, { repositoryId: 427016915 });
    expect(bad.blockNumber).toBeGreaterThan(good.blockNumber);
    markFresh(h.ctx, 0n, { finalized: null });
    finalizedAt(h, good.blockNumber - 1n);
    await integrity(h);
    for (const event of [good, bad]) {
      expect(await integrityOf(h, event.market)).toMatchObject({ integrity_status: "pending", final: false, attempts: 1, last_error: "TransientError: claim creation not final", delay: 60 });
      expect(actionsOf(h, event.market)).toEqual([]);
    }
    // One bound for the whole run: the chain's finalized block is asked once for both claims; no receipt is fetched.
    expect(h.chain.calls.filter((call) => call === "eth_getBlockByNumber")).toHaveLength(1);
    expect(h.chain.receiptLookups).toEqual([]);

    // F at the first claim's block: it gets its verdict, the second (above F) stays pending.
    h.ctx.clock.advance(60_000);
    finalizedAt(h, good.blockNumber);
    await integrity(h);
    expect(await integrityOf(h, good.market)).toMatchObject({ integrity_status: "verified", final: true });
    expect(await integrityOf(h, bad.market)).toMatchObject({ integrity_status: "pending", final: false, attempts: 2, delay: 120 });
    expect(actionsOf(h, good.market)).toEqual(["claim.integrity.verified"]);
    expect(actionsOf(h, bad.market)).toEqual([]);

    h.ctx.clock.advance(120_000);
    finalizedAt(h, bad.blockNumber + 3n);
    await integrity(h);
    expect(await integrityOf(h, bad.market)).toMatchObject({ integrity_status: "mismatch", final: true });
    expect(actionsOf(h, bad.market)).toEqual(["claim.integrity.mismatch"]);
  });

  it("a native finalizedBlock below the claim (indexedBlock above it) and a finalizedBlock() failure keep the claim pending; at F → verified", async () => {
    const h = harnessOf();
    const event = await indexedClaim(h);
    const indexed = markFresh(h.ctx, 0n, { finalized: event.blockNumber - 1n });
    expect(indexed).toBeGreaterThan(event.blockNumber);
    await integrity(h);
    expect(await integrityOf(h, event.market)).toMatchObject({ integrity_status: "pending", final: false, attempts: 1, delay: 60 });
    // The read model's own finalized block is F: the chain is not asked.
    expect(h.chain.calls).not.toContain("eth_getBlockByNumber");

    h.ctx.clock.advance(60_000);
    markFresh(h.ctx, 0n, { finalized: null });
    h.chain.finalized = "error";
    await integrity(h);
    expect(h.chain.calls).toContain("eth_getBlockByNumber");
    expect(await integrityOf(h, event.market)).toMatchObject({ integrity_status: "pending", final: false, attempts: 2, delay: 120 });
    expect(actionsOf(h, event.market)).toEqual([]);

    h.ctx.clock.advance(120_000);
    markFresh(h.ctx, 0n, { finalized: event.blockNumber });
    await integrity(h);
    expect(await integrityOf(h, event.market)).toMatchObject({ integrity_status: "verified", final: true });
    expect(actionsOf(h, event.market)).toEqual(["claim.integrity.verified"]);
  });
});
