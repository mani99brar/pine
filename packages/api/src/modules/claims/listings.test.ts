// Must stay the first import: serializes the memory-heavy claims test files (see test/lock.ts).
import "./test/lock.js";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ClaimDocument } from "@pine/shared/claim-document";
import type { ChainEvent, ClaimCreatedEvent, EventEnvelope } from "@pine/shared/chain-events";
import type { Address, Hex32 } from "@pine/shared/types";
import { addOnChainClaim, documentWith, markFresh, REPO, useHarness, type Harness } from "./test/helpers.js";

const harnessOf = useHarness();

async function runIntegrity(h: Harness) {
  await h.module.jobs!.find((item) => item.name === "claims.verify-integrity")!.run(h.ctx, new AbortController().signal);
}

async function claim(h: Harness, options: { store?: boolean; event?: Partial<ClaimCreatedEvent>; mutate?: (document: ClaimDocument) => void } = {}) {
  const { document, bytes, sha256 } = documentWith((doc) => {
    doc.nonce = `0x${randomBytes(32).toString("hex")}` as Hex32;
    options.mutate?.(doc);
  });
  if (options.store !== false) await h.ctx.contentStore.put({ bytes, declaredMediaType: "application/json", maxBytes: 262_144 });
  return addOnChainClaim(h.ctx, h.chain, document, sha256, options.event ? { event: options.event } : {});
}

type ListBody = { items: { market: string; title: string; phase: string; integrity: { status: string } }[]; nextCursor: string | null; indexer: { stale: boolean; lagSeconds: number } };

const list = async (h: Harness, query = "") => (await h.app.inject({ method: "GET", url: `/api/v1/claims${query}` })).json() as ListBody;

describe("public claim listings", () => {
  it("list only verified, unmoderated claims; details show every claim with integrity and moderation", async () => {
    const h = harnessOf();
    const verified = await claim(h);
    const mismatch = await claim(h, { event: { title: "Not what the document says" } });
    const unavailable = await claim(h, { store: false });
    const hidden = await claim(h);
    const blocked = await claim(h);
    await runIntegrity(h);
    h.ctx.moderation.set("claim", hidden.market, "hide", "spam");
    h.ctx.moderation.set("claim", blocked.market.toUpperCase().replace("0X", "0x"), "block", "illegal content");

    const body = await list(h);
    expect(body.items.map((item) => item.market)).toEqual([verified.market]);
    expect(body.items[0]).toMatchObject({ integrity: { status: "verified" }, phase: "evidence_open", title: verified.title });

    const detail = async (market: Address) => (await h.app.inject({ method: "GET", url: `/api/v1/claims/${market}` })).json().claim;
    expect(await detail(mismatch.market)).toMatchObject({ integrity: { status: "mismatch", mismatchFields: ["title"] }, listed: false });
    expect(await detail(unavailable.market)).toMatchObject({ integrity: { status: "document_unavailable" }, listed: false });
    expect(await detail(hidden.market)).toMatchObject({ moderation: { action: "hide", reason: "spam" }, listed: false, title: hidden.title });
    const blockedDetail = await detail(blocked.market);
    expect(blockedDetail).toMatchObject({ moderation: { action: "block" }, title: null, marketName: null, claimDocument: { url: null } });
    // A hide applied later takes effect immediately (moderation is read per page).
    h.ctx.moderation.set("claim", verified.market, "hide", "late");
    expect((await list(h)).items).toEqual([]);
    expect((await h.app.inject({ method: "GET", url: `/api/v1/claims/0x${"99".repeat(20)}` })).statusCode).toBe(404);
  });

  it("filters by time-based phase computed from the clock and reports the finer phase", async () => {
    const h = harnessOf();
    const event = await claim(h);
    await runIntegrity(h);
    const phases = async () => ({
      evidence: (await list(h, "?phase=evidence_open")).items.length,
      reveal: (await list(h, "?phase=reveal_open")).items.length,
      closed: (await list(h, "?phase=closed")).items.length,
    });
    expect(await phases()).toEqual({ evidence: 1, reveal: 0, closed: 0 });
    h.ctx.clock.set(new Date(event.evidenceDeadline * 1000));
    markFresh(h.ctx);
    expect(await phases()).toEqual({ evidence: 0, reveal: 1, closed: 0 });
    expect((await list(h)).items[0]!.phase).toBe("reveal_open");
    h.ctx.clock.set(new Date(event.revealDeadline * 1000));
    markFresh(h.ctx);
    expect(await phases()).toEqual({ evidence: 0, reveal: 0, closed: 1 });
    expect((await list(h)).items[0]!.phase).toBe("oracle_open");
    for (const phase of ["oracle_open", "finalized", "resolved", "x"]) {
      expect((await h.app.inject({ method: "GET", url: `/api/v1/claims?phase=${phase}` })).statusCode).toBe(400);
    }
  });

  it("pages with keyset cursors (newest first, no duplicates) and filters by creator and repository", async () => {
    const h = harnessOf();
    const events: ClaimCreatedEvent[] = [];
    for (let index = 0; index < 5; index += 1) events.push(await claim(h));
    const other = await claim(h, { mutate: (document) => void ((document.creator = "0x0000000000000000000000000000000000000b0b"), (document.target.repository.id = 7)), event: { creator: "0x0000000000000000000000000000000000000b0b" as Address, repositoryId: 7 } });
    await runIntegrity(h);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: ListBody = await list(h, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.items.map((item) => item.market));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual([other, ...events].map((event) => event.market).reverse().sort((a, b) => (a < b ? 1 : -1)));
    expect(new Set(seen).size).toBe(6);
    // Three full pages, then an empty one: nextCursor is null only once SQL returns fewer rows than the limit.
    expect(pages).toBe(4);
    expect((await list(h, `?creator=${events[0]!.creator}`)).items).toHaveLength(5);
    expect((await list(h, "?repositoryId=7")).items.map((item) => item.market)).toEqual([other.market]);
    expect((await list(h, `?repositoryId=${REPO.id}`)).items).toHaveLength(5);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/claims?cursor=bm9wZQ" })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/claims?limit=101" })).statusCode).toBe(400);
  });

  it("caps GET /api/v1/claims at 25 items per page like the agent feed (PRD-03 §8c)", async () => {
    const h = harnessOf();
    expect((await h.app.inject({ method: "GET", url: "/api/v1/claims?limit=26" })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/claims?limit=25" })).statusCode).toBe(200);
  });

  it("reports indexer staleness", async () => {
    const h = harnessOf();
    expect((await list(h)).indexer.stale).toBe(false);
    h.ctx.clock.advance((h.ctx.config.maxIndexerLagSeconds + 5) * 1000);
    expect((await list(h)).indexer).toMatchObject({ stale: true });
    h.ctx.readModel.setHalted(true);
    markFresh(h.ctx);
    expect((await list(h)).indexer).toMatchObject({ stale: true, halted: true });
  });

  it("public endpoints ignore sessions and cookies: identical status, body, no Set-Cookie (SEC-AGENT-04)", async () => {
    const h = harnessOf();
    const event = await claim(h);
    await runIntegrity(h);
    for (const url of ["/api/v1/claims", `/api/v1/claims/${event.market}`, "/api/v1/policies", "/api/v1/policies/BOT-001/0.1.0"]) {
      const anonymous = await h.app.inject({ method: "GET", url });
      const withSession = await h.app.inject({ method: "GET", url, headers: { ...h.headers, cookie: "__Host-pine_session=pine_s1_AbCdEfGhIjKlMnOpQrStUv" } });
      expect(anonymous.statusCode, url).toBe(200);
      expect(withSession.statusCode).toBe(anonymous.statusCode);
      expect(withSession.body).toBe(anonymous.body);
      expect(withSession.headers.etag).toBe(anonymous.headers.etag);
      expect(withSession.headers["set-cookie"]).toBeUndefined();
      expect(anonymous.headers["set-cookie"]).toBeUndefined();
    }
  });
});

describe("listing eligibility, moderation and caching (claims-006, PRD-03 §8a)", () => {
  const SC_POLICY = { id: "SC-001", version: "0.1.0", sha256: "0xcc5859adc69b002d55db134193dd370bd0dff4c7445462a8772410ac3fea84d9" as Hex32 };
  const detail = async (h: Harness, market: string) => (await h.app.inject({ method: "GET", url: `/api/v1/claims/${market}` })).json().claim;

  it("SEC-CLAIM-06 an SC-001 claim created directly on-chain is never listable, even with valid-looking parameters", async () => {
    const h = harnessOf();
    const listed = await claim(h);
    const sc = await claim(h, { mutate: (document) => void ((document.policy = SC_POLICY), (document.claim.policyParameters = {})) });
    await runIntegrity(h);
    // Integrity accepts any catalog status; isolate the publishable-policy filter by forcing the stored parameter fact.
    await h.ctx.database.sql.query("UPDATE claims_index SET parameters_valid = true WHERE market = $1", [sc.market]);
    expect((await list(h)).items.map((item) => item.market)).toEqual([listed.market]);
    expect((await list(h, "?phase=evidence_open")).items.map((item) => item.market)).toEqual([listed.market]);
    expect(await detail(h, sc.market)).toMatchObject({ integrity: { status: "verified" }, listable: false, listed: false });
    expect(await detail(h, listed.market)).toMatchObject({ listable: true, listed: true, hidden: false });
    // Even a configuration that enables the SC-001 family and draft policies never lists it.
    const permissive = await h.variant({ claims: { ...h.ctx.config.claims, enabledPolicyFamilies: ["FUNC-001", "BOT-001", "SC-001"], allowDraftPolicies: true } });
    const items = (await permissive.app.inject({ method: "GET", url: "/api/v1/claims" })).json().items.map((item: { market: string }) => item.market);
    expect(items).toEqual([listed.market]);
    const agents = (await permissive.app.inject({ method: "GET", url: "/api/v1/agents/claims" })).json().items.map((item: { platform: { market: string } }) => item.platform.market);
    expect(agents).toEqual([listed.market]);
  });

  it("a claim whose policy parameters are malformed is verified but not listable", async () => {
    const h = harnessOf();
    const malformed = await claim(h, { mutate: (document) => void (document.claim.policyParameters = { sourceRequirement: "x" }) });
    await runIntegrity(h);
    expect((await list(h)).items).toEqual([]);
    expect(await detail(h, malformed.market)).toMatchObject({ integrity: { status: "verified" }, listable: false, listed: false });
    expect((await h.app.inject({ method: "GET", url: "/api/v1/agents/claims" })).json().items).toEqual([]);
  });

  it("an empty publishable set (production before any approval) lists nothing, without error", async () => {
    const h = harnessOf();
    const event = await claim(h);
    await runIntegrity(h);
    // Every catalog policy is draft or disabled; without allowDraftPolicies the publishable set is empty.
    const gated = await h.variant({ claims: { ...h.ctx.config.claims, allowDraftPolicies: false } });
    for (const url of ["/api/v1/claims", "/api/v1/claims?phase=evidence_open", "/api/v1/agents/claims"]) {
      const response = await gated.app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.json().items, url).toEqual([]);
      expect(response.json().nextCursor, url).toBeNull();
    }
    const claimDetail = (await gated.app.inject({ method: "GET", url: `/api/v1/claims/${event.market}` })).json().claim;
    expect(claimDetail).toMatchObject({ integrity: { status: "verified" }, listable: false });
    // The configuration change takes effect at the next request; the default app still lists it.
    expect((await list(h)).items.map((item) => item.market)).toEqual([event.market]);
  });

  it("a first page whose rows are all hidden is empty but still continues from the last scanned row", async () => {
    const h = harnessOf();
    const events: ClaimCreatedEvent[] = [];
    for (let index = 0; index < 5; index += 1) events.push(await claim(h));
    await runIntegrity(h);
    const newest = [...events].reverse();
    for (const event of newest.slice(0, 2)) h.ctx.moderation.set("claim", event.market, "hide", "spam");
    const first = await list(h, "?limit=2");
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(h, `?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((item) => item.market)).toEqual(newest.slice(2, 4).map((event) => event.market));
    const third = await list(h, `?limit=2&cursor=${second.nextCursor}`);
    expect(third.items.map((item) => item.market)).toEqual([newest[4]!.market]);
    // SQL returned fewer rows than the limit: the end.
    expect(third.nextCursor).toBeNull();
  });

  it("a blocked claim document is withheld: no title, no URL, not listed (content moderation checked by the module)", async () => {
    const h = harnessOf();
    const event = await claim(h);
    await runIntegrity(h);
    h.ctx.moderation.set("content", event.claimDocumentSha256, "block", "illegal content");
    expect((await list(h)).items).toEqual([]);
    const blocked = await detail(h, event.market);
    expect(blocked).toMatchObject({ title: null, marketName: null, claimDocument: { url: null }, contentModeration: { action: "block" }, hidden: true, listed: false });
    expect(JSON.stringify(blocked)).not.toContain("pine-usercontent.test");
    expect(JSON.stringify(blocked)).not.toContain(event.title);
  });

  it("moderated resources send no-cache with an ETag that changes when moderation changes; policies keep max-age", async () => {
    const h = harnessOf();
    const event = await claim(h);
    await runIntegrity(h);
    for (const url of ["/api/v1/claims", `/api/v1/claims/${event.market}`, "/api/v1/agents/claims", `/api/v1/agents/claims/${event.market}`]) {
      const response = await h.app.inject({ method: "GET", url });
      expect(response.headers["cache-control"], url).toBe("public, no-cache");
    }
    expect((await h.app.inject({ method: "GET", url: "/api/v1/policies" })).headers["cache-control"]).toBe("public, max-age=300");

    const url = `/api/v1/claims/${event.market}`;
    const listEtag = String((await h.app.inject({ method: "GET", url: "/api/v1/claims" })).headers.etag);
    const etag = String((await h.app.inject({ method: "GET", url })).headers.etag);
    expect((await h.app.inject({ method: "GET", url, headers: { "if-none-match": etag } })).statusCode).toBe(304);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/claims", headers: { "if-none-match": listEtag } })).statusCode).toBe(304);

    // A hide: the detail and the list change at once, so a revalidating cache never serves the old body.
    h.ctx.moderation.set("claim", event.market, "hide", "late");
    const after = await h.app.inject({ method: "GET", url, headers: { "if-none-match": etag } });
    expect(after.statusCode).toBe(200);
    expect(after.headers.etag).not.toBe(etag);
    expect(after.json().claim).toMatchObject({ hidden: true, listed: false });
    const listAfter = await h.app.inject({ method: "GET", url: "/api/v1/claims", headers: { "if-none-match": listEtag } });
    expect(listAfter.statusCode).toBe(200);
    expect(listAfter.json().items).toEqual([]);

    // The phase is part of the body, so the ETag changes when the clock crosses a deadline (same indexed block).
    const hiddenEtag = String(after.headers.etag);
    const status = await h.ctx.readModel.status();
    h.ctx.clock.set(new Date(event.evidenceDeadline * 1000));
    h.ctx.readModel.markIndexed(status.indexedBlock, h.ctx.clock.unix());
    const crossed = await h.app.inject({ method: "GET", url, headers: { "if-none-match": hiddenEtag } });
    expect(crossed.statusCode).toBe(200);
    expect(crossed.json().claim.phase).toBe("reveal_open");
  });
});

describe("finer phases, oracle status and ETag semantics (claims-007, PRD-03 §8 and §8b)", () => {
  const REALITIO = "0xe78996a233895be74a66f451f1019ca9734205cc" as Address;
  const NO = `0x${"0".repeat(63)}1` as Hex32;
  const URLS = (market: string) => ["/api/v1/claims", `/api/v1/claims/${market}`, "/api/v1/agents/claims", `/api/v1/agents/claims/${market}`];

  /** Envelope of a follow-up event of `claim`, strictly after it (MemoryReadModel applies events in order). */
  function after(claim: ClaimCreatedEvent, step: number, timestamp: number, address: Address = REALITIO): EventEnvelope {
    return {
      chainId: 100,
      address,
      blockNumber: claim.blockNumber + BigInt(step),
      blockHash: `0x${step.toString(16).padStart(64, "e")}` as Hex32,
      blockTimestamp: timestamp,
      transactionHash: `0x${step.toString(16).padStart(64, "f")}` as Hex32,
      logIndex: 0,
    };
  }

  const get = (h: Harness, url: string, headers: Record<string, string> = {}) => h.app.inject({ method: "GET", url, headers });
  const etags = async (h: Harness, market: string) => Promise.all(URLS(market).map(async (url) => String((await get(h, url)).headers.etag)));

  it("phases oracle_open, pending_arbitration, finalized and resolved with the derived oracle status from read-model facts; each change changes the ETag", async () => {
    const h = harnessOf();
    const event = await claim(h);
    await runIntegrity(h);
    const detail = async () => (await get(h, `/api/v1/claims/${event.market}`)).json().claim;
    const agentDetail = async () => (await get(h, `/api/v1/agents/claims/${event.market}`)).json().item.platform;
    const seen = new Set<string>();
    const expectNewEtags = async (label: string) => {
      for (const etag of await etags(h, event.market)) {
        expect(seen.has(etag), label).toBe(false);
        seen.add(etag);
      }
    };

    // Before the reveal deadline the question is not open yet.
    expect(await detail()).toMatchObject({ phase: "evidence_open", oracle: { state: "not_open", opensAt: event.revealDeadline }, resolution: null });
    await expectNewEtags("evidence_open");

    let now = event.revealDeadline + 60;
    h.ctx.clock.set(new Date(now * 1000));
    markFresh(h.ctx);
    expect(await detail()).toMatchObject({ phase: "oracle_open", oracle: { state: "open_unanswered" } });
    await expectNewEtags("oracle_open");

    const apply = (events: ChainEvent[]) => {
      h.ctx.readModel.apply(events);
      markFresh(h.ctx);
    };
    apply([{ ...after(event, 1, now), kind: "RealityNewAnswer", questionId: event.questionId, answer: NO, historyHash: `0x${"00".repeat(32)}` as Hex32, user: "0x00000000000000000000000000000000000a0b0c" as Address, bond: 10n ** 19n, ts: now, isCommitment: false }]);
    expect(await detail()).toMatchObject({ phase: "oracle_open", oracle: { state: "answered", outcome: "no", bond: "10000000000000000000", finalizesAt: now + 302_400 } });
    await expectNewEtags("answered");

    now += 3_600;
    h.ctx.clock.set(new Date(now * 1000));
    apply([{ ...after(event, 2, now), kind: "RealityArbitrationRequested", questionId: event.questionId, user: "0x00000000000000000000000000000000000a0b0d" as Address }]);
    expect(await detail()).toMatchObject({ phase: "pending_arbitration", oracle: { state: "pending_arbitration", outcome: "no", requestedBy: "0x00000000000000000000000000000000000a0b0d" } });
    expect(await agentDetail()).toMatchObject({ phase: "pending_arbitration", oracle: { state: "pending_arbitration" } });
    await expectNewEtags("pending_arbitration");

    now += 86_400;
    h.ctx.clock.set(new Date(now * 1000));
    apply([{ ...after(event, 3, now), kind: "RealityArbitratorAnswered", questionId: event.questionId, answer: NO }]);
    expect(await detail()).toMatchObject({ phase: "finalized", oracle: { state: "finalized", outcome: "no", byArbitrator: true }, resolution: null });
    await expectNewEtags("finalized");

    apply([
      {
        ...after(event, 4, now, h.ctx.config.seer.conditionalTokens as Address),
        kind: "ConditionResolution",
        conditionId: event.conditionId,
        oracle: h.ctx.config.seer.realityProxy as Address,
        ctfQuestionId: `0x${"cf".repeat(32)}` as Hex32,
        outcomeSlotCount: 3,
        payoutNumerators: [0n, 1n, 0n],
      },
    ]);
    expect(await detail()).toMatchObject({ phase: "resolved", resolution: { payoutNumerators: ["0", "1", "0"], resolvedAt: now } });
    expect(await agentDetail()).toMatchObject({ phase: "resolved", resolution: { payoutNumerators: ["0", "1", "0"] } });
    expect((await list(h)).items[0]).toMatchObject({ phase: "resolved" });
    await expectNewEtags("resolved");
  });

  it("the ETag stays equal when only the clock advances within a phase (lagSeconds is left out) and a 304 is served", async () => {
    const h = harnessOf();
    const event = await claim(h);
    await runIntegrity(h);
    markFresh(h.ctx);
    const before = await Promise.all(URLS(event.market).map((url) => get(h, url)));
    // 10 minutes later, same indexed block, still within maxIndexerLagSeconds (900 s): only the lag changed.
    h.ctx.clock.advance(600_000);
    for (const [index, url] of URLS(event.market).entries()) {
      const previous = before[index]!;
      const now = await get(h, url);
      expect(now.json().indexer.lagSeconds, url).toBe(previous.json().indexer.lagSeconds + 600);
      expect(now.body, url).not.toBe(previous.body);
      expect(now.headers.etag, url).toBe(previous.headers.etag);
      expect((await get(h, url, { "if-none-match": String(previous.headers.etag) })).statusCode, url).toBe(304);
    }
  });

  it("the ETag changes when staleness, the indexed block, integrity or listability change", async () => {
    const h = harnessOf();
    const event = await claim(h);
    const detailUrl = `/api/v1/claims/${event.market}`;
    // Integrity: pending (not yet indexed) -> verified.
    const pending = await get(h, detailUrl);
    expect(pending.json().claim.integrity.status).toBe("pending");
    await runIntegrity(h);
    const verified = await get(h, detailUrl);
    expect(verified.json().claim.integrity.status).toBe("verified");
    expect(verified.headers.etag).not.toBe(pending.headers.etag);

    // Listability (configuration): the same claim is not listable once draft policies are refused.
    const gated = await h.variant({ claims: { ...h.ctx.config.claims, allowDraftPolicies: false } });
    const unlisted = await gated.app.inject({ method: "GET", url: detailUrl });
    expect(unlisted.json().claim.listable).toBe(false);
    expect(unlisted.headers.etag).not.toBe(verified.headers.etag);

    // The indexed block moves (same clock): a new ETag.
    const base = await etags(h, event.market);
    markFresh(h.ctx);
    const moved = await etags(h, event.market);
    for (const [index, etag] of moved.entries()) expect(etag).not.toBe(base[index]);

    // Staleness: the lag crosses maxIndexerLagSeconds (only the clock moved, but stale flips): a new ETag.
    h.ctx.clock.advance((h.ctx.config.maxIndexerLagSeconds + 1) * 1000);
    const stale = await etags(h, event.market);
    expect((await get(h, detailUrl)).json().indexer.stale).toBe(true);
    for (const [index, etag] of stale.entries()) expect(etag).not.toBe(moved[index]);

    // Halted: fresh again, then halted at the same block.
    markFresh(h.ctx);
    const fresh = await etags(h, event.market);
    h.ctx.readModel.setHalted(true);
    const halted = await etags(h, event.market);
    for (const [index, etag] of halted.entries()) expect(etag).not.toBe(fresh[index]);
  });
});
