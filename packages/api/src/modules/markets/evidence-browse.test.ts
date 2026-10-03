// Must stay the first import: serializes the markets test files (see test/lock.ts). Public routes only: no database.
import "./test/lock.js";
import { describe, expect, it, vi } from "vitest";
import { rawCidFromSha256 } from "@pine/shared/canonical";
import { encodeEvidenceManifest } from "@pine/shared/evidence";
import type { Address, Hex32 } from "@pine/shared/types";
import { RETRIEVE_MAX_IN_FLIGHT, RETRIEVE_RETRY_AFTER_SECONDS, timelinessOf } from "./evidence-browse.js";
import { createMarketsModule } from "./index.js";
import { addClaim, buildMarketsTestApp, EVIDENCE_REGISTRY, exampleManifest, spyNetwork, storeManifest, useHarness, type Harness } from "./test/helpers.js";

const harnessOf = useHarness({ database: false });
const RESEARCHER = "0x00000000000000000000000000000000000000e1" as Address;

async function commitAndReveal(h: Harness, market: Address, id: bigint, content: Hex32, times: { committedAt: number; revealedAt?: number }) {
  h.b.nextBlock();
  h.ctx.readModel.apply([{ ...h.b.envelope(EVIDENCE_REGISTRY), kind: "EvidenceCommitted", submissionId: id, market, submitter: RESEARCHER, commitment: `0x${id.toString(16).padStart(64, "c")}` as Hex32, committedAt: times.committedAt }]);
  if (times.revealedAt !== undefined) {
    h.b.nextBlock();
    h.ctx.readModel.apply([{ ...h.b.envelope(EVIDENCE_REGISTRY), kind: "EvidenceRevealed", submissionId: id, market, submitter: RESEARCHER, contentSha256: content, committedAt: times.committedAt, revealedAt: times.revealedAt }]);
  }
  await h.fresh();
}

const list = (h: Harness, market: Address, query = "", headers: Record<string, string> = {}) => h.app.inject({ method: "GET", url: `/api/v1/markets/${market}/evidence${query}`, headers });

describe("timeliness (frozen operators: committedAt < evidenceDeadline, revealedAt < revealDeadline)", () => {
  const claim = { evidenceDeadline: 1_000, revealDeadline: 2_000 };
  it("is strict at the exact deadline second", () => {
    expect(timelinessOf({ committedAt: 999, revealedAt: 1_999, status: "revealed" }, claim)).toMatchObject({ recordedBeforeEvidenceDeadline: true, disclosedBeforeRevealDeadline: true, timely: true });
    expect(timelinessOf({ committedAt: 1_000, revealedAt: 1_500, status: "revealed" }, claim)).toMatchObject({ recordedBeforeEvidenceDeadline: false, timely: false });
    expect(timelinessOf({ committedAt: 999, revealedAt: 2_000, status: "revealed" }, claim)).toMatchObject({ disclosedBeforeRevealDeadline: false, timely: false });
    expect(timelinessOf({ committedAt: 999, revealedAt: null, status: "committed" }, claim)).toMatchObject({ disclosedBeforeRevealDeadline: null, timely: false });
    expect(timelinessOf({ committedAt: 1_000, revealedAt: 1_000, status: "published" }, claim)).toMatchObject({ recordedBeforeEvidenceDeadline: false, disclosedBeforeRevealDeadline: false });
    expect(timelinessOf({ committedAt: 999, revealedAt: 999, status: "published" }, claim)).toMatchObject({ timely: true });
  });
});

describe("GET /api/v1/markets/:market/evidence", () => {
  it("joins submissions with stored manifests, timeliness at the exact deadline, availability and the untrusted label", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "b1");
    const manifest = exampleManifest(claim, RESEARCHER, { title: "<img src=x onerror=alert(1)>" });
    const sha = await storeManifest(h, manifest);
    await commitAndReveal(h, claim.market, 1n, sha, { committedAt: claim.evidenceDeadline - 1, revealedAt: claim.revealDeadline - 1 });
    await commitAndReveal(h, claim.market, 2n, `0x${"99".repeat(32)}`, { committedAt: claim.evidenceDeadline, revealedAt: claim.revealDeadline });
    const response = await list(h, claim.market);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.contentTrust).toBe("untrusted");
    expect(body.freshness).toMatchObject({ stale: false, halted: false, status: "ok" });
    const [first, second] = body.items;
    expect(first).toMatchObject({
      submissionId: "1",
      status: "revealed",
      contentSha256: sha,
      contentCid: rawCidFromSha256(sha),
      timeliness: { recordedBeforeEvidenceDeadline: true, disclosedBeforeRevealDeadline: true, timely: true },
      availability: { stored: true },
      manifestError: null,
      attribution: { submitterMatches: true, claimMatches: true },
      contentTrust: "untrusted",
    });
    // Untrusted text is returned as data, never rendered or rewritten.
    expect(first.manifest.title).toBe("<img src=x onerror=alert(1)>");
    expect(second).toMatchObject({ submissionId: "2", timeliness: { recordedBeforeEvidenceDeadline: false, disclosedBeforeRevealDeadline: false, timely: false }, availability: { stored: false }, manifest: null, manifestError: "not stored by Pine" });
  });

  it("SEC-EVID-09 never triggers a remote fetch from a listing, and reports unparsable content", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "b2");
    const remote = encodeEvidenceManifest(exampleManifest(claim, RESEARCHER));
    h.ctx.contentStore.remote.set(remote.sha256, remote.bytes);
    const junk = await h.ctx.contentStore.put({ bytes: new TextEncoder().encode("{ not json"), declaredMediaType: "application/json", maxBytes: 262_144 });
    let retrieves = 0;
    const original = h.ctx.contentStore.retrieve.bind(h.ctx.contentStore);
    h.ctx.contentStore.retrieve = async (...args) => {
      retrieves += 1;
      return original(...args);
    };
    await commitAndReveal(h, claim.market, 1n, remote.sha256, { committedAt: claim.createdAt, revealedAt: claim.createdAt + 5 });
    await commitAndReveal(h, claim.market, 2n, junk.sha256, { committedAt: claim.createdAt, revealedAt: claim.createdAt + 5 });
    const body = (await list(h, claim.market)).json();
    expect(retrieves).toBe(0);
    expect(body.items[0]).toMatchObject({ availability: { stored: false }, manifest: null });
    expect(body.items[1]).toMatchObject({ availability: { stored: true }, manifest: null, manifestError: "not a canonical evidence manifest" });
  });

  it("SEC-EVID-09 never fetches a manifest locator: no fetch, HTTP or socket attempt from the listing, detail or ERC-1497 routes", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "b2n");
    const locators = ["http://169.254.169.254/latest/meta-data/", "https://attacker.example/x.bin", "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy", "http://127.0.0.1:5432/"];
    const artifact = new Uint8Array(40).fill(6);
    const stored = await h.ctx.contentStore.put({ bytes: artifact, declaredMediaType: "text/plain", maxBytes: 262_144 });
    const manifest = exampleManifest(claim, RESEARCHER, { artifacts: [{ name: "a.txt", sha256: stored.sha256, size: 40, mediaType: "text/plain", locators, description: "" }] });
    const sha = await storeManifest(h, manifest);
    await commitAndReveal(h, claim.market, 1n, sha, { committedAt: claim.createdAt, revealedAt: claim.createdAt + 5 });
    const network = spyNetwork();
    try {
      // The spy is live: a direct attempt is recorded and blocked.
      expect(() => fetch("http://169.254.169.254/probe")).toThrow(/blocked/);
      expect(network.attempts).toHaveLength(1);
      network.attempts.length = 0;
      const listing = await list(h, claim.market);
      expect(listing.statusCode).toBe(200);
      expect(listing.json().items[0].manifest.artifacts[0].locators).toEqual(locators);
      expect((await h.app.inject({ method: "GET", url: `/api/v1/markets/${claim.market}/evidence/${EVIDENCE_REGISTRY}/1` })).statusCode).toBe(200);
      expect((await h.app.inject({ method: "GET", url: `/api/v1/markets/${claim.market}/evidence/${EVIDENCE_REGISTRY}/1/erc1497.json` })).statusCode).toBe(200);
      expect(network.attempts).toEqual([]);
    } finally {
      network.restore();
    }
    expect(h.chain.calls).toEqual([]);
  });

  it("filters by status, excludes hidden submissions and shows blocked ones as metadata only", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "b3");
    const sha = await storeManifest(h, exampleManifest(claim, RESEARCHER));
    await commitAndReveal(h, claim.market, 1n, sha, { committedAt: claim.createdAt, revealedAt: claim.createdAt + 5 });
    await commitAndReveal(h, claim.market, 2n, sha, { committedAt: claim.createdAt });
    await commitAndReveal(h, claim.market, 3n, sha, { committedAt: claim.createdAt, revealedAt: claim.createdAt + 5 });
    expect((await list(h, claim.market, "?status=committed")).json().items.map((item: { submissionId: string }) => item.submissionId)).toEqual(["2"]);
    h.ctx.moderation.set("evidence", `${EVIDENCE_REGISTRY}:3`, "hide", "spam");
    h.ctx.moderation.set("evidence", `${EVIDENCE_REGISTRY}:1`, "block", "illegal content");
    const items = (await list(h, claim.market)).json().items;
    expect(items.map((item: { submissionId: string }) => item.submissionId)).toEqual(["1", "2"]);
    expect(items[0]).toMatchObject({ contentSha256: sha, manifest: null, manifestError: "blocked by moderation", availability: { stored: false }, moderation: { action: "block", reason: "illegal content" } });
    expect((await list(h, claim.market, "?cursor=not-a-cursor")).statusCode).toBe(400);
  });

  it("pages 50 submissions at a time in on-chain order with a cursor", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "b5");
    h.b.nextBlock();
    h.ctx.readModel.apply(
      Array.from({ length: 51 }, (_, index) => ({ ...h.b.envelope(EVIDENCE_REGISTRY), kind: "EvidenceCommitted" as const, submissionId: BigInt(index + 1), market: claim.market, submitter: RESEARCHER, commitment: `0x${"c4".repeat(32)}` as Hex32, committedAt: claim.createdAt })),
    );
    await h.fresh();
    const first = (await list(h, claim.market)).json();
    expect(first.items.map((item: { submissionId: string }) => item.submissionId)).toEqual(Array.from({ length: 50 }, (_, index) => String(index + 1)));
    expect(first.nextCursor).not.toBeNull();
    const second = (await list(h, claim.market, `?cursor=${first.nextCursor}`)).json();
    expect(second.items.map((item: { submissionId: string }) => item.submissionId)).toEqual(["51"]);
    expect(second.nextCursor).toBeNull();
  });

  it("is public: identical responses with or without a session, and 404 for unknown markets", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "b4");
    const anonymous = await list(h, claim.market);
    // A second app (its own module, so its own listing cache) computes the response with a session at the same time:
    // the result must not depend on the session (the first app would just serve its cached copy).
    const second = await buildMarketsTestApp([createMarketsModule()], h.ctx, [], []);
    try {
      const withSession = await second.inject({ method: "GET", url: `/api/v1/markets/${claim.market}/evidence`, headers: { ...h.headers, cookie: "__Host-pine_session=pine_s1_abcdefghijklmnopqrstuv" } });
      expect(withSession.statusCode).toBe(200);
      expect(withSession.body).toBe(anonymous.body);
      expect(withSession.headers["set-cookie"]).toBeUndefined();
    } finally {
      await second.close();
    }
    expect((await list(h, "0x00000000000000000000000000000000000000c0" as Address)).statusCode).toBe(404);
  });

  it("caches a listing per (market, status, cursor) for 10 s on the server", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "b6");
    await commitAndReveal(h, claim.market, 1n, `0x${"00".repeat(32)}` as Hex32, { committedAt: claim.createdAt });
    const ids = (response: { json(): { items: { submissionId: string }[] } }) => response.json().items.map((item) => item.submissionId);
    const first = await list(h, claim.market);
    expect(ids(first)).toEqual(["1"]);
    // A new submission indexed inside the window is not visible on the cached key...
    await commitAndReveal(h, claim.market, 2n, `0x${"00".repeat(32)}` as Hex32, { committedAt: claim.createdAt });
    const listEvidence = vi.spyOn(h.ctx.readModel, "listEvidence");
    h.at(h.ctx.clock.unix() + 9);
    const cached = await list(h, claim.market);
    expect(cached.body).toBe(first.body);
    expect(listEvidence).not.toHaveBeenCalled();
    // ...but another status or cursor is another key.
    expect(ids(await list(h, claim.market, "?status=committed"))).toEqual(["1", "2"]);
    expect(listEvidence).toHaveBeenCalledTimes(1);
    // After 10 s the key is recomputed.
    h.at(h.ctx.clock.unix() + 1);
    await h.fresh();
    expect(ids(await list(h, claim.market))).toEqual(["1", "2"]);
    expect(listEvidence).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/v1/markets/:market/evidence/:registry/:submissionId", () => {
  it("computes retrievable through the content store only on the detail route and caches it for 10 minutes", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "d1");
    const remote = encodeEvidenceManifest(exampleManifest(claim, RESEARCHER));
    await commitAndReveal(h, claim.market, 1n, remote.sha256, { committedAt: claim.createdAt, revealedAt: claim.createdAt + 5 });
    let retrieves = 0;
    const original = h.ctx.contentStore.retrieve.bind(h.ctx.contentStore);
    h.ctx.contentStore.retrieve = async (...args) => {
      retrieves += 1;
      return original(...args);
    };
    const url = `/api/v1/markets/${claim.market}/evidence/${EVIDENCE_REGISTRY}/1`;
    const first = (await h.app.inject({ method: "GET", url })).json();
    expect(first.submission.availability).toMatchObject({ stored: false, retrievable: false });
    h.ctx.contentStore.remote.set(remote.sha256, remote.bytes);
    await h.app.inject({ method: "GET", url });
    expect(retrieves).toBe(1);
    h.at(h.ctx.clock.unix() + 601);
    await h.fresh();
    const later = (await h.app.inject({ method: "GET", url })).json();
    expect(retrieves).toBe(2);
    expect(later.submission.availability).toMatchObject({ retrievable: true });
    expect((await h.app.inject({ method: "GET", url: `/api/v1/markets/${claim.market}/evidence/${EVIDENCE_REGISTRY}/99` })).statusCode).toBe(404);
  });

  it("shows hidden submissions by exact id with the reason", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "d2");
    await commitAndReveal(h, claim.market, 1n, `0x${"98".repeat(32)}`, { committedAt: claim.createdAt });
    h.ctx.moderation.set("evidence", `${EVIDENCE_REGISTRY}:1`, "hide", "duplicate");
    const body = (await h.app.inject({ method: "GET", url: `/api/v1/markets/${claim.market}/evidence/${EVIDENCE_REGISTRY}/1` })).json();
    expect(body.submission.moderation).toMatchObject({ action: "hide", reason: "duplicate" });
  });
});

describe("GET .../erc1497.json", () => {
  it("returns ERC-1497 evidence JSON for Kleros jurors with mainnet instructions (no plan)", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "e1");
    const sha = await storeManifest(h, exampleManifest(claim, RESEARCHER, { title: "Gas reserve drained" }));
    await commitAndReveal(h, claim.market, 4n, sha, { committedAt: claim.createdAt, revealedAt: claim.createdAt + 5 });
    const response = await h.app.inject({ method: "GET", url: `/api/v1/markets/${claim.market}/evidence/${EVIDENCE_REGISTRY}/4/erc1497.json` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.evidence).toEqual({
      name: `Pine evidence #4 for market ${claim.market}`,
      description: expect.stringContaining("Manifest title (untrusted, as submitted): Gas reserve drained"),
      fileURI: `ipfs://${rawCidFromSha256(sha)}`,
      fileHash: sha,
      fileTypeExtension: "json",
    });
    expect(body.instructions).toMatchObject({
      chainId: 1,
      foreignProxy: "0xfe0eb5fc686f929eb26d541d75bb59f816c0aa68",
      function: "submitEvidence(uint256 _arbitrationID, string _evidenceURI)",
      arbitrationIds: [{ questionId: claim.questionId, arbitrationId: BigInt(claim.questionId).toString(10) }],
    });
    expect(body).not.toHaveProperty("plan");
  });

  it("refuses undisclosed and blocked submissions", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "e2");
    await commitAndReveal(h, claim.market, 1n, `0x${"97".repeat(32)}`, { committedAt: claim.createdAt });
    expect((await h.app.inject({ method: "GET", url: `/api/v1/markets/${claim.market}/evidence/${EVIDENCE_REGISTRY}/1/erc1497.json` })).statusCode).toBe(409);
    await commitAndReveal(h, claim.market, 2n, `0x${"96".repeat(32)}`, { committedAt: claim.createdAt, revealedAt: claim.createdAt + 1 });
    h.ctx.moderation.set("content", `0x${"96".repeat(32)}`, "block", "illegal");
    expect((await h.app.inject({ method: "GET", url: `/api/v1/markets/${claim.market}/evidence/${EVIDENCE_REGISTRY}/2/erc1497.json` })).statusCode).toBe(451);
  });
});

describe("SEC-EVID-11 the listing caches only the read-model page (PRD-07 section 3)", () => {
  it("SEC-EVID-11 blocking the evidence after a cached listing removes the manifest from the next listing; sent with no-store", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "x1");
    const sha = await storeManifest(h, exampleManifest(claim, RESEARCHER));
    await commitAndReveal(h, claim.market, 1n, sha, { committedAt: claim.createdAt, revealedAt: claim.createdAt + 5 });
    const first = await list(h, claim.market);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.json().items[0]).toMatchObject({ manifest: { title: "Reporter deposit draws from the gas reserve" }, manifestError: null, moderation: null });
    const listEvidence = vi.spyOn(h.ctx.readModel, "listEvidence");
    h.ctx.moderation.set("evidence", `${EVIDENCE_REGISTRY}:1`, "block", "illegal content");
    const next = await list(h, claim.market);
    // The page still comes from the 10 s cache; moderation and the manifest are computed for this response.
    expect(listEvidence).not.toHaveBeenCalled();
    expect(next.headers["cache-control"]).toBe("no-store");
    expect(next.json().items[0]).toMatchObject({ submissionId: "1", contentSha256: sha, manifest: null, manifestError: "blocked by moderation", availability: { stored: false }, moderation: { action: "block" } });
    expect(next.body).not.toContain("Reporter deposit draws from the gas reserve");
  });

  it("SEC-EVID-11 blocking the content after a cached listing removes the manifest from the next listing", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "x2");
    const sha = await storeManifest(h, exampleManifest(claim, RESEARCHER));
    await commitAndReveal(h, claim.market, 1n, sha, { committedAt: claim.createdAt, revealedAt: claim.createdAt + 5 });
    expect((await list(h, claim.market)).json().items[0].manifest).not.toBeNull();
    h.ctx.moderation.set("content", sha, "block", "illegal content");
    const next = await list(h, claim.market);
    expect(next.json().items[0]).toMatchObject({ manifest: null, manifestError: "blocked by moderation", moderation: { action: "block" } });
    expect(next.body).not.toContain("Reporter deposit draws from the gas reserve");
  });

  it("SEC-EVID-11 the detail and ERC-1497 routes are sent with no-store too", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "x3");
    const sha = await storeManifest(h, exampleManifest(claim, RESEARCHER));
    await commitAndReveal(h, claim.market, 1n, sha, { committedAt: claim.createdAt, revealedAt: claim.createdAt + 5 });
    const url = `/api/v1/markets/${claim.market}/evidence/${EVIDENCE_REGISTRY}/1`;
    expect((await h.app.inject({ method: "GET", url })).headers["cache-control"]).toBe("no-store");
    expect((await h.app.inject({ method: "GET", url: `${url}/erc1497.json` })).headers["cache-control"]).toBe("no-store");
  });
});

describe("evidence detail: retrieve fan-out cap (PRD-07 section 3)", () => {
  it("caps concurrent retrieve cache misses at 4: a 5th is 429 at once and caches nothing; slots are released", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "f1");
    const manifests = Array.from({ length: 5 }, (_, index) => encodeEvidenceManifest(exampleManifest(claim, RESEARCHER, { title: `Finding ${index + 1}` })));
    for (const [index, manifest] of manifests.entries()) {
      await commitAndReveal(h, claim.market, BigInt(index + 1), manifest.sha256, { committedAt: claim.createdAt, revealedAt: claim.createdAt + 5 });
    }
    const store = h.ctx.contentStore;
    const realRetrieve = store.retrieve.bind(store);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = 0;
    let retrieves = 0;
    store.retrieve = async (sha256, maxBytes) => {
      retrieves += 1;
      waiting += 1;
      await gate;
      waiting -= 1;
      return realRetrieve(sha256, maxBytes);
    };
    const detail = (id: number) => h.app.inject({ method: "GET", url: `/api/v1/markets/${claim.market}/evidence/${EVIDENCE_REGISTRY}/${id}` });
    const inFlight = [1, 2, 3, 4].map((id) => detail(id));
    await vi.waitFor(() => expect(waiting).toBe(4));
    const refused = await detail(5);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("RATE_LIMITED");
    expect(refused.headers["retry-after"]).toBe(String(RETRIEVE_RETRY_AFTER_SECONDS));
    // Refused before the content store was asked: no 5th retrieve is waiting.
    expect(retrieves).toBe(4);
    release();
    expect((await Promise.all(inFlight)).map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    // No false `retrievable` was cached for the refused miss: the next request asks the store and sees the remote copy.
    const fifth = manifests[4]!;
    store.remote.set(fifth.sha256, fifth.bytes);
    const served = await detail(5);
    expect(served.statusCode).toBe(200);
    expect(retrieves).toBe(5);
    expect(served.json().submission.availability).toMatchObject({ retrievable: true });
    expect(RETRIEVE_MAX_IN_FLIGHT).toBe(4);
  });
});

describe("evidence detail and oracle status have separate fan-out limiters (PRD-07 3c)", () => {
  const status = (h: Harness, market: Address, n: number) => h.app.inject({ method: "GET", url: `/api/v1/markets/${market}/oracle?account=0x${n.toString(16).padStart(40, "0")}` });
  const detail = (h: Harness, market: Address, id: number) => h.app.inject({ method: "GET", url: `/api/v1/markets/${market}/evidence/${EVIDENCE_REGISTRY}/${id}` });

  /** A claim past its reveal deadline (oracle status reads the chain) with five revealed submissions not stored locally. */
  async function claimWithSubmissions(h: Harness, seed: string) {
    const claim = await addClaim(h, seed);
    for (let id = 1; id <= 5; id += 1) {
      const manifest = encodeEvidenceManifest(exampleManifest(claim, RESEARCHER, { title: `Separate ${id}` }));
      await commitAndReveal(h, claim.market, BigInt(id), manifest.sha256, { committedAt: claim.createdAt, revealedAt: claim.createdAt + 5 });
    }
    h.b.nextBlock(claim.revealDeadline + 10 - h.b.now());
    h.at(h.b.now());
    await h.fresh();
    return claim;
  }

  it("four oracle misses holding every slot of the oracle limiter leave the evidence detail retrieve its own slot", async () => {
    const h = harnessOf();
    const claim = await claimWithSubmissions(h, "sep1");
    const held = h.chain.hold();
    try {
      const inFlight = [1, 2, 3, 4].map((n) => status(h, claim.market, n));
      await vi.waitFor(() => expect(held.waiting()).toBe(4));
      // The oracle limiter is full ...
      expect((await status(h, claim.market, 5)).statusCode).toBe(429);
      // ... and the detail route's cache miss still calls the content store.
      const served = await detail(h, claim.market, 1);
      expect(served.statusCode, served.body).toBe(200);
      expect(served.json().submission.availability).toMatchObject({ retrievable: false });
      held.release();
      expect((await Promise.all(inFlight)).map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    } finally {
      held.release();
    }
  });

  it("four retrieve misses holding every slot of the retrieve limiter leave the oracle status its own slot", async () => {
    const h = harnessOf();
    const claim = await claimWithSubmissions(h, "sep2");
    const store = h.ctx.contentStore;
    const realRetrieve = store.retrieve.bind(store);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = 0;
    store.retrieve = async (sha256, maxBytes) => {
      waiting += 1;
      await gate;
      return realRetrieve(sha256, maxBytes);
    };
    try {
      const inFlight = [1, 2, 3, 4].map((id) => detail(h, claim.market, id));
      await vi.waitFor(() => expect(waiting).toBe(4));
      expect((await detail(h, claim.market, 5)).statusCode).toBe(429);
      const served = await status(h, claim.market, 1);
      expect(served.statusCode, served.body).toBe(200);
      expect(served.json().questionId).toBe(claim.questionId);
      release();
      expect((await Promise.all(inFlight)).map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    } finally {
      release();
    }
  });
});
