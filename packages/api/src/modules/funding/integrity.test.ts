import { releaseSuiteLock } from "./test/lock.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeClaimDocument, type ClaimDocument } from "@pine/shared/claim-document";
import type { ClaimRecord } from "@pine/shared/read-model";
import { exampleClaimDocument } from "@pine/shared/testing/fixtures";
import type { Address, Hex32 } from "@pine/shared/types";
import { manifestOf } from "./common.js";
import { claimDocumentMismatches } from "./integrity.js";
import { createHarness, postPlan, refreshIndexer, seedClaim, WAD, type Harness } from "./test/harness.js";

afterAll(releaseSuiteLock);

const LADDER = "/api/v1/funding/plans/ladder";
let h: Harness;
let counter = 0;

function nextMarket() {
  counter += 1;
  const suffix = counter.toString(16).padStart(4, "0");
  return {
    market: `0x00000000000000000000000000000000001c${suffix}` as Address,
    yesToken: `0x20000000000000000000000000000000001c${suffix}` as Address,
    noToken: `0x30000000000000000000000000000000001c${suffix}` as Address,
    invalidToken: `0x40000000000000000000000000000000001c${suffix}` as Address,
  };
}

const body = (market: Address) => ({
  market,
  budgetWei: (10n * WAD).toString(),
  lowerPrice: "0.2",
  upperPrice: "0.9",
  riskAcknowledgement: { budgetWei: (10n * WAD).toString(), maxLossIfYesShares: (10n * WAD).toString() },
});

async function planCount(): Promise<number> {
  const rows = await h.ctx.database.sql.query<{ count: string }>("SELECT count(*)::text AS count FROM funding_plans");
  return Number(rows[0]?.count ?? "0");
}

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(() => refreshIndexer(h));

describe("inline integrity gate over HTTP (PRD-04 3.2 step 1)", () => {
  it("passes for a claim whose stored document matches", async () => {
    const tokens = nextMarket();
    seedClaim(h.ctx, tokens);
    expect((await postPlan(h, LADDER, body(tokens.market))).statusCode).toBe(200);
  });

  it("SEC-IDX-08 an unavailable claim document is INTEGRITY_FAILED and no plan is stored", async () => {
    const tokens = nextMarket();
    seedClaim(h.ctx, { ...tokens, document: exampleClaimDocument({ nonce: `0x${"ab".repeat(32)}` as Hex32 }), storeDocument: false });
    const before = await planCount();
    const response = await postPlan(h, LADDER, body(tokens.market));
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("INTEGRITY_FAILED");
    expect(response.json().error.issues).toEqual([{ path: ["claimDocument"], message: "document_unavailable" }]);
    expect(await planCount()).toBe(before);
  });

  it("a document available only from a trusted remote copy is retrieved and verified", async () => {
    const tokens = nextMarket();
    const document = exampleClaimDocument({ nonce: `0x${"cd".repeat(32)}` as Hex32 });
    const seeded = seedClaim(h.ctx, { ...tokens, document, storeDocument: false });
    h.ctx.contentStore.remote.set(seeded.claimDocumentSha256, encodeClaimDocument(document).bytes);
    expect((await postPlan(h, LADDER, body(tokens.market))).statusCode).toBe(200);
  });

  it("SEC-IDX-08 a mismatching on-chain record names the failed fields and returns no plan", async () => {
    const tokens = nextMarket();
    seedClaim(h.ctx, { ...tokens, document: exampleClaimDocument({ nonce: `0x${"ef".repeat(32)}` as Hex32 }), mutateEvent: (event) => (event.creator = "0x00000000000000000000000000000000000e5c11") });
    const before = await planCount();
    const response = await postPlan(h, LADDER, body(tokens.market));
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("INTEGRITY_FAILED");
    expect(response.json().error.message).toMatch(/creator/);
    expect(await planCount()).toBe(before);
  });

  it("SEC-CLAIM-01 bytes that are not the canonical document for the digest are INTEGRITY_FAILED", async () => {
    const tokens = nextMarket();
    const seeded = seedClaim(h.ctx, { ...tokens, document: exampleClaimDocument({ nonce: `0x${"12".repeat(32)}` as Hex32 }), storeDocument: false });
    // A non-canonical encoding (pretty-printed JSON) of the same document has another digest, so it can never be served
    // for this one; simulate a store returning wrong bytes for the digest.
    const original = h.ctx.contentStore.retrieve.bind(h.ctx.contentStore);
    h.ctx.contentStore.retrieve = async (sha256, maxBytes) =>
      sha256 === seeded.claimDocumentSha256 ? new TextEncoder().encode(JSON.stringify(seeded.document, null, 2)) : original(sha256, maxBytes);
    try {
      const response = await postPlan(h, LADDER, body(tokens.market));
      expect(response.statusCode).toBe(409);
      expect(response.json().error.issues).toEqual([{ path: ["claimDocument"], message: "invalid" }]);
    } finally {
      h.ctx.contentStore.retrieve = original;
    }
  });
});

describe("registered claims only (PRD-04 4a: requireClaim checks the ClaimRegistry like markets does)", () => {
  it("a claim created by another ClaimRegistry is NOT_FOUND on every funding route, before any chain read or integrity check", async () => {
    const tokens = nextMarket();
    seedClaim(h.ctx, { ...tokens, document: exampleClaimDocument({ nonce: `0x${"56".repeat(32)}` as Hex32 }), mutateEvent: (event) => (event.address = "0x00000000000000000000000000000000000c1a11") });
    const claim = await h.ctx.readModel.getClaim(tokens.market);
    expect(claim?.registry).toBe("0x00000000000000000000000000000000000c1a11");
    const before = await planCount();
    const reads = h.chain.calls.length;
    const posts: [string, unknown][] = [
      [LADDER, body(tokens.market)],
      ["/api/v1/funding/plans/withdraw", { market: tokens.market, tokenId: "1" }],
      ["/api/v1/funding/plans/merge", { market: tokens.market, amount: WAD.toString() }],
      ["/api/v1/funding/plans/redeem", { market: tokens.market }],
    ];
    for (const [path, payload] of posts) {
      const response = await postPlan(h, path, payload);
      expect(response.statusCode, path).toBe(404);
      expect(response.json().error.code, path).toBe("NOT_FOUND");
    }
    for (const url of [`/api/v1/markets/${tokens.market}/liquidity`, `/api/v1/funding/positions/0x00000000000000000000000000000000000a11ce?market=${tokens.market}`]) {
      expect((await h.app.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
    expect(h.chain.calls.length).toBe(reads);
    expect(await planCount()).toBe(before);
  });
});

describe("field comparison (PRD-03 section 7)", () => {
  const manifestFor = () => manifestOf(h.ctx.config);
  let base: { document: ClaimDocument; claim: ClaimRecord };

  beforeAll(async () => {
    const tokens = nextMarket();
    const seeded = seedClaim(h.ctx, { ...tokens, document: exampleClaimDocument({ nonce: `0x${"34".repeat(32)}` as Hex32 }) });
    const claim = await h.ctx.readModel.getClaim(seeded.market);
    if (!claim) throw new Error("claim not seeded");
    base = { document: seeded.document, claim };
  });

  it("a matching document has no mismatches", () => {
    expect(claimDocumentMismatches(base.document, base.claim, manifestFor())).toEqual([]);
  });

  const claimMutations: [string, (claim: ClaimRecord) => void, string[]][] = [
    ["creator", (claim) => (claim.creator = "0x00000000000000000000000000000000000e5c11"), ["creator"]],
    ["repository id", (claim) => (claim.repositoryId += 1), ["target.repository.id", "marketName"]],
    ["commit", (claim) => (claim.commit = "cd".repeat(20)), ["target.commit", "marketName"]],
    ["policy sha256", (claim) => (claim.policyDocumentSha256 = `0x${"99".repeat(32)}` as Hex32), ["policy.sha256", "marketName"]],
    ["evidence deadline", (claim) => (claim.evidenceDeadline += 60), ["evidence.evidenceDeadline", "marketName"]],
    ["reveal deadline", (claim) => (claim.revealDeadline += 60), ["evidence.revealDeadline", "market.openingTime", "marketName"]],
    ["min bond", (claim) => (claim.minBond += 1n), ["market.minBondWei"]],
    ["title", (claim) => (claim.title = "Another title"), ["claim.title", "marketName"]],
    ["claim registry", (claim) => (claim.registry = "0x00000000000000000000000000000000000c1a11"), ["market.claimRegistry"]],
    ["market name", (claim) => (claim.marketName = `${claim.marketName} `), ["marketName"]],
    ["unrenderable repository id", (claim) => (claim.repositoryId = 2 ** 53), ["target.repository.id", "marketName"]],
  ];
  for (const [name, mutate, fields] of claimMutations) {
    it(`detects a mismatching ${name}`, () => {
      const claim = structuredClone(base.claim);
      mutate(claim);
      expect(claimDocumentMismatches(base.document, claim, manifestFor())).toEqual(fields);
    });
  }

  const documentMutations: [string, (document: ClaimDocument) => void, string][] = [
    ["Seer market factory", (document) => (document.market.seerMarketFactory = "0x00000000000000000000000000000000000fac70"), "market.seerMarketFactory"],
    ["collateral token", (document) => (document.market.collateralToken = "0x00000000000000000000000000000000000c0a17"), "market.collateralToken"],
    ["realitio", (document) => (document.market.realitio = "0x0000000000000000000000000000000000000e71"), "market.realitio"],
    ["arbitrator", (document) => (document.market.arbitrator = "0x00000000000000000000000000000000000a7b17"), "market.arbitrator"],
    ["question timeout", (document) => (document.market.questionTimeoutSeconds += 1), "market.questionTimeoutSeconds"],
    ["market chain id", (document) => (document.market.chainId = 1), "market.chainId"],
    ["evidence chain id", (document) => (document.evidence.chainId = 1), "evidence.chainId"],
    ["evidence registry", (document) => (document.evidence.registry = "0x00000000000000000000000000000000000e01df"), "evidence.registry"],
    ["claim registry", (document) => (document.market.claimRegistry = "0x00000000000000000000000000000000000c1a11"), "market.claimRegistry"],
  ];
  for (const [name, mutate, field] of documentMutations) {
    it(`detects a document ${name} that differs from the deployment manifest`, () => {
      const document = structuredClone(base.document);
      mutate(document);
      expect(claimDocumentMismatches(document, base.claim, manifestFor())).toEqual([field]);
    });
  }
});
