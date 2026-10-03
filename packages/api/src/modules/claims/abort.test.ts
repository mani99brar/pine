// Must stay the first import: serializes the memory-heavy claims test files (see test/lock.ts).
import "./test/lock.js";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ClaimCreatedEvent } from "@pine/shared/chain-events";
import type { Hex32 } from "@pine/shared/types";
import { discoverClaims, DISCOVERY_PAGE } from "./integrity.js";
import { addOnChainClaim, createDraft, createPreview, documentWith, publish, useHarness, type Harness } from "./test/helpers.js";

// Cooperative abort of the claims jobs (PRD-07 §3b, PRD-02 §2.5): each job checks `signal.aborted` between items and stops
// without starting the next one. "Before": the signal is aborted before the run. "During": a fake aborts it while the
// first item is being processed; that item completes, the second is untouched.

const harnessOf = useHarness();

const jobOf = (h: Harness, name: string) => h.module.jobs!.find((item) => item.name === name)!;

/** Wraps a read-model method so that its first call aborts `controller` (the call itself still answers). */
function abortOnFirstCall<K extends "listClaims" | "getClaim">(h: Harness, method: K, controller: AbortController): { calls: () => number } {
  const readModel = h.ctx.readModel;
  const original = readModel[method].bind(readModel) as (...args: unknown[]) => Promise<unknown>;
  let calls = 0;
  (readModel as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    calls += 1;
    if (calls === 1) controller.abort();
    return original(...args);
  };
  return { calls: () => calls };
}

async function storedClaim(h: Harness): Promise<ClaimCreatedEvent> {
  const { document, bytes, sha256 } = documentWith((doc) => void (doc.nonce = `0x${randomBytes(32).toString("hex")}` as Hex32));
  await h.ctx.contentStore.put({ bytes, declaredMediaType: "application/json", maxBytes: 262_144 });
  return addOnChainClaim(h.ctx, h.chain, document, sha256);
}

type IndexRow = { market: string; integrity_status: string; attempts: number; parameters_valid: boolean | null };
const indexRows = async (h: Harness) =>
  new Map((await h.ctx.database.sql.query<IndexRow>("SELECT market, integrity_status, attempts, parameters_valid FROM claims_index")).map((row) => [row.market, row]));

describe("claims.reconcile-publications cooperative abort", () => {
  async function twoIndexedPublications(h: Harness) {
    const ids: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const preview = await createPreview(h, (await createDraft(h)).id);
      ids.push((await publish(h, preview)).json().publication.id as string);
      addOnChainClaim(h.ctx, h.chain, preview.document, preview.documentSha256);
    }
    return ids;
  }
  const publications = async (h: Harness) =>
    h.ctx.database.sql.query<{ id: string; state: string; reconciled: boolean }>("SELECT id::text AS id, state, reconciled_at IS NOT NULL AS reconciled FROM claim_publications ORDER BY id");

  it("aborted before the run: no publication is touched", async () => {
    const h = harnessOf();
    await twoIndexedPublications(h);
    const controller = new AbortController();
    controller.abort();
    await jobOf(h, "claims.reconcile-publications").run(h.ctx, controller.signal);
    expect((await publications(h)).map((row) => [row.state, row.reconciled])).toEqual([
      ["planned", false],
      ["planned", false],
    ]);
    expect(h.ctx.audit.entries.map((entry) => entry.action)).not.toContain("claim.publication.confirmed");
  });

  it("aborted during the first publication: it completes, the second is untouched", async () => {
    const h = harnessOf();
    await twoIndexedPublications(h);
    const controller = new AbortController();
    const spy = abortOnFirstCall(h, "listClaims", controller);
    await jobOf(h, "claims.reconcile-publications").run(h.ctx, controller.signal);
    expect(spy.calls()).toBe(1);
    const rows = await publications(h);
    // Open rows are taken by (reconciled_at NULLS FIRST, id): the first by id was reconciled, the second never started.
    expect(rows.map((row) => [row.state, row.reconciled])).toEqual([
      ["confirmed", true],
      ["planned", false],
    ]);
  });
});

describe("claims.verify-integrity cooperative abort", () => {
  it("aborted before the run: nothing is discovered and no pending row is verified", async () => {
    const h = harnessOf();
    const known = await storedClaim(h);
    expect(await discoverClaims(h.ctx)).toBe(1);
    const unknown = await storedClaim(h);
    const controller = new AbortController();
    controller.abort();
    await expect(jobOf(h, "claims.verify-integrity").run(h.ctx, controller.signal)).rejects.toThrow("aborted");
    const index = await indexRows(h);
    expect(index.has(unknown.market)).toBe(false);
    expect(index.get(known.market)).toMatchObject({ integrity_status: "pending", attempts: 0 });
  });

  it("discovery aborted during the first page: the next page is never read and nothing is inserted", async () => {
    const h = harnessOf();
    for (let index = 0; index < DISCOVERY_PAGE + 1; index += 1) await storedClaim(h);
    const controller = new AbortController();
    const spy = abortOnFirstCall(h, "listClaims", controller);
    await expect(jobOf(h, "claims.verify-integrity").run(h.ctx, controller.signal)).rejects.toThrow("aborted");
    expect(spy.calls()).toBe(1);
    expect((await indexRows(h)).size).toBe(0);
  });

  it("verification aborted during the first claim: it completes, the second stays pending and unattempted", async () => {
    const h = harnessOf();
    const first = await storedClaim(h);
    const second = await storedClaim(h);
    expect(await discoverClaims(h.ctx)).toBe(2);
    const controller = new AbortController();
    const spy = abortOnFirstCall(h, "getClaim", controller);
    await jobOf(h, "claims.verify-integrity").run(h.ctx, controller.signal);
    expect(spy.calls()).toBe(1);
    const index = await indexRows(h);
    // Oldest first: the first claim was verified, the second never started.
    expect(index.get(first.market)).toMatchObject({ integrity_status: "verified", attempts: 1 });
    expect(index.get(second.market)).toMatchObject({ integrity_status: "pending", attempts: 0 });
  });

  it("the parameters backfill aborted during the first row: it completes, the second stays unchecked", async () => {
    const h = harnessOf();
    const first = await storedClaim(h);
    const second = await storedClaim(h);
    await jobOf(h, "claims.verify-integrity").run(h.ctx, new AbortController().signal);
    // Verified rows indexed before parameters_valid existed.
    await h.ctx.database.sql.exec("UPDATE claims_index SET parameters_valid = NULL");
    const controller = new AbortController();
    const spy = abortOnFirstCall(h, "getClaim", controller);
    await jobOf(h, "claims.verify-integrity").run(h.ctx, controller.signal);
    expect(spy.calls()).toBe(1);
    const index = await indexRows(h);
    expect(index.get(first.market)).toMatchObject({ integrity_status: "verified", parameters_valid: true });
    expect(index.get(second.market)).toMatchObject({ integrity_status: "verified", parameters_valid: null });
  });
});
