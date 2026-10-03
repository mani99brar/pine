// Must stay the first import: serializes the memory-heavy claims test files (see test/lock.ts).
import "./test/lock.js";
import { describe, expect, it } from "vitest";
import type { Address, Hex32 } from "@pine/shared/types";
import { MAX_RECEIPTS_PER_PUBLICATION } from "./reconcile.js";
import { addOnChainClaim, claimCreatedLog, claimEventFor, createDraft, createPreview, markFresh, markIndexedAt, newMarketLog, publish, useHarness, type Harness } from "./test/helpers.js";

const harnessOf = useHarness();
const OTHER = "0x0000000000000000000000000000000000000bad" as Address;

async function planned(h: Harness) {
  const preview = await createPreview(h, (await createDraft(h)).id);
  const body = (await publish(h, preview)).json() as { publication: { id: string } };
  return { preview, id: body.publication.id };
}

async function reconcile(h: Harness) {
  const job = h.module.jobs!.find((item) => item.name === "claims.reconcile-publications")!;
  await job.run(h.ctx, new AbortController().signal);
}

async function stateOf(h: Harness, id: string): Promise<{ state: string; market: string | null; transactions: { txHash: string; status: string }[] }> {
  return (await h.app.inject({ method: "GET", url: `/api/v1/publications/${id}`, headers: h.headers })).json().publication;
}

const submit = (h: Harness, id: string, txHash: string) => h.app.inject({ method: "POST", url: `/api/v1/publications/${id}/submitted`, headers: h.headers, payload: { txHash } });

/** Moves chain time (and read-model coverage) to `seconds`. */
function coverUntil(h: Harness, seconds: number) {
  h.ctx.clock.set(new Date(seconds * 1000));
  markFresh(h.ctx);
}

describe("claims.reconcile-publications", () => {
  it("confirms through the read model when the user reported nothing (crash before /submitted)", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const event = addOnChainClaim(h.ctx, h.chain, preview.document, preview.documentSha256);
    await reconcile(h);
    expect(await stateOf(h, id)).toMatchObject({ state: "confirmed", market: event.market });
    expect(h.ctx.audit.entries.filter((entry) => entry.action === "claim.publication.confirmed")).toHaveLength(1);
  });

  it("confirms when the user reported a different (replaced) hash", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    await submit(h, id, `0x${"aa".repeat(32)}`); // dropped/replaced: no receipt
    const event = addOnChainClaim(h.ctx, h.chain, preview.document, preview.documentSha256);
    await reconcile(h);
    expect(await stateOf(h, id)).toMatchObject({ state: "confirmed", market: event.market });
  });

  it("confirms when the user reported a reverted duplicate, and records the revert", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const reverted = `0x${"cc".repeat(32)}`;
    h.chain.receipts.set(reverted, { status: "reverted", logs: [] });
    await submit(h, id, reverted);
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("submitted");
    expect((await stateOf(h, id)).transactions).toEqual([expect.objectContaining({ txHash: reverted, status: "reverted" })]);
    addOnChainClaim(h.ctx, h.chain, preview.document, preview.documentSha256);
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("confirmed");
  });

  it("does not confirm a creation receipt whose log comes from the wrong creator or registry", async () => {
    const h = harnessOf();
    const wrongCreator = await planned(h);
    addOnChainClaim(h.ctx, h.chain, wrongCreator.preview.document, wrongCreator.preview.documentSha256, { logs: (event) => [claimCreatedLog(event, { creator: OTHER }), newMarketLog(event)] });
    const wrongRegistry = await planned(h);
    addOnChainClaim(h.ctx, h.chain, wrongRegistry.preview.document, wrongRegistry.preview.documentSha256, { logs: (event) => [claimCreatedLog(event, { address: OTHER }), newMarketLog(event)] });
    await reconcile(h);
    expect((await stateOf(h, wrongCreator.id)).state).toBe("planned");
    expect((await stateOf(h, wrongRegistry.id)).state).toBe("planned");

    // A reported hash with a successful receipt from the wrong registry is not "mined" either.
    const hinted = await planned(h);
    const fake = claimEventFor(hinted.preview.document, hinted.preview.documentSha256);
    h.chain.receipts.set(fake.transactionHash, { status: "success", logs: [claimCreatedLog(fake, { address: OTHER })] });
    await submit(h, hinted.id, fake.transactionHash);
    await reconcile(h);
    expect((await stateOf(h, hinted.id)).state).toBe("submitted");
    // Final for that hash: recorded as unrelated and never fetched again.
    expect((await stateOf(h, hinted.id)).transactions).toEqual([expect.objectContaining({ txHash: fake.transactionHash, status: "unrelated" })]);
    h.chain.receiptLookups.length = 0;
    await reconcile(h);
    expect(h.chain.receiptLookups).not.toContain(fake.transactionHash);

    // Even after coverage passes, an indexed claim that cannot be confirmed is never expired.
    coverUntil(h, wrongCreator.preview.document.evidence.evidenceDeadline - 86_400 + 1);
    await reconcile(h);
    expect((await stateOf(h, wrongCreator.id)).state).toBe("planned");
  });

  it("a successful reported hash with the expected log moves to mined (still not final), then confirmed once indexed", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const event = claimEventFor(preview.document, preview.documentSha256);
    h.chain.receipts.set(event.transactionHash, { status: "success", logs: [claimCreatedLog(event), newMarketLog(event)] });
    await submit(h, id, event.transactionHash);
    await reconcile(h);
    expect(await stateOf(h, id)).toMatchObject({ state: "mined", market: event.market });
    h.ctx.readModel.apply([event]);
    markFresh(h.ctx, event.blockNumber);
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("confirmed");
  });

  it("expires only after read-model coverage passes evidenceDeadline - 1 day", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const cutoff = preview.document.evidence.evidenceDeadline - 86_400;
    coverUntil(h, cutoff - 3_600);
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("planned");
    coverUntil(h, cutoff); // createClaim is still possible at exactly this time
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("planned");
    // The chain head alone is not enough: a halted read model never expires anything.
    coverUntil(h, cutoff + 1);
    h.ctx.readModel.setHalted(true);
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("planned");
    h.ctx.readModel.setHalted(false);
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("expired");
    expect(h.ctx.audit.entries.map((entry) => entry.action)).toContain("claim.publication.expired");
  });

  it("a reverted transaction ends as failed once coverage passes, never before", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const reverted = `0x${"dd".repeat(32)}` as Hex32;
    h.chain.receipts.set(reverted, { status: "reverted", logs: [] });
    await submit(h, id, reverted);
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("submitted");
    coverUntil(h, preview.document.evidence.evidenceDeadline - 86_400 + 1);
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("failed");
  });

  it("keeps the publication open while a receipt cannot be fetched", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const hash = `0x${"ee".repeat(32)}`;
    h.chain.receipts.set(hash, "error");
    await submit(h, id, hash);
    coverUntil(h, preview.document.evidence.evidenceDeadline - 86_400 + 1);
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("submitted");
  });

  it("concurrent runs apply each transition once", async () => {
    const h = harnessOf();
    const first = await planned(h);
    const second = await planned(h);
    addOnChainClaim(h.ctx, h.chain, first.preview.document, first.preview.documentSha256);
    addOnChainClaim(h.ctx, h.chain, second.preview.document, second.preview.documentSha256);
    await Promise.all([reconcile(h), reconcile(h), reconcile(h)]);
    expect((await stateOf(h, first.id)).state).toBe("confirmed");
    expect((await stateOf(h, second.id)).state).toBe("confirmed");
    expect(h.ctx.audit.entries.filter((entry) => entry.action === "claim.publication.confirmed")).toHaveLength(2);
    await reconcile(h);
    expect(h.ctx.audit.entries.filter((entry) => entry.action === "claim.publication.confirmed")).toHaveLength(2);
  });
});

describe("claims.reconcile-publications audit (claims-006)", () => {
  const auditsOf = (h: Harness, id: string) => h.ctx.audit.entries.filter((entry) => entry.subjectType === "claim_publication" && entry.subjectId === id);

  it("every reconcile transition writes its audit entry once: mined, confirmed, failed, expired", async () => {
    const h = harnessOf();
    // mined (reported hash with the expected log), then confirmed once indexed.
    const minedThenConfirmed = await planned(h);
    const event = claimEventFor(minedThenConfirmed.preview.document, minedThenConfirmed.preview.documentSha256);
    h.chain.receipts.set(event.transactionHash, { status: "success", logs: [claimCreatedLog(event), newMarketLog(event)] });
    await submit(h, minedThenConfirmed.id, event.transactionHash);
    // failed (a reverted reported hash), expired (nothing reported).
    const failed = await planned(h);
    const reverted = `0x${"fa".repeat(32)}` as Hex32;
    h.chain.receipts.set(reverted, { status: "reverted", logs: [] });
    await submit(h, failed.id, reverted);
    const expired = await planned(h);

    await reconcile(h);
    expect(auditsOf(h, minedThenConfirmed.id).map((entry) => entry.action)).toContain("claim.publication.mined");
    expect(auditsOf(h, minedThenConfirmed.id).find((entry) => entry.action === "claim.publication.mined")?.details).toMatchObject({
      via: "reconcile",
      from: "submitted",
      market: event.market,
      txHash: event.transactionHash,
    });
    h.ctx.readModel.apply([event]);
    markFresh(h.ctx, event.blockNumber);
    await reconcile(h);
    expect(auditsOf(h, minedThenConfirmed.id).find((entry) => entry.action === "claim.publication.confirmed")?.details).toMatchObject({ via: "reconcile", from: "mined", market: event.market });

    coverUntil(h, failed.preview.document.evidence.evidenceDeadline - 86_400 + 1);
    await reconcile(h);
    await reconcile(h);
    expect((await stateOf(h, failed.id)).state).toBe("failed");
    expect((await stateOf(h, expired.id)).state).toBe("expired");
    expect(auditsOf(h, failed.id).filter((entry) => entry.action === "claim.publication.failed")).toEqual([
      expect.objectContaining({ actorUserId: null, details: expect.objectContaining({ via: "reconcile", from: "submitted", reason: "reverted" }) }),
    ]);
    expect(auditsOf(h, expired.id).filter((entry) => entry.action === "claim.publication.expired")).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ via: "reconcile", from: "planned" }) }),
    ]);
    for (const id of [minedThenConfirmed.id, failed.id, expired.id]) {
      const actions = auditsOf(h, id).map((entry) => entry.action);
      expect(new Set(actions).size, id).toBe(actions.length);
    }
  });
});

describe("claims.reconcile-publications stored revert facts (claims-007, PRD-03 §8b)", () => {
  const SECRET = "https://rpc.example/secret-key";

  it("a reverted receipt stores only its status (fixed text), never free text from RPC errors or revert data", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const reverted = `0x${"d1".repeat(32)}` as Hex32;
    const failing = `0x${"d2".repeat(32)}` as Hex32;
    // Revert data and log payloads carrying text, and an RPC error message carrying a URL with a key.
    const revertText = `0x${Buffer.from(`execution reverted: ${SECRET}`, "utf8").toString("hex")}` as `0x${string}`;
    h.chain.receipts.set(reverted, { status: "reverted", logs: [{ address: OTHER, topics: [`0x${"ab".repeat(32)}` as Hex32], data: revertText }] });
    h.chain.receipts.set(failing, Object.assign(new Error(`execution reverted: ${SECRET}`), { data: revertText }));
    await submit(h, id, reverted);
    await submit(h, id, failing);
    await reconcile(h);
    const txs = await h.ctx.database.sql.query<{ tx_hash: string; status: string; reason: string | null }>(
      "SELECT tx_hash, status, reason FROM claim_publication_txs WHERE publication_id = $1 ORDER BY tx_hash",
      [id],
    );
    expect(txs).toEqual([
      { tx_hash: reverted, status: "reverted", reason: "transaction reverted" },
      { tx_hash: failing, status: "unknown", reason: null },
    ]);
    // The failing receipt keeps it open; once the node no longer knows that hash and coverage passes, it fails.
    h.chain.receipts.delete(failing);
    coverUntil(h, preview.document.evidence.evidenceDeadline - 86_400 + 1);
    await reconcile(h);
    const [row] = await h.ctx.database.sql.query<{ state: string; failure_reason: string | null }>("SELECT state, failure_reason FROM claim_publications WHERE id = $1", [id]);
    expect(row).toEqual({ state: "failed", failure_reason: "transaction reverted" });
    const everything = JSON.stringify({
      txs: await h.ctx.database.sql.query("SELECT * FROM claim_publication_txs"),
      publications: await h.ctx.database.sql.query("SELECT * FROM claim_publications"),
      audit: h.ctx.audit.entries,
      api: (await h.app.inject({ method: "GET", url: `/api/v1/publications/${id}`, headers: h.headers })).body,
    });
    expect(everything).not.toContain("secret-key");
    expect(everything).not.toContain("execution reverted");
  });
});

describe("claims.reconcile-publications coverage and hint bounds (claims-009, PRD-03 §8c)", () => {
  const hash = (byte: string) => `0x${byte.repeat(32)}` as Hex32;

  it("expiry is decided from read-model coverage, not the chain head", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const cutoff = preview.document.evidence.evidenceDeadline - 86_400;
    // The chain head (clock) is hours past the cutoff, but the finalized read model (not halted) still covers only
    // blocks before it: a createClaim mined just before the cutoff may not be indexed yet.
    h.ctx.clock.set(new Date((cutoff + 6 * 3_600) * 1000));
    markIndexedAt(h.ctx, cutoff - 60);
    expect((await h.ctx.readModel.status()).halted).toBe(false);
    await reconcile(h);
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("planned");
    expect(h.ctx.audit.entries.map((entry) => entry.action)).not.toContain("claim.publication.expired");
    // Coverage reaches exactly the cutoff (createClaim still possible there): still open.
    markIndexedAt(h.ctx, cutoff);
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("planned");
    // Coverage passes the cutoff: expired.
    markIndexedAt(h.ctx, cutoff + 1);
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("expired");
  });

  it("never expires or fails a publication once a recorded hash has a successful matching receipt, even after coverage passed", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const reverted = hash("d3");
    h.chain.receipts.set(reverted, { status: "reverted", logs: [] });
    await submit(h, id, reverted);
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("submitted");
    // The successful replacement is reported, but its claim never reaches the read model (e.g. reorged out later).
    const event = claimEventFor(preview.document, preview.documentSha256);
    h.chain.receipts.set(event.transactionHash, { status: "success", logs: [claimCreatedLog(event), newMarketLog(event)] });
    await submit(h, id, event.transactionHash);
    coverUntil(h, preview.document.evidence.evidenceDeadline - 86_400 + 1);
    await reconcile(h);
    expect(await stateOf(h, id)).toMatchObject({ state: "mined", market: event.market });
    // Later runs, with coverage far past the cutoff and a reverted hash on record: still mined, never failed/expired.
    for (const at of [preview.document.evidence.evidenceDeadline, preview.document.evidence.revealDeadline + 86_400]) {
      coverUntil(h, at);
      await reconcile(h);
      await reconcile(h);
      expect((await stateOf(h, id)).state).toBe("mined");
    }
    const transactions = (await stateOf(h, id)).transactions;
    expect(transactions).toHaveLength(2);
    expect(transactions).toEqual(
      expect.arrayContaining([expect.objectContaining({ txHash: reverted, status: "reverted" }), expect.objectContaining({ txHash: event.transactionHash, status: "succeeded" })]),
    );
    const actions = h.ctx.audit.entries.map((entry) => entry.action);
    expect(actions).not.toContain("claim.publication.failed");
    expect(actions).not.toContain("claim.publication.expired");
  });

  it(`fetches receipts only for hints still unknown, at most ${MAX_RECEIPTS_PER_PUBLICATION} per publication per run, least recently checked first`, async () => {
    const h = harnessOf();
    expect(MAX_RECEIPTS_PER_PUBLICATION).toBe(5);
    const { preview, id } = await planned(h);
    const reverted = hash("e1");
    h.chain.receipts.set(reverted, { status: "reverted", logs: [] });
    await submit(h, id, reverted);
    // Seven hashes the node does not know (no receipt), reported one second apart.
    const missing = ["e2", "e3", "e4", "e5", "e6", "e7", "e8"].map(hash);
    for (const txHash of missing) {
      h.ctx.clock.advance(1000);
      await submit(h, id, txHash);
    }
    markFresh(h.ctx);
    const lookupsOf = async () => {
      h.ctx.clock.advance(30_000);
      h.chain.receiptLookups.length = 0;
      await reconcile(h);
      return [...h.chain.receiptLookups];
    };
    expect(await lookupsOf()).toEqual([reverted, ...missing.slice(0, 4)]);
    // The reverted hint is never fetched again; never-checked hints first, then the least recently checked.
    expect(await lookupsOf()).toEqual([...missing.slice(4), missing[0], missing[1]]);
    expect(await lookupsOf()).toEqual([missing[2], missing[3], missing[0], missing[1], missing[4]]);

    // Coverage passes the cutoff. Hints looked up before it do not count: expiry waits until every unknown hint was
    // looked up after the cutoff, which takes two runs at five lookups per run.
    coverUntil(h, preview.document.evidence.evidenceDeadline - 86_400 + 1);
    const third = await lookupsOf();
    expect(third).toHaveLength(5);
    expect(third).not.toContain(reverted);
    expect((await stateOf(h, id)).state).toBe("submitted");
    const fourth = await lookupsOf();
    expect(fourth).not.toContain(reverted);
    expect(new Set([...third, ...fourth])).toEqual(new Set(missing));
    expect((await stateOf(h, id)).state).toBe("failed");
  });
});

describe("claims.reconcile-publications hint finality and lost successes (claims-010, PRD-03 §8d)", () => {
  const coveredBlock = async (h: Harness) => (await h.ctx.readModel.status()).indexedBlock;

  it("a hint's receipt counts only at or below the read model's covered block; a newer one stays unknown and is fetched again", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const event = claimEventFor(preview.document, preview.documentSha256);
    const above = (await coveredBlock(h)) + 50n;
    h.chain.receipts.set(event.transactionHash, { status: "success", logs: [claimCreatedLog(event), newMarketLog(event)], blockNumber: above });
    await submit(h, id, event.transactionHash);
    // A reverted receipt above the covered block is not final either (a reorg may still include a successful one).
    const revertedAbove = `0x${"9a".repeat(32)}` as Hex32;
    h.chain.receipts.set(revertedAbove, { status: "reverted", logs: [], blockNumber: above });
    await submit(h, id, revertedAbove);
    await reconcile(h);
    expect(await stateOf(h, id)).toMatchObject({ state: "submitted", market: null });
    expect((await stateOf(h, id)).transactions.map((tx) => tx.status)).toEqual(["unknown", "unknown"]);
    // Still above coverage on the next run: fetched again, still not counted.
    h.chain.receiptLookups.length = 0;
    await reconcile(h);
    expect(h.chain.receiptLookups).toEqual(expect.arrayContaining([event.transactionHash, revertedAbove]));
    expect((await stateOf(h, id)).state).toBe("submitted");
    // Coverage reaches the receipts' block: the success counts.
    markFresh(h.ctx, above);
    await reconcile(h);
    expect(await stateOf(h, id)).toMatchObject({ state: "mined", market: event.market });
  });

  it("an unknown hint above the covered block holds back expiry after the cutoff", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const event = claimEventFor(preview.document, preview.documentSha256);
    h.chain.receipts.set(event.transactionHash, { status: "success", logs: [claimCreatedLog(event), newMarketLog(event)], blockNumber: (await coveredBlock(h)) + 1_000_000n });
    await submit(h, id, event.transactionHash);
    coverUntil(h, preview.document.evidence.evidenceDeadline - 86_400 + 1);
    await reconcile(h);
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("submitted");
  });

  it("a mined publication whose recorded success disappears returns to the plan-able state and a retry gets a plan again", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const event = claimEventFor(preview.document, preview.documentSha256);
    h.chain.receipts.set(event.transactionHash, { status: "success", logs: [claimCreatedLog(event), newMarketLog(event)] });
    await submit(h, id, event.transactionHash);
    await reconcile(h);
    expect(await stateOf(h, id)).toMatchObject({ state: "mined", market: event.market });
    // A mined publication offers no plan.
    expect((await publish(h, preview)).json().plan).toBeNull();
    // The receipt is no longer returned (e.g. the transaction was reorged out).
    h.chain.receipts.delete(event.transactionHash);
    await reconcile(h);
    expect(await stateOf(h, id)).toMatchObject({ state: "submitted", market: null, transactions: [expect.objectContaining({ txHash: event.transactionHash, status: "unknown" })] });
    const reopened = h.ctx.audit.entries.filter((entry) => entry.subjectId === id && entry.action === "claim.publication.reopened");
    expect(reopened).toHaveLength(1);
    expect(reopened[0]?.details).toMatchObject({ from: "mined", to: "submitted", via: "reconcile" });
    const retry = await publish(h, preview);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().plan).not.toBeNull();
    // The hint is fetched again later; if it comes back (re-included), it counts again.
    h.chain.receipts.set(event.transactionHash, { status: "success", logs: [claimCreatedLog(event), newMarketLog(event)] });
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("mined");
  });

  it("a request-side mined publication whose on-chain market disappears returns to planned", async () => {
    const h = harnessOf();
    const { preview, id } = await planned(h);
    const key = `${h.session.wallet.toLowerCase()}|${preview.documentSha256}`;
    h.chain.markets.set(key, "0x00000000000000000000000000000000000ca1e6" as Address);
    expect((await publish(h, preview)).json()).toMatchObject({ plan: null, publication: { state: "mined" } });
    // Still on chain: stays mined.
    await reconcile(h);
    expect((await stateOf(h, id)).state).toBe("mined");
    h.chain.markets.delete(key);
    await reconcile(h);
    expect(await stateOf(h, id)).toMatchObject({ state: "planned", market: null });
    expect((await publish(h, preview)).json().plan).not.toBeNull();
  });
});
