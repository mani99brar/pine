// Must stay the first import: serializes the memory-heavy claims test files (see test/lock.ts).
import "./test/lock.js";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalBytes, sha256Hex, type JsonValue } from "@pine/shared/canonical";
import type { ClaimDocument } from "@pine/shared/claim-document";
import { renderQuestion } from "@pine/shared/question";
import type { ClaimCreatedEvent } from "@pine/shared/chain-events";
import type { Address, Hex32 } from "@pine/shared/types";
import { addOnChainClaim, claimCreatedLog, documentWith, markFresh, newMarketLog, useHarness, type Harness, type RawLog } from "./test/helpers.js";

const harnessOf = useHarness();
const OTHER = "0x0000000000000000000000000000000000000bad" as Address;

async function runIntegrity(h: Harness): Promise<void> {
  const job = h.module.jobs!.find((item) => item.name === "claims.verify-integrity")!;
  await job.run(h.ctx, new AbortController().signal);
}

type IndexState = {
  market: string;
  integrity_status: string;
  mismatch_fields: string[];
  final: boolean;
  repository_id: string;
};

async function indexOf(h: Harness): Promise<Map<string, IndexState>> {
  const rows = await h.ctx.database.sql.query<IndexState>("SELECT market, integrity_status, mismatch_fields, final, repository_id::text AS repository_id FROM claims_index");
  return new Map(rows.map((row) => [row.market, row]));
}

/** A fresh document (unique nonce), stored locally unless `store` is false. */
async function storedDocument(h: Harness, mutate: (document: ClaimDocument) => void = () => {}, store = true) {
  const result = documentWith((document) => {
    document.nonce = `0x${randomBytes(32).toString("hex")}` as Hex32;
    mutate(document);
  });
  if (store) await h.ctx.contentStore.put({ bytes: result.bytes, declaredMediaType: "application/json", maxBytes: 262_144 });
  return result;
}

async function claimWith(h: Harness, options: { mutate?: (document: ClaimDocument) => void; event?: Partial<ClaimCreatedEvent>; logs?: (event: ClaimCreatedEvent) => RawLog[]; store?: boolean } = {}) {
  const { document, sha256 } = await storedDocument(h, options.mutate, options.store !== false);
  return addOnChainClaim(h.ctx, h.chain, document, sha256, { ...(options.event ? { event: options.event } : {}), ...(options.logs ? { logs: options.logs } : {}) });
}

describe("claims.verify-integrity", () => {
  it("verifies a claim whose document, policy, manifest constants and NewMarket all match", async () => {
    const h = harnessOf();
    const event = await claimWith(h);
    await runIntegrity(h);
    expect((await indexOf(h)).get(event.market)).toMatchObject({ integrity_status: "verified", mismatch_fields: [], final: true });
    expect(h.ctx.audit.entries.map((entry) => entry.action)).toContain("claim.integrity.verified");
  });

  it("records each on-chain field mismatch by name (SEC-CLAIM-04, SEC-IDX-08)", async () => {
    const h = harnessOf();
    const cases: [string, Parameters<typeof claimWith>[1]][] = [
      ["repositoryId", { event: { repositoryId: 427016915 } }],
      ["commit", { event: { commit: "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab13" } }],
      ["policy", { event: { policyDocumentSha256: `0x${"12".repeat(32)}` as Hex32 } }],
      ["evidenceDeadline", { event: { evidenceDeadline: 1791158460 } }],
      ["revealDeadline", { event: { revealDeadline: 1791331260 } }],
      ["minBond", { event: { minBond: 2n * 10n ** 18n } }],
      ["title", { event: { title: "A different title" } }],
      ["question", { event: { marketName: "Pine claim [x]: tampered question" } }],
      ["claimRegistry", { event: { address: OTHER }, logs: (event) => [claimCreatedLog(event), newMarketLog(event)] }],
      ["newMarket", { logs: (event) => [claimCreatedLog(event)] }],
      ["newMarket", { logs: (event) => [claimCreatedLog(event), newMarketLog(event, { address: OTHER })] }],
      ["newMarket", { logs: (event) => [claimCreatedLog(event), newMarketLog(event, { marketName: `${event.marketName} ` })] }],
      ["seerMarketFactory", { mutate: (document) => void (document.market.seerMarketFactory = OTHER) }],
      ["collateralToken", { mutate: (document) => void (document.market.collateralToken = OTHER) }],
      ["realitio", { mutate: (document) => void (document.market.realitio = OTHER) }],
      ["arbitrator", { mutate: (document) => void (document.market.arbitrator = OTHER) }],
      ["questionTimeoutSeconds", { mutate: (document) => void (document.market.questionTimeoutSeconds = 1) }],
      ["evidenceRegistry", { mutate: (document) => void (document.evidence.registry = OTHER) }],
      ["chainId", { mutate: (document) => void ((document.market.chainId = 10200), (document.evidence.chainId = 10200)) }],
    ];
    const events: [string, ClaimCreatedEvent][] = [];
    for (const [field, options] of cases) events.push([field, await claimWith(h, options)]);
    // A policy that matches on-chain but is not in the catalog.
    events.push(["policy", await claimWith(h, { mutate: (document) => void (document.policy.sha256 = `0x${"34".repeat(32)}` as Hex32) })]);
    await runIntegrity(h);
    const index = await indexOf(h);
    for (const [field, event] of events) {
      const row = index.get(event.market)!;
      expect(row.integrity_status, field).toBe("mismatch");
      expect(row.mismatch_fields, field).toContain(field);
      expect(row.final).toBe(true);
    }
  });

  it("flags a copycat market created by another wallet with someone else's document", async () => {
    const h = harnessOf();
    const original = await claimWith(h);
    const copy = addOnChainClaim(h.ctx, h.chain, (await storedDocument(h)).document, original.claimDocumentSha256, { event: { creator: OTHER, claimDocumentSha256: original.claimDocumentSha256 } });
    await runIntegrity(h);
    const index = await indexOf(h);
    expect(index.get(original.market)?.integrity_status).toBe("verified");
    expect(index.get(copy.market)).toMatchObject({ integrity_status: "mismatch" });
    expect(index.get(copy.market)!.mismatch_fields).toContain("creator");
  });

  it("records a renderer-refused input (repository id above 2^53 - 1, up to the top of uint64) as a question mismatch", async () => {
    const h = harnessOf();
    // 2^64 - 1 is not representable as a JS number; 2^64 - 2^12 is the largest exact value below 2^64.
    const huge = await claimWith(h, { event: { repositoryId: 2 ** 64 - 2 ** 12 } });
    const unsafe = await claimWith(h, { event: { repositoryId: 2 ** 53 } });
    const fine = await claimWith(h);
    await runIntegrity(h);
    const index = await indexOf(h);
    expect(index.get(huge.market)!.mismatch_fields).toEqual(expect.arrayContaining(["question", "repositoryId"]));
    expect(index.get(huge.market)!.repository_id).toBe("18446744073709547520");
    expect(index.get(unsafe.market)!.mismatch_fields).toContain("question");
    expect(index.get(fine.market)!.integrity_status).toBe("verified");
    // The detail endpoint still serves it with its integrity status.
    const detail = await h.app.inject({ method: "GET", url: `/api/v1/claims/${huge.market}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().claim.integrity.status).toBe("mismatch");
  });

  it("document unavailable: retried with backoff, verified if it appears, final after 7 days", async () => {
    const h = harnessOf();
    const missing = await claimWith(h, { store: false });
    const late = await storedDocument(h, () => {}, false);
    const lateEvent = addOnChainClaim(h.ctx, h.chain, late.document, late.sha256);
    await runIntegrity(h);
    expect((await indexOf(h)).get(missing.market)).toMatchObject({ integrity_status: "document_unavailable", final: false });
    expect((await indexOf(h)).get(lateEvent.market)).toMatchObject({ integrity_status: "document_unavailable" });

    // The document shows up on a trusted gateway: the next due run verifies it.
    h.ctx.contentStore.remote.set(late.sha256, late.bytes);
    h.ctx.clock.advance(3_600_000);
    markFresh(h.ctx);
    await runIntegrity(h);
    expect((await indexOf(h)).get(lateEvent.market)?.integrity_status).toBe("verified");

    h.ctx.clock.advance(7 * 86_400_000);
    markFresh(h.ctx);
    await runIntegrity(h);
    expect((await indexOf(h)).get(missing.market)).toMatchObject({ integrity_status: "document_unavailable", final: true });
  });

  it("bytes that match the digest but are not a valid document are a mismatch on the document", async () => {
    const h = harnessOf();
    const bytes = new TextEncoder().encode('{"not":"a claim"}');
    const stored = await h.ctx.contentStore.put({ bytes, declaredMediaType: "application/json", maxBytes: 262_144 });
    const { document } = await storedDocument(h);
    const event = addOnChainClaim(h.ctx, h.chain, document, stored.sha256);
    await runIntegrity(h);
    expect((await indexOf(h)).get(event.market)).toMatchObject({ integrity_status: "mismatch", mismatch_fields: ["document"] });
  });

  it("a stored document whose title contains a bracket fails to parse: mismatch, never verified or listed", async () => {
    const h = harnessOf();
    // A title that tries to close the "Pine claim [<title>]" delimiter. The frozen schema refuses it, so the document is built
    // in canonical form by hand (as a direct contract caller could) and stored under its own digest.
    const title = "Rule [1]: fake terms [x";
    const { document } = documentWith((doc) => void (doc.nonce = `0x${randomBytes(32).toString("hex")}` as Hex32));
    document.claim.title = title;
    const stored = await h.ctx.contentStore.put({ bytes: canonicalBytes(document as unknown as JsonValue), declaredMediaType: "application/json", maxBytes: 262_144 });
    // The on-chain question is what a renderer without the bracket rule would have produced, consistent with its hash and NewMarket.
    const placeholder = renderQuestion({
      evidenceRegistry: document.evidence.registry,
      title: "x",
      evidenceDeadline: document.evidence.evidenceDeadline,
      revealDeadline: document.evidence.revealDeadline,
      repositoryId: document.target.repository.id,
      commit: document.target.commit,
      claimDocumentSha256: stored.sha256,
      policyDocumentSha256: document.policy.sha256,
    });
    const marketName = placeholder.replace("Pine claim [x]", `Pine claim [${title}]`);
    const event = addOnChainClaim(h.ctx, h.chain, document, stored.sha256, { event: { title, marketName } });
    await runIntegrity(h);
    const row = (await indexOf(h)).get(event.market)!;
    expect(row).toMatchObject({ integrity_status: "mismatch", final: true });
    expect(row.mismatch_fields).toEqual(expect.arrayContaining(["document", "question"]));
    expect(h.ctx.audit.entries.map((entry) => entry.action)).not.toContain("claim.integrity.verified");
    const detail = await h.app.inject({ method: "GET", url: `/api/v1/claims/${event.market}` });
    expect(detail.json().claim).toMatchObject({ integrity: { status: "mismatch" }, listed: false });
    const listing = await h.app.inject({ method: "GET", url: "/api/v1/claims" });
    expect(listing.json().items.map((item: { market: string }) => item.market)).not.toContain(event.market);
  });

  it("discovery that throws inserts nothing; the next clean run indexes and verifies everything (7a)", async () => {
    const h = harnessOf();
    const events: ClaimCreatedEvent[] = [];
    for (let index = 0; index < 130; index += 1) events.push(await claimWith(h));
    const listClaims = h.ctx.readModel.listClaims.bind(h.ctx.readModel);
    let calls = 0;
    h.ctx.readModel.listClaims = async (query) => {
      calls += 1;
      if (query.cursor !== undefined && calls === 2) throw new Error("read model connection reset");
      return listClaims(query);
    };
    await expect(runIntegrity(h)).rejects.toThrow(/connection reset/);
    expect((await indexOf(h)).size).toBe(0);
    h.ctx.readModel.listClaims = listClaims;
    // Clean runs: discovery inserts all, verification proceeds 50 per run.
    for (let run = 0; run < 3; run += 1) await runIntegrity(h);
    const index = await indexOf(h);
    expect(index.size).toBe(130);
    expect(events.every((event) => index.get(event.market)?.integrity_status === "verified")).toBe(true);
    // New claims are discovered incrementally on top of the indexed ones.
    const next = await claimWith(h);
    await runIntegrity(h);
    expect((await indexOf(h)).get(next.market)?.integrity_status).toBe("verified");
  });

  it("a verification failure for one claim does not stop the others; it stays pending and is verified later", async () => {
    const h = harnessOf();
    const flaky = await claimWith(h);
    const good = await claimWith(h);
    const receipt = h.chain.receipts.get(flaky.transactionHash)!;
    h.chain.receipts.set(flaky.transactionHash, "error");
    await runIntegrity(h);
    let index = await indexOf(h);
    expect(index.get(flaky.market)).toMatchObject({ integrity_status: "pending", final: false });
    expect(index.get(good.market)?.integrity_status).toBe("verified");
    h.chain.receipts.set(flaky.transactionHash, receipt);
    // Backoff: not retried immediately.
    await runIntegrity(h);
    expect((await indexOf(h)).get(flaky.market)?.integrity_status).toBe("pending");
    h.ctx.clock.advance(3_600_000);
    markFresh(h.ctx);
    await runIntegrity(h);
    index = await indexOf(h);
    expect(index.get(flaky.market)?.integrity_status).toBe("verified");
  });

  it("a permanently failing row backs off and cannot starve newer claims", async () => {
    const h = harnessOf();
    // A row whose claim the read model never returns (getClaim null): oldest position, always transient.
    await h.ctx.database.sql.query(
      `INSERT INTO claims_index (market, registry, creator, claim_document_sha256, policy_document_sha256, repository_id, evidence_deadline, reveal_deadline,
         created_block, created_log_index, integrity_status, next_attempt_at, discovered_at)
       VALUES ($1, $2, $2, $3, $3, 1, 1, 2, 1, 0, 'pending', $4, $4)`,
      ["0x00000000000000000000000000000000000dead0", OTHER, `0x${"01".repeat(32)}`, h.ctx.clock.now().toISOString()],
    );
    const events: ClaimCreatedEvent[] = [];
    for (let index = 0; index < 60; index += 1) events.push(await claimWith(h));
    await runIntegrity(h);
    await runIntegrity(h);
    const index = await indexOf(h);
    expect(events.every((event) => index.get(event.market)?.integrity_status === "verified")).toBe(true);
    expect(index.get("0x00000000000000000000000000000000000dead0")).toMatchObject({ integrity_status: "pending", final: false });
    const [row] = await h.ctx.database.sql.query<{ attempts: number; next_ms: string }>(
      "SELECT attempts, (extract(epoch from next_attempt_at) * 1000)::bigint::text AS next_ms FROM claims_index WHERE market = $1",
      ["0x00000000000000000000000000000000000dead0"],
    );
    expect(row!.attempts).toBe(1);
    expect(Number(row!.next_ms) - h.ctx.clock.now().getTime()).toBeLessThanOrEqual(3_600_000);
  });

  it("concurrent runs record each result once", async () => {
    const h = harnessOf();
    const events: ClaimCreatedEvent[] = [];
    for (let index = 0; index < 5; index += 1) events.push(await claimWith(h));
    await Promise.all([runIntegrity(h), runIntegrity(h)]);
    const index = await indexOf(h);
    expect(events.every((event) => index.get(event.market)?.integrity_status === "verified")).toBe(true);
    expect(h.ctx.audit.entries.filter((entry) => entry.action === "claim.integrity.verified")).toHaveLength(5);
  });
});

describe("claims.verify-integrity bounds, backoff and stored facts (claims-006)", () => {
  const nextAttemptDelay = async (h: Harness, market: string): Promise<{ attempts: number; seconds: number }> => {
    const [row] = await h.ctx.database.sql.query<{ attempts: number; next_ms: string }>(
      "SELECT attempts, (extract(epoch from next_attempt_at) * 1000)::bigint::text AS next_ms FROM claims_index WHERE market = $1",
      [market],
    );
    return { attempts: row!.attempts, seconds: (Number(row!.next_ms) - h.ctx.clock.now().getTime()) / 1000 };
  };

  it("verifies at most 50 claims per run, oldest first", async () => {
    const h = harnessOf();
    const events: ClaimCreatedEvent[] = [];
    for (let index = 0; index < 60; index += 1) events.push(await claimWith(h));
    await runIntegrity(h);
    const index = await indexOf(h);
    expect(index.size).toBe(60);
    const byAge = [...events].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1)).map((event) => event.market);
    const verified = byAge.filter((market) => index.get(market)?.integrity_status === "verified");
    expect(verified).toHaveLength(50);
    expect(verified).toEqual(byAge.slice(0, 50));
    expect(byAge.slice(50).every((market) => index.get(market)?.integrity_status === "pending")).toBe(true);
    // Verified in order, oldest first.
    expect(h.ctx.audit.entries.filter((entry) => entry.action === "claim.integrity.verified").map((entry) => entry.subjectId)).toEqual(byAge.slice(0, 50));
    await runIntegrity(h);
    const after = await indexOf(h);
    expect(byAge.every((market) => after.get(market)?.integrity_status === "verified")).toBe(true);
  });

  it("the retry delay doubles across attempts from one minute and is capped at one hour", async () => {
    const h = harnessOf();
    const flaky = await claimWith(h);
    h.chain.receipts.set(flaky.transactionHash, "error");
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      await runIntegrity(h);
      const { attempts, seconds } = await nextAttemptDelay(h, flaky.market);
      expect(attempts).toBe(attempt);
      delays.push(seconds);
      // Not due before the delay has passed: a run just before it changes nothing.
      h.ctx.clock.advance(seconds * 1000 - 1000);
      await runIntegrity(h);
      expect((await nextAttemptDelay(h, flaky.market)).attempts).toBe(attempt);
      h.ctx.clock.advance(1000);
    }
    expect(delays).toEqual([60, 120, 240, 480, 960, 1_920, 3_600, 3_600, 3_600]);
    expect((await indexOf(h)).get(flaky.market)).toMatchObject({ integrity_status: "pending", final: false });
  });

  it("a content-store exception other than not-found leaves the claim pending while the others are verified", async () => {
    const h = harnessOf();
    const flaky = await claimWith(h);
    const others = [await claimWith(h), await claimWith(h)];
    const retrieve = h.ctx.contentStore.retrieve.bind(h.ctx.contentStore);
    h.ctx.contentStore.retrieve = async (sha256, maxBytes) => {
      if (sha256 === flaky.claimDocumentSha256) throw new Error("ECONNRESET reading https://ipfs.example/secret-token");
      return retrieve(sha256, maxBytes);
    };
    await runIntegrity(h);
    const index = await indexOf(h);
    // Not a result: neither document_unavailable nor mismatch.
    expect(index.get(flaky.market)).toMatchObject({ integrity_status: "pending", final: false, mismatch_fields: [] });
    for (const event of others) expect(index.get(event.market)?.integrity_status).toBe("verified");
    const [row] = await h.ctx.database.sql.query<{ attempts: number; last_error: string }>("SELECT attempts, last_error FROM claims_index WHERE market = $1", [flaky.market]);
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).not.toContain("secret-token");

    h.ctx.contentStore.retrieve = retrieve;
    h.ctx.clock.advance(60_000);
    await runIntegrity(h);
    expect((await indexOf(h)).get(flaky.market)?.integrity_status).toBe("verified");
  });

  it("the document's policy id and version must match the catalog entry of the on-chain policy digest", async () => {
    const h = harnessOf();
    // The BOT-001 file digest, labelled as FUNC-001@0.1.0 in the document.
    const relabelled = await claimWith(h, { mutate: (document) => void (document.policy = { ...document.policy, id: "FUNC-001" }) });
    const wrongVersion = await claimWith(h, { mutate: (document) => void (document.policy = { ...document.policy, version: "0.2.0" }) });
    await runIntegrity(h);
    const index = await indexOf(h);
    expect(index.get(relabelled.market)).toMatchObject({ integrity_status: "mismatch", mismatch_fields: ["policy"] });
    expect(index.get(wrongVersion.market)).toMatchObject({ integrity_status: "mismatch", mismatch_fields: ["policy"] });
  });

  it("stores parameters_valid once at verification and backfills verified rows that lack it", async () => {
    const h = harnessOf();
    const valid = await claimWith(h);
    const malformed = await claimWith(h, { mutate: (document) => void (document.claim.policyParameters = { sourceRequirement: "only one of three" }) });
    const unknownKey = await claimWith(h, {
      mutate: (document) => void (document.claim.policyParameters = { ...document.claim.policyParameters, injected: "x" }),
    });
    await runIntegrity(h);
    const parameters = async () =>
      new Map(
        (await h.ctx.database.sql.query<{ market: string; integrity_status: string; parameters_valid: boolean | null }>("SELECT market, integrity_status, parameters_valid FROM claims_index")).map(
          (row) => [row.market, row],
        ),
      );
    let rows = await parameters();
    // Integrity is about the on-chain facts; parameter validity is a separate stored fact used for listing.
    expect(rows.get(valid.market)).toMatchObject({ integrity_status: "verified", parameters_valid: true });
    expect(rows.get(malformed.market)).toMatchObject({ integrity_status: "verified", parameters_valid: false });
    expect(rows.get(unknownKey.market)).toMatchObject({ integrity_status: "verified", parameters_valid: false });

    // Rows verified before migration 0002 (NULL) are never listed until the job computes the value.
    await h.ctx.database.sql.query("UPDATE claims_index SET parameters_valid = NULL");
    const listed = async () => (await h.app.inject({ method: "GET", url: "/api/v1/claims" })).json().items.map((item: { market: string }) => item.market);
    expect(await listed()).toEqual([]);
    await runIntegrity(h);
    rows = await parameters();
    expect(rows.get(valid.market)?.parameters_valid).toBe(true);
    expect(rows.get(malformed.market)?.parameters_valid).toBe(false);
    expect(await listed()).toEqual([valid.market]);
  });
});

describe("claims.verify-integrity: same-market NewMarket and single-field document checks (claims-007, PRD-03 §8b)", () => {
  const ANOTHER = `0x${"5e".repeat(32)}` as Hex32;

  /** Each case must be a mismatch on exactly the named field (nothing else differs), so removing that one check fails it. */
  const cases: [string, string, Parameters<typeof claimWith>[1]][] = [
    ["SEC-IDX-08 a NewMarket from the configured factory for a DIFFERENT market", "newMarket", { logs: (event) => [claimCreatedLog(event), newMarketLog(event, { market: OTHER })] }],
    ["SEC-IDX-08 a NewMarket from the configured factory with a different conditionId", "newMarket", { logs: (event) => [claimCreatedLog(event), newMarketLog(event, { conditionId: ANOTHER })] }],
    ["SEC-IDX-08 a NewMarket from the configured factory with a different questionId", "newMarket", { logs: (event) => [claimCreatedLog(event), newMarketLog(event, { questionId: ANOTHER })] }],
    ["a document naming the wrong market.claimRegistry, on an event from the right registry", "claimRegistry", { mutate: (document) => void (document.market.claimRegistry = OTHER) }],
  ];

  for (const [name, field, options] of cases) {
    it(`${name} is a mismatch on ${field} only`, async () => {
      const h = harnessOf();
      const control = await claimWith(h);
      const event = await claimWith(h, options);
      // The right registry emitted it (the event-address check is not what fails here).
      expect(event.address.toLowerCase()).toBe(h.ctx.config.contracts.claimRegistry.toLowerCase());
      await runIntegrity(h);
      const index = await indexOf(h);
      expect(index.get(control.market)).toMatchObject({ integrity_status: "verified" });
      expect(index.get(event.market)).toMatchObject({ integrity_status: "mismatch", mismatch_fields: [field], final: true });
      // Not listed; the detail shows the mismatch.
      expect((await h.app.inject({ method: "GET", url: "/api/v1/claims" })).json().items.map((item: { market: string }) => item.market)).toEqual([control.market]);
    });
  }

  // The frozen document schema refuses differing market/evidence chain ids, so a document with only ONE wrong chain id
  // cannot be encoded by encodeClaimDocument: its canonical bytes are built directly. parseClaimDocumentBytes refuses
  // it, so integrity records a mismatch on `document` (both wrong together is the `chainId` case above).
  for (const [name, mutate] of [
    ["only document.market.chainId wrong", (document: ClaimDocument) => void (document.market.chainId = 10200)],
    ["only document.evidence.chainId wrong", (document: ClaimDocument) => void (document.evidence.chainId = 10200)],
  ] as const) {
    it(`${name} is a mismatch (the document is refused) and never verified`, async () => {
      const h = harnessOf();
      const control = await claimWith(h);
      const { document } = documentWith((doc) => void (doc.nonce = `0x${randomBytes(32).toString("hex")}` as Hex32));
      mutate(document);
      const bytes = canonicalBytes(document as unknown as JsonValue);
      const digest = sha256Hex(bytes);
      await h.ctx.contentStore.put({ bytes, declaredMediaType: "application/json", maxBytes: 262_144 });
      const event = addOnChainClaim(h.ctx, h.chain, document, digest);
      await runIntegrity(h);
      const index = await indexOf(h);
      expect(index.get(control.market)).toMatchObject({ integrity_status: "verified" });
      expect(index.get(event.market)).toMatchObject({ integrity_status: "mismatch", mismatch_fields: ["document"], final: true });
    });
  }

  it("a receipt carrying both another market's NewMarket and this market's verifies only through the matching one", async () => {
    const h = harnessOf();
    const event = await claimWith(h, { logs: (claim) => [newMarketLog(claim, { market: OTHER }), claimCreatedLog(claim), newMarketLog(claim)] });
    await runIntegrity(h);
    expect((await indexOf(h)).get(event.market)).toMatchObject({ integrity_status: "verified", mismatch_fields: [] });
  });
});

describe("claims.verify-integrity: moderation-withheld documents (claims-009, PRD-03 §8c)", () => {
  it("a document blocked by content moderation stays pending with backoff (never document_unavailable) and is verified once the block is lifted", async () => {
    const h = harnessOf();
    const withheld = await claimWith(h);
    const other = await claimWith(h);
    // The real content store returns null for blocked content (ContentStore.retrieve contract); the fake does not
    // know about moderation, so model it here.
    const retrieve = h.ctx.contentStore.retrieve.bind(h.ctx.contentStore);
    h.ctx.contentStore.retrieve = async (sha256, maxBytes) => {
      const states = await h.ctx.moderation.states("content", [sha256]);
      if ([...states.values()].some((item) => item.action === "block")) return null;
      return retrieve(sha256, maxBytes);
    };
    h.ctx.moderation.set("content", withheld.claimDocumentSha256, "block", "takedown request");

    const status = async () => {
      const [row] = await h.ctx.database.sql.query<{ integrity_status: string; final: boolean; attempts: number; first_unavailable_at: string | null; next_ms: string }>(
        "SELECT integrity_status, final, attempts, first_unavailable_at::text AS first_unavailable_at, (extract(epoch from next_attempt_at) * 1000)::bigint::text AS next_ms FROM claims_index WHERE market = $1",
        [withheld.market],
      );
      return { ...row!, delay: (Number(row!.next_ms) - h.ctx.clock.now().getTime()) / 1000 };
    };

    await runIntegrity(h);
    expect((await indexOf(h)).get(other.market)?.integrity_status).toBe("verified");
    expect(await status()).toMatchObject({ integrity_status: "pending", final: false, attempts: 1, first_unavailable_at: null, delay: 60 });

    // Well past the 7-day window that finalizes an unavailable document: still pending, never final.
    for (let run = 0; run < 12; run += 1) {
      h.ctx.clock.advance(86_400_000);
      markFresh(h.ctx);
      await runIntegrity(h);
    }
    expect(await status()).toMatchObject({ integrity_status: "pending", final: false, attempts: 13, first_unavailable_at: null, delay: 3_600 });
    expect(h.ctx.audit.entries.filter((entry) => entry.subjectId === withheld.market).map((entry) => entry.action)).toEqual([]);

    // The block is lifted: the next due run verifies it.
    h.ctx.moderation.items.clear();
    h.ctx.clock.advance(3_600_000);
    markFresh(h.ctx);
    await runIntegrity(h);
    expect(await status()).toMatchObject({ integrity_status: "verified", final: true });
  });
});

describe("claims.verify-integrity: the unavailable window excludes moderation (claims-010, PRD-03 §8d)", () => {
  it("integrity verification never calls GitHub (a chain/content check): verified while every GitHub call would fail", async () => {
    const h = harnessOf();
    const calls: string[] = [];
    for (const method of ["listPublicRepos", "getRepo", "getRepoById", "listPulls", "getPull", "listPullCommits", "getCommit", "verifyCommitMembership"] as const) {
      Object.defineProperty(h.ctx.github, method, {
        value: async () => {
          calls.push(method);
          throw new Error("GitHub must not be called by integrity");
        },
      });
    }
    const event = await claimWith(h);
    await runIntegrity(h);
    expect((await indexOf(h)).get(event.market)).toMatchObject({ integrity_status: "verified", final: true });
    expect(calls).toEqual([]);
  });

  it("blocking a document clears first_unavailable_at, so the 7-day window restarts when the block is lifted", async () => {
    const h = harnessOf();
    const missing = await claimWith(h, { store: false });
    const DAY_MS = 86_400_000;
    const row = async () => {
      const [found] = await h.ctx.database.sql.query<{ integrity_status: string; final: boolean; first_ms: string | null }>(
        "SELECT integrity_status, final, (extract(epoch from first_unavailable_at) * 1000)::bigint::text AS first_ms FROM claims_index WHERE market = $1",
        [missing.market],
      );
      return { status: found!.integrity_status, final: found!.final, first: found!.first_ms === null ? null : Number(found!.first_ms) };
    };
    const runAfter = async (ms: number) => {
      h.ctx.clock.advance(ms);
      markFresh(h.ctx);
      await runIntegrity(h);
    };

    await runIntegrity(h);
    const firstSeen = h.ctx.clock.now().getTime();
    expect(await row()).toEqual({ status: "document_unavailable", final: false, first: firstSeen });
    for (let day = 0; day < 5; day += 1) await runAfter(DAY_MS);
    expect(await row()).toEqual({ status: "document_unavailable", final: false, first: firstSeen });

    // Withheld by moderation for four days: pending, window cleared.
    h.ctx.moderation.set("content", missing.claimDocumentSha256, "block", "takedown request");
    for (let day = 0; day < 4; day += 1) await runAfter(DAY_MS);
    expect(await row()).toEqual({ status: "pending", final: false, first: null });

    // Lifted (nine days after the first miss): the window restarts now instead of finalizing on the old start.
    h.ctx.moderation.items.clear();
    await runAfter(DAY_MS);
    const restarted = h.ctx.clock.now().getTime();
    expect(await row()).toEqual({ status: "document_unavailable", final: false, first: restarted });
    for (let day = 0; day < 6; day += 1) await runAfter(DAY_MS);
    expect(await row()).toMatchObject({ final: false, first: restarted });
    await runAfter(DAY_MS);
    expect(await row()).toEqual({ status: "document_unavailable", final: true, first: restarted });
  });
});

describe("claims.verify-integrity: creation receipt and starvation (claims-hardening, PRD-07 §3b)", () => {
  it("the creation receipt must prove the read model's creator, registry and digest for the market: otherwise a mismatch on creation", async () => {
    const h = harnessOf();
    const otherCreator = await claimWith(h, { logs: (event) => [claimCreatedLog(event, { creator: OTHER }), newMarketLog(event)] });
    const otherRegistry = await claimWith(h, { logs: (event) => [claimCreatedLog(event, { address: OTHER }), newMarketLog(event)] });
    const otherDigest = await claimWith(h, { logs: (event) => [claimCreatedLog({ ...event, claimDocumentSha256: `0x${"5a".repeat(32)}` as Hex32 }), newMarketLog(event)] });
    const otherMarket = await claimWith(h, { logs: (event) => [claimCreatedLog({ ...event, market: OTHER }), newMarketLog(event)] });
    const fine = await claimWith(h);
    await runIntegrity(h);
    const index = await indexOf(h);
    for (const [name, event] of [["creator", otherCreator], ["registry", otherRegistry], ["digest", otherDigest], ["market", otherMarket]] as const) {
      expect(index.get(event.market), name).toMatchObject({ integrity_status: "mismatch", mismatch_fields: ["creation"], final: true });
    }
    expect(index.get(fine.market)).toMatchObject({ integrity_status: "verified", mismatch_fields: [] });
  });

  it("a missing creation receipt is transient: the claim stays pending with backoff, never a verdict", async () => {
    const h = harnessOf();
    const event = await claimWith(h);
    h.chain.receipts.delete(event.transactionHash.toLowerCase());
    await runIntegrity(h);
    const [row] = await h.ctx.database.sql.query<{ integrity_status: string; final: boolean; attempts: number; delay_ms: string; last_error: string | null }>(
      `SELECT integrity_status, final, attempts, ((extract(epoch from next_attempt_at) * 1000)::bigint - $2::bigint)::text AS delay_ms, last_error
         FROM claims_index WHERE market = $1`,
      [event.market, h.ctx.clock.now().getTime()],
    );
    expect(row).toMatchObject({ integrity_status: "pending", final: false, attempts: 1, delay_ms: "60000" });
    expect(row!.last_error).toMatch(/creation receipt unavailable/);
    expect(h.ctx.audit.entries.filter((entry) => entry.action.startsWith("claim.integrity."))).toEqual([]);
  });

  it("60 always-due retries of unavailable documents cannot crowd out a new claim: it is verified in the first run", async () => {
    const h = harnessOf();
    const due = new Date(h.ctx.clock.now().getTime() - 3_600_000).toISOString();
    for (let index = 0; index < 60; index += 1) {
      const market = `0x${(0xdead00 + index).toString(16).padStart(40, "0")}`;
      await h.ctx.database.sql.query(
        `INSERT INTO claims_index (market, registry, creator, claim_document_sha256, policy_document_sha256, repository_id, evidence_deadline, reveal_deadline,
           created_block, created_log_index, integrity_status, attempts, next_attempt_at, first_unavailable_at, discovered_at)
         VALUES ($1, $2, $2, $3, $3, 1, 1, 2, $4, 0, 'document_unavailable', 3, $5, $5, $5)`,
        [market, OTHER, `0x${"01".repeat(32)}`, index + 1, due],
      );
    }
    const fresh = await claimWith(h);
    await runIntegrity(h);
    expect((await indexOf(h)).get(fresh.market)).toMatchObject({ integrity_status: "verified", final: true });
    // The retries ran too (up to 50 of them), soonest due first.
    const [retried] = await h.ctx.database.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM claims_index WHERE attempts = 4");
    expect(retried!.n).toBe(50);
  });
});
