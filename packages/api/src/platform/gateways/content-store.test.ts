// Must stay the first import: serializes the memory-heavy (PGlite) gateways test files across vitest workers.
import "./testing/suite-lock.js";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { identify, RAW_CID_MAX_BYTES, rawCidFromBytes, rawCidFromSha256 } from "@pine/shared/canonical";
import type { Hex32 } from "@pine/shared/types";
import type { AppContext } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { JOB_NAMES } from "./index.js";
import { createHarness, GATEWAY_URLS, jsonResponse, KUBO_URL, PINNING_TOKEN, PINNING_URL, streamedResponse, testSecrets, type Harness } from "./testing/harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

const store = () => h.gateways.contentStore;
const bytesOf = (text: string) => new TextEncoder().encode(text);
const GW1 = "https://gw1.ipfs.test";
const GW2 = "https://gw2.ipfs.test";
const rawUrl = (base: string, sha256: Hex32) => `${base}/ipfs/${rawCidFromSha256(sha256)}?format=raw`;

async function count(table: string): Promise<number> {
  const rows = await h.database.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]?.n ?? 0;
}

describe("put / get / has", () => {
  it("SEC-EVID-03 computes sha256 and the raw CID server-side and stores the bytes", async () => {
    const bytes = bytesOf("<html><script>alert(1)</script></html>");
    const record = await store().put({ bytes, declaredMediaType: "text/html", maxBytes: 1_000 });
    const id = identify(bytes);
    expect(record).toEqual({ sha256: id.sha256, size: bytes.byteLength, cid: id.cid, declaredMediaType: "text/html" });
    expect(record.cid).toMatch(/^bafkrei[a-z2-7]{52}$/);
    const got = await store().get(id.sha256);
    expect(got?.record).toEqual(record);
    expect(Buffer.from(got?.bytes ?? []).equals(Buffer.from(bytes))).toBe(true);
    expect(await store().has(id.sha256)).toBe(true);
    expect(await store().has(`0x${"00".repeat(32)}` as Hex32)).toBe(false);
    expect(await store().get(`0x${"00".repeat(32)}` as Hex32)).toBeNull();
  });

  it("is idempotent: the same bytes twice keep one row, one pin item and the first declared media type", async () => {
    const bytes = bytesOf("same");
    const first = await store().put({ bytes, declaredMediaType: "text/plain", maxBytes: 100 });
    const second = await store().put({ bytes, declaredMediaType: "image/png", maxBytes: 100 });
    expect(second).toEqual(first);
    expect(await count("content_blobs")).toBe(1);
    expect(await count("content_pins")).toBe(1);
  });

  it("stores an unusable declared media type as application/octet-stream", async () => {
    const record = await store().put({ bytes: bytesOf("x"), declaredMediaType: "text/html\r\nSet-Cookie: a=b", maxBytes: 100 });
    expect(record.declaredMediaType).toBe("application/octet-stream");
  });

  it("rejects content above maxBytes or above one raw block (262144 bytes) with PAYLOAD_TOO_LARGE and stores nothing", async () => {
    const tooBigForCaller = await store().put({ bytes: new Uint8Array(101), declaredMediaType: "text/plain", maxBytes: 100 }).catch((error: unknown) => error);
    expect(tooBigForCaller).toBeInstanceOf(ApiError);
    expect((tooBigForCaller as ApiError).code).toBe("PAYLOAD_TOO_LARGE");
    const tooBigForBlock = await store()
      .put({ bytes: new Uint8Array(RAW_CID_MAX_BYTES + 1), declaredMediaType: "text/plain", maxBytes: 10_000_000 })
      .catch((error: unknown) => error);
    expect((tooBigForBlock as ApiError).code).toBe("PAYLOAD_TOO_LARGE");
    expect(await count("content_blobs")).toBe(0);
    const exact = await store().put({ bytes: new Uint8Array(RAW_CID_MAX_BYTES), declaredMediaType: "application/octet-stream", maxBytes: RAW_CID_MAX_BYTES });
    expect(exact.size).toBe(RAW_CID_MAX_BYTES);
  });

  it("SEC-EVID-11 blocked content is never returned by get, has or retrieve; hidden content still is", async () => {
    const record = await store().put({ bytes: bytesOf("blocked"), declaredMediaType: "text/plain", maxBytes: 100 });
    h.moderation.set("content", record.sha256.toUpperCase(), "block", "illegal");
    expect(await store().get(record.sha256)).toBeNull();
    expect(await store().has(record.sha256)).toBe(false);
    expect(await store().retrieve(record.sha256, 1_000)).toBeNull();
    expect(h.fetch.calls).toHaveLength(0);
    h.moderation.set("content", record.sha256, "hide", "spam");
    expect(await store().get(record.sha256)).not.toBeNull();
  });

  it("never serves local bytes whose digest does not match their key", async () => {
    const record = await store().put({ bytes: bytesOf("original"), declaredMediaType: "text/plain", maxBytes: 100 });
    await h.database.sql.query("UPDATE content_blobs SET bytes = $1 WHERE sha256 = $2", [Buffer.from("tampered"), record.sha256]);
    expect(await store().get(record.sha256)).toBeNull();
    expect(h.metrics.counters.get(`content_integrity_failed${JSON.stringify({ source: "local" })}`)).toBe(1);
  });
});

describe("retrieve (SEC-EVID-09)", () => {
  const remote = new Uint8Array(randomBytes(50_000));
  const remoteId = identify(remote);
  const sha256 = remoteId.sha256;

  it("returns local content without any fetch", async () => {
    await store().put({ bytes: remote, declaredMediaType: "application/zip", maxBytes: RAW_CID_MAX_BYTES });
    const bytes = await store().retrieve(sha256, RAW_CID_MAX_BYTES);
    expect(bytes?.byteLength).toBe(remote.byteLength);
    expect(h.fetch.calls).toHaveLength(0);
  });

  it("fetches by the raw CID from the configured gateways only, verifies the digest and stores a local copy", async () => {
    h.fetch.on("GET", rawUrl(GW1, sha256), () => new Response(Buffer.from(remote), { status: 200 }));
    const bytes = await store().retrieve(sha256, RAW_CID_MAX_BYTES);
    expect(Buffer.from(bytes ?? []).equals(Buffer.from(remote))).toBe(true);
    expect(h.fetch.calls).toHaveLength(1);
    const call = h.fetch.calls[0];
    expect(call?.url).toBe(`${GW1}/ipfs/${remoteId.cid}?format=raw`);
    expect(call?.headers.get("accept")).toBe("application/vnd.ipld.raw");
    expect(call?.redirect).toBe("error");
    // Stored: the next read is local.
    expect((await store().get(sha256))?.record).toEqual({ sha256, size: remote.byteLength, cid: remoteId.cid, declaredMediaType: "application/octet-stream" });
    h.fetch.calls.length = 0;
    await store().retrieve(sha256, RAW_CID_MAX_BYTES);
    expect(h.fetch.calls).toHaveLength(0);
  });

  it("SEC-EVID-09 rejects bytes whose digest does not match and tries the next gateway", async () => {
    h.fetch.on("GET", rawUrl(GW1, sha256), () => new Response(Buffer.from("attacker bytes"), { status: 200 }));
    h.fetch.on("GET", rawUrl(GW2, sha256), () => new Response(Buffer.from(remote), { status: 200 }));
    const bytes = await store().retrieve(sha256, RAW_CID_MAX_BYTES);
    expect(identify(bytes ?? new Uint8Array()).sha256).toBe(sha256);
    expect(h.metrics.counters.get(`content_integrity_failed${JSON.stringify({ source: "gateway" })}`)).toBe(1);
    expect(h.fetch.calls.map((call) => new URL(call.url).origin)).toEqual([GW1, GW2]);
  });

  it("SEC-EVID-09 a digest mismatch on every gateway returns null and stores nothing", async () => {
    for (const base of [GW1, GW2]) h.fetch.on("GET", rawUrl(base, sha256), () => new Response(Buffer.from("wrong"), { status: 200 }));
    expect(await store().retrieve(sha256, RAW_CID_MAX_BYTES)).toBeNull();
    expect(await count("content_blobs")).toBe(0);
  });

  it("SEC-EVID-09 refuses redirects: the Location is never fetched", async () => {
    for (const base of [GW1, GW2]) {
      h.fetch.on("GET", rawUrl(base, sha256), () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }));
    }
    h.fetch.on("GET", /169\.254\.169\.254/, () => new Response(Buffer.from(remote), { status: 200 }));
    expect(await store().retrieve(sha256, RAW_CID_MAX_BYTES)).toBeNull();
    expect(h.fetch.calls.every((call) => call.redirect === "error")).toBe(true);
    expect(h.fetch.callsTo(/169\.254\.169\.254/)).toHaveLength(0);
  });

  it("treats a 3xx answered despite redirect: error as a failure too", async () => {
    // A fetch implementation that returns the redirect instead of rejecting must not be trusted either.
    const lenient = h.fetch.fetch;
    const original = Object.getOwnPropertyDescriptor(h.fetch, "fetch");
    Object.defineProperty(h.fetch, "fetch", { value: (url: string, init: RequestInit) => lenient(url, { ...init, redirect: "manual" }) });
    try {
      const process2 = await h.sibling();
      for (const base of [GW1, GW2]) h.fetch.on("GET", rawUrl(base, sha256), () => new Response(Buffer.from(remote), { status: 301, headers: { location: "https://elsewhere.test/" } }));
      expect(await process2.contentStore.retrieve(sha256, RAW_CID_MAX_BYTES)).toBeNull();
      expect(await count("content_blobs")).toBe(0);
    } finally {
      if (original) Object.defineProperty(h.fetch, "fetch", original);
    }
  });

  it("caps the streamed response at maxBytes even without Content-Length", async () => {
    const big = new Uint8Array(randomBytes(200_000));
    const bigSha = identify(big).sha256;
    for (const base of [GW1, GW2]) h.fetch.on("GET", rawUrl(base, bigSha), () => streamedResponse(big));
    expect(await store().retrieve(bigSha, 100_000)).toBeNull();
    for (const base of [GW1, GW2]) h.fetch.on("GET", rawUrl(base, bigSha), () => new Response(Buffer.from(big), { status: 200, headers: { "content-length": String(big.byteLength) } }));
    expect(await store().retrieve(bigSha, 100_000)).toBeNull();
    expect(await count("content_blobs")).toBe(0);
    for (const base of [GW1, GW2]) h.fetch.on("GET", rawUrl(base, bigSha), () => streamedResponse(big));
    expect((await store().retrieve(bigSha, 200_000))?.byteLength).toBe(200_000);
  });

  it("returns null for malformed digests without fetching and only ever contacts configured gateways", async () => {
    expect(await store().retrieve("0x1234" as Hex32, 1_000)).toBeNull();
    expect(await store().retrieve("http://169.254.169.254/" as Hex32, 1_000)).toBeNull();
    expect(h.fetch.calls).toHaveLength(0);
    for (const base of [GW1, GW2]) h.fetch.json("GET", rawUrl(base, sha256), 404, {});
    expect(await store().retrieve(sha256, RAW_CID_MAX_BYTES)).toBeNull();
    const configured = GATEWAY_URLS.map((url) => new URL(url).origin);
    expect(h.fetch.calls.every((call) => configured.includes(new URL(call.url).origin))).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ pin outbox

const BLOCK_PUT = `${KUBO_URL}/api/v0/block/put?cid-codec=raw&mhtype=sha2-256&mhlen=32&pin=false`;
const OTHER_CID = rawCidFromBytes(new TextEncoder().encode("something else"));
const pinBytes = new TextEncoder().encode("evidence pinBytes");
const cid = rawCidFromBytes(pinBytes);

async function runJob(gateways = h.gateways) {
  const job = gateways.jobs.find((item) => item.name === JOB_NAMES.pinOutbox);
  if (!job) throw new Error("pin job missing");
  await job.run(undefined as unknown as AppContext, new AbortController().signal);
}

async function pinRow() {
  const rows = await h.database.sql.query<{ status: string; kubo_done: boolean; service_done: boolean; attempts: number; last_error: string | null }>(
    "SELECT status, kubo_done, service_done, attempts, last_error FROM content_pins",
  );
  return rows[0];
}

function scriptKubo(blockCid = cid, pinCid = cid) {
  h.fetch.json("POST", BLOCK_PUT, 200, { Key: blockCid, Size: pinBytes.byteLength });
  h.fetch.json("POST", `${KUBO_URL}/api/v0/pin/add?arg=${cid}`, 200, { Pins: [pinCid] });
}

function scriptService(existing: string[] = [], createdCid = cid) {
  h.fetch.json("GET", `${PINNING_URL}/pins?cid=${cid}&status=queued,pinning,pinned&limit=10`, 200, {
    count: existing.length,
    results: existing.map((value) => ({ requestid: "r0", status: "pinned", created: "2026-10-01T00:00:00Z", pin: { cid: value }, delegates: [] })),
  });
  h.fetch.json("POST", `${PINNING_URL}/pins`, 202, { requestid: "r1", status: "queued", created: "2026-10-01T00:00:00Z", pin: { cid: createdCid }, delegates: [] });
}

describe("pin outbox (ADR-0001 D11)", () => {
  it("puts the raw block into Kubo, pins it, asks the pinning service and marks the item pinned", async () => {
    await h.gateways.contentStore.put({ bytes: pinBytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
    scriptKubo();
    scriptService();
    await runJob();
    expect(await pinRow()).toMatchObject({ status: "pinned", kubo_done: true, service_done: true });
    // Kubo block/put, then pin/add, then the pinning service (look up existing requests, then create one).
    expect(h.fetch.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${BLOCK_PUT}`,
      `POST ${KUBO_URL}/api/v0/pin/add?arg=${cid}`,
      `GET ${PINNING_URL}/pins?cid=${cid}&status=queued,pinning,pinned&limit=10`,
      `POST ${PINNING_URL}/pins`,
    ]);
    const put = h.fetch.callsTo(BLOCK_PUT)[0];
    const file = put?.body instanceof FormData ? put.body.get("file") : null;
    expect(file).toBeInstanceOf(Blob);
    expect(Buffer.from(await (file as Blob).arrayBuffer()).equals(Buffer.from(pinBytes))).toBe(true);
    const create = h.fetch.callsTo(`${PINNING_URL}/pins`)[0];
    expect(create?.headers.get("authorization")).toBe(`Bearer ${PINNING_TOKEN}`);
    expect(JSON.parse(create?.bodyText ?? "{}")).toMatchObject({ cid });
    expect(h.fetch.calls.every((call) => call.redirect === "error")).toBe(true);
    // Done items are not processed again.
    h.fetch.calls.length = 0;
    await runJob();
    expect(h.fetch.calls).toHaveLength(0);
  });

  it("a Kubo CID that differs from the local CID marks the item integrity_failed and alerts", async () => {
    await h.gateways.contentStore.put({ bytes: pinBytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
    scriptKubo(OTHER_CID);
    scriptService();
    await runJob();
    expect(await pinRow()).toMatchObject({ status: "integrity_failed", kubo_done: false });
    expect(h.metrics.counters.get("content_pin_integrity_failed{}")).toBe(1);
    expect(h.logs.some((line) => line.level === "error" && line.msg.includes("integrity"))).toBe(true);
    expect(h.fetch.callsTo(`${PINNING_URL}/pins`)).toHaveLength(0);
    // Never retried.
    h.clock.advance(86_400_000);
    h.fetch.calls.length = 0;
    await runJob();
    expect(h.fetch.calls).toHaveLength(0);
  });

  it("a pinning-service CID that differs from the local CID marks the item integrity_failed", async () => {
    await h.gateways.contentStore.put({ bytes: pinBytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
    scriptKubo();
    scriptService([], OTHER_CID);
    await runJob();
    expect(await pinRow()).toMatchObject({ status: "integrity_failed", kubo_done: true, service_done: false });
    expect(h.metrics.counters.get("content_pin_integrity_failed{}")).toBe(1);
    expect(h.logs.some((line) => line.level === "error" && line.msg.includes("integrity"))).toBe(true);
  });

  it("retries failures with backoff without repeating the target that already succeeded", async () => {
    await h.gateways.contentStore.put({ bytes: pinBytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
    scriptKubo();
    h.fetch.json("GET", `${PINNING_URL}/pins?cid=${cid}&status=queued,pinning,pinned&limit=10`, 503, {});
    await runJob();
    expect(await pinRow()).toMatchObject({ status: "pending", kubo_done: true, service_done: false, attempts: 1 });
    expect((await pinRow())?.last_error).not.toContain(PINNING_TOKEN);

    // Not due before the backoff (30 s).
    h.fetch.calls.length = 0;
    h.clock.advance(29_000);
    await runJob();
    expect(h.fetch.calls).toHaveLength(0);

    h.clock.advance(1_000);
    scriptService();
    await runJob();
    expect(await pinRow()).toMatchObject({ status: "pinned", service_done: true });
    expect(h.fetch.callsTo(BLOCK_PUT)).toHaveLength(0);
  });

  it("reuses an existing pin request for the CID instead of creating another (idempotent after a crash)", async () => {
    await h.gateways.contentStore.put({ bytes: pinBytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
    scriptKubo();
    scriptService([cid]);
    await runJob();
    expect(await pinRow()).toMatchObject({ status: "pinned" });
    expect(h.fetch.calls.filter((call) => call.method === "POST" && call.url === `${PINNING_URL}/pins`)).toHaveLength(0);
  });

  it("leaves items pending when no pin target is configured", async () => {
    const dev = await h.sibling({ secrets: testSecrets({ ipfs: { kuboApiUrl: null, pinningServiceUrl: null, pinningServiceToken: null, gatewayUrls: [] } }) });
    await dev.contentStore.put({ bytes: pinBytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
    await runJob(dev);
    expect(await pinRow()).toMatchObject({ status: "pending", attempts: 0 });
    expect(h.fetch.calls).toHaveLength(0);
  });

  it("PRD-02 3a per-target completion: content pinned while only Kubo was configured reaches the pinning service once it is configured", async () => {
    const kuboOnly = await h.sibling({ secrets: testSecrets({ ipfs: { ...h.secrets.ipfs, pinningServiceUrl: null, pinningServiceToken: null } }) });
    await kuboOnly.contentStore.put({ bytes: pinBytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
    scriptKubo();
    await runJob(kuboOnly);
    // Kubo confirmed; the item is not complete (the service has not confirmed) and is not selected again by this process.
    expect(await pinRow()).toMatchObject({ status: "pending", kubo_done: true, service_done: false, attempts: 0 });
    h.fetch.calls.length = 0;
    await runJob(kuboOnly);
    expect(h.fetch.calls).toHaveLength(0);

    // The pinning service is configured later: only the missing target is contacted.
    scriptService();
    await runJob();
    expect(await pinRow()).toMatchObject({ status: "pinned", kubo_done: true, service_done: true });
    expect(h.fetch.callsTo(BLOCK_PUT)).toHaveLength(0);
    expect(h.fetch.callsTo(`${PINNING_URL}/pins`)).toHaveLength(1);
  });

  it("PRD-02 3a per-target completion: content pinned while only the pinning service was configured reaches Kubo later", async () => {
    const serviceOnly = await h.sibling({ secrets: testSecrets({ ipfs: { ...h.secrets.ipfs, kuboApiUrl: null } }) });
    await serviceOnly.contentStore.put({ bytes: pinBytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
    scriptService();
    await runJob(serviceOnly);
    expect(await pinRow()).toMatchObject({ status: "pending", kubo_done: false, service_done: true });
    h.fetch.calls.length = 0;
    scriptKubo();
    await runJob();
    expect(await pinRow()).toMatchObject({ status: "pinned", kubo_done: true, service_done: true });
    expect(h.fetch.calls.filter((call) => call.url.startsWith(PINNING_URL))).toHaveLength(0);
  });

  it("'pinned' requires both targets: the database refuses a pinned row with an unconfirmed target", async () => {
    await h.gateways.contentStore.put({ bytes: pinBytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
    await expect(h.database.sql.query("UPDATE content_pins SET status = 'pinned', kubo_done = true")).rejects.toThrow(/content_pins_pinned_means_all_targets/);
  });

  it("a Kubo pin/add answer naming another CID (alone or among two) marks the item integrity_failed without contacting the service", async () => {
    for (const pins of [[OTHER_CID], [cid, OTHER_CID]]) {
      await h.reset();
      await h.gateways.contentStore.put({ bytes: pinBytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
      h.fetch.json("POST", BLOCK_PUT, 200, { Key: cid, Size: pinBytes.byteLength });
      h.fetch.json("POST", `${KUBO_URL}/api/v0/pin/add?arg=${cid}`, 200, { Pins: pins });
      scriptService();
      await runJob();
      expect(await pinRow()).toMatchObject({ status: "integrity_failed", kubo_done: false, service_done: false });
      expect(h.metrics.counters.get("content_pin_integrity_failed{}")).toBe(1);
      expect(h.logs.some((line) => line.level === "error" && line.msg.includes("integrity"))).toBe(true);
      expect(h.fetch.calls.filter((call) => call.url.startsWith(PINNING_URL))).toHaveLength(0);
    }
  });

  it("a Kubo block/put answer with the right CID but another size marks the item integrity_failed", async () => {
    await h.gateways.contentStore.put({ bytes: pinBytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
    h.fetch.json("POST", BLOCK_PUT, 200, { Key: cid, Size: pinBytes.byteLength + 1 });
    h.fetch.json("POST", `${KUBO_URL}/api/v0/pin/add?arg=${cid}`, 200, { Pins: [cid] });
    scriptService();
    await runJob();
    expect(await pinRow()).toMatchObject({ status: "integrity_failed", kubo_done: false });
    expect(h.metrics.counters.get("content_pin_integrity_failed{}")).toBe(1);
    expect(h.fetch.callsTo(`${KUBO_URL}/api/v0/pin/add?arg=${cid}`)).toHaveLength(0);
  });

  it("an existing pin listed by the pinning service under another CID marks the item integrity_failed and is never retried", async () => {
    await h.gateways.contentStore.put({ bytes: pinBytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
    scriptKubo();
    scriptService([OTHER_CID]);
    await runJob();
    expect(await pinRow()).toMatchObject({ status: "integrity_failed", kubo_done: true, service_done: false });
    expect(h.metrics.counters.get("content_pin_integrity_failed{}")).toBe(1);
    expect(h.fetch.calls.filter((call) => call.method === "POST" && call.url === `${PINNING_URL}/pins`)).toHaveLength(0);
    h.clock.advance(86_400_000);
    h.fetch.calls.length = 0;
    await runJob();
    expect(h.fetch.calls).toHaveLength(0);
  });

  it("Kubo and pinning-service answers above 64 KiB are retryable failures, not pins (bounded sizes)", async () => {
    await h.gateways.contentStore.put({ bytes: pinBytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
    // Valid answers padded with an ignored field: only the byte cap can refuse them.
    const padded = (value: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify({ ...value, padding: "x".repeat(100 * 1024) }));
    h.fetch.on("POST", BLOCK_PUT, () => streamedResponse(padded({ Key: cid, Size: pinBytes.byteLength })));
    h.fetch.json("POST", `${KUBO_URL}/api/v0/pin/add?arg=${cid}`, 200, { Pins: [cid] });
    scriptService();
    await runJob();
    expect(await pinRow()).toMatchObject({ status: "pending", kubo_done: false, service_done: false, attempts: 1 });

    h.clock.advance(60_000);
    scriptKubo();
    h.fetch.on("GET", `${PINNING_URL}/pins?cid=${cid}&status=queued,pinning,pinned&limit=10`, () => streamedResponse(padded({ count: 0, results: [] })));
    await runJob();
    expect(await pinRow()).toMatchObject({ status: "pending", kubo_done: true, service_done: false, attempts: 2 });
  });

  it("failure messages carrying a secret are redacted before they are persisted in last_error or logged", async () => {
    await h.gateways.contentStore.put({ bytes: pinBytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
    const leakingKubo = `connect ECONNREFUSED ${KUBO_URL}/api/v0/block/put?cid-codec=raw&key=kubo-path-secret token ${PINNING_TOKEN}`;
    h.fetch.on("POST", BLOCK_PUT, () => {
      throw new TypeError(leakingKubo);
    });
    await runJob();
    const first = await pinRow();
    expect(first).toMatchObject({ status: "pending", attempts: 1 });
    expect(first?.last_error).toMatch(/^HttpError/);
    for (const text of [first?.last_error ?? "", ...h.logs.map((line) => line.msg)]) {
      expect(text).not.toContain(PINNING_TOKEN);
      expect(text).not.toContain("kubo-path-secret");
    }

    h.clock.advance(60_000);
    h.logs.length = 0;
    scriptKubo();
    h.fetch.on("GET", `${PINNING_URL}/pins?cid=${cid}&status=queued,pinning,pinned&limit=10`, () => {
      throw new TypeError(`request to ${PINNING_URL}/pins failed, Authorization: Bearer ${PINNING_TOKEN} raw ${PINNING_TOKEN}`);
    });
    await runJob();
    const second = await pinRow();
    expect(second).toMatchObject({ status: "pending", kubo_done: true, attempts: 2 });
    expect(h.logs.some((line) => line.level === "warn" && line.msg.includes("attempt 2"))).toBe(true);
    for (const text of [second?.last_error ?? "", ...h.logs.map((line) => line.msg)]) expect(text).not.toContain(PINNING_TOKEN);
  });

  it("a malformed target response is a retryable failure, not a pin", async () => {
    await h.gateways.contentStore.put({ bytes: pinBytes, declaredMediaType: "text/plain", maxBytes: 1_000 });
    h.fetch.on("POST", BLOCK_PUT, () => jsonResponse(200, { Key: 42 }));
    await runJob();
    expect(await pinRow()).toMatchObject({ status: "pending", kubo_done: false, attempts: 1 });
  });
});

// ------------------------------------------------------------------------------------------------ content server wiring

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

describe("gateways.createContentServer() over the Postgres store (SEC-EVID-06/07/11)", () => {
  it("listens, serves stored bytes as a sandboxed attachment, 451 for blocked, 404 otherwise, never a cookie, and closes", async () => {
    const record = await store().put({ bytes: bytesOf("<script>alert(1)</script>"), declaredMediaType: "text/html", maxBytes: 1_000 });
    const blockedRecord = await store().put({ bytes: bytesOf("taken down"), declaredMediaType: "text/plain", maxBytes: 1_000 });
    h.moderation.set("content", blockedRecord.sha256, "block", "takedown");
    const server = h.gateways.createContentServer();
    const port = await freePort();
    await server.listen({ host: "127.0.0.1", port });
    const base = `http://127.0.0.1:${port}`;
    try {
      const ok = await fetch(`${base}/c/${record.sha256}`, { headers: { cookie: "__Host-pine_session=pine_s1_x" } });
      expect(ok.status).toBe(200);
      expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe("<script>alert(1)</script>");
      expect(ok.headers.get("content-type")).toBe("application/octet-stream");
      expect(ok.headers.get("content-disposition")).toBe(`attachment; filename="${record.sha256}.bin"`);
      expect(ok.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
      expect(ok.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(ok.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
      expect(ok.headers.get("set-cookie")).toBeNull();

      // Moderation comes from the real store wiring: the blocked digest is 451, not 404.
      const blocked = await fetch(`${base}/c/${blockedRecord.sha256}`);
      expect(blocked.status).toBe(451);
      expect(await blocked.text()).not.toContain("taken down");
      expect(blocked.headers.get("set-cookie")).toBeNull();

      for (const path of [`/c/0x${"ab".repeat(32)}`, "/api/v1/auth/session", "/"]) {
        const other = await fetch(`${base}${path}`);
        expect(other.status).toBe(404);
        expect(other.headers.get("set-cookie")).toBeNull();
        await other.arrayBuffer();
      }
    } finally {
      await server.close();
    }
    // Closed: the port no longer accepts requests.
    await expect(fetch(`${base}/c/${record.sha256}`)).rejects.toThrow();
  });
});
