// Must stay the first import: serializes the memory-heavy markets test files (see test/lock.ts).
import "./test/lock.js";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@pine/shared/canonical";
import { encodeEvidenceManifest } from "@pine/shared/evidence";
import { addClaim, exampleManifest, spyNetwork, upload, useHarness } from "./test/helpers.js";

const harnessOf = useHarness();
const bytes = (size: number, fill = 7) => new Uint8Array(size).fill(fill);

describe("POST /api/v1/evidence/artifacts", () => {
  it("stores an artifact by digest and returns sha256, cid and size", async () => {
    const h = harnessOf();
    const data = bytes(1_000);
    const response = await upload(h, [{ name: "file", filename: "trace.txt", contentType: "text/plain", data }]);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toEqual({ sha256: sha256Hex(data), cid: expect.stringMatching(/^bafkrei/), size: 1_000 });
    expect(await h.ctx.contentStore.has(sha256Hex(data))).toBe(true);
    expect(h.ctx.quotas.used.get(`${h.session.userId}:evidence_uploads_per_day`)).toBe(1);
    expect(h.ctx.quotas.used.get(`${h.session.userId}:evidence_bytes_per_day`)).toBe(1_000);
    expect(h.ctx.audit.entries).toEqual([
      expect.objectContaining({ actorUserId: h.session.userId, action: "markets.evidence.artifact_uploaded", subjectType: "content", subjectId: sha256Hex(data), details: { size: 1_000, cid: body.cid, restored: false } }),
    ]);
  });

  it("accepts an upload of exactly the configured limit", async () => {
    const h = harnessOf();
    const response = await upload(h, [{ name: "file", filename: "a.bin", contentType: "application/zip", data: bytes(h.ctx.config.evidence.maxUploadBytes) }]);
    expect(response.statusCode).toBe(201);
  });

  it("SEC-EVID-01 aborts an oversized upload while streaming: 413, nothing stored, no quota consumed", async () => {
    const h = harnessOf();
    const data = bytes(h.ctx.config.evidence.maxUploadBytes + 1);
    const response = await upload(h, [{ name: "file", filename: "big.bin", contentType: "application/zip", data }]);
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(h.ctx.contentStore.items.size).toBe(0);
    expect(h.ctx.quotas.used.size).toBe(0);
    expect(await h.ctx.database.sql.query("SELECT * FROM markets_uploads")).toEqual([]);
  });

  it("SEC-EVID-01 enforces a lower configured limit than one raw block", async () => {
    const h = harnessOf();
    const { createMarketsModule } = await import("./index.js");
    const { buildMarketsTestApp } = await import("./test/helpers.js");
    const view = { ...h.ctx, config: { ...h.ctx.config, evidence: { ...h.ctx.config.evidence, maxUploadBytes: 1_000 } } };
    for (const key of ["readModel", "contentStore", "audit", "moderation", "compliance", "quotas", "metrics", "chain", "clock"] as const) {
      Object.defineProperty(view, key, { get: () => h.ctx[key], enumerable: true });
    }
    const app = await buildMarketsTestApp([createMarketsModule()], view, [], []);
    try {
      const { multipartBody } = await import("./test/helpers.js");
      const body = multipartBody([{ name: "file", filename: "x.bin", contentType: "application/zip", data: bytes(1_001) }]);
      const response = await app.inject({ method: "POST", url: "/api/v1/evidence/artifacts", headers: { ...h.headers, "content-type": body.contentType }, payload: body.payload });
      expect(response.statusCode).toBe(413);
      expect(h.ctx.contentStore.items.size).toBe(0);
      expect(h.ctx.quotas.used.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("SEC-EVID-03 compares expectedSha256 only: a mismatch is 422 and nothing is stored or consumed", async () => {
    const h = harnessOf();
    const data = bytes(64);
    const wrong = sha256Hex(bytes(64, 9));
    for (const order of ["before", "after"] as const) {
      const file = { name: "file", filename: "a.txt", contentType: "text/plain", data };
      const field = { name: "expectedSha256", value: wrong };
      const response = await upload(h, order === "before" ? [field, file] : [file, field]);
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe("UNPROCESSABLE");
    }
    expect(h.ctx.contentStore.items.size).toBe(0);
    expect(h.ctx.quotas.used.size).toBe(0);
  });

  it("SEC-EVID-03 accepts a matching expectedSha256 given after the file", async () => {
    const h = harnessOf();
    const data = bytes(64, 3);
    const response = await upload(h, [{ name: "file", filename: "a.txt", contentType: "text/plain", data }, { name: "expectedSha256", value: sha256Hex(data).toUpperCase().replace("0X", "0x") }]);
    expect(response.statusCode).toBe(201);
    expect(response.json().sha256).toBe(sha256Hex(data));
  });

  it("SEC-EVID-08 never stores, returns or logs a client file name (path traversal and bidi characters)", async () => {
    const h = harnessOf();
    const filename = "../../etc/passwd\u202egpj.exe";
    const data = bytes(32, 5);
    const response = await upload(h, [{ name: "file", filename, contentType: "image/png", data }]);
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain("passwd");
    expect(response.body).not.toContain("\u202e");
    const stored = await h.ctx.contentStore.get(sha256Hex(data));
    expect(JSON.stringify(stored?.record)).not.toContain("passwd");
    const rows = await h.ctx.database.sql.query("SELECT * FROM markets_uploads");
    expect(JSON.stringify(rows)).not.toContain("passwd");
    expect(JSON.stringify(h.ctx.audit.entries)).not.toContain("passwd");
    expect(h.logLines.join("\n")).not.toContain("passwd");
  });

  it("checks the declared media type against the allowlist without sniffing (415)", async () => {
    const h = harnessOf();
    const response = await upload(h, [{ name: "file", filename: "a.html", contentType: "text/html", data: new TextEncoder().encode("<script>alert(1)</script>") }]);
    expect(response.statusCode).toBe(415);
    expect(h.ctx.contentStore.items.size).toBe(0);
    expect(h.ctx.quotas.used.size).toBe(0);
  });

  it("refuses unknown fields (a salt is never accepted anywhere) and missing files", async () => {
    const h = harnessOf();
    const salt = `0x${"5a".repeat(32)}`;
    const withSalt = await upload(h, [{ name: "salt", value: salt }, { name: "file", filename: "a.txt", contentType: "text/plain", data: bytes(8) }]);
    expect(withSalt.statusCode).toBe(400);
    expect(await upload(h, [{ name: "expectedSha256", value: sha256Hex(bytes(8)) }])).toMatchObject({ statusCode: 400 });
    expect(h.ctx.contentStore.items.size).toBe(0);
    expect(h.logLines.join("\n")).not.toContain("5a5a5a5a");
  });

  it("SEC-EVID-01 consumes upload quotas atomically before storing; a re-upload of the user's own content is answered from its row", async () => {
    const h = harnessOf();
    const data = bytes(100, 1);
    const store = h.ctx.contentStore;
    const realPut = store.put.bind(store);
    const used = (quota: string, userId = h.session.userId) => h.ctx.quotas.used.get(`${userId}:${quota}`);
    // Quota state at the moment each put happens: storage never runs before the quotas are consumed.
    const atPut: { uploads: number | undefined; bytes: number | undefined }[] = [];
    const put = vi.spyOn(store, "put").mockImplementation(async (input) => {
      atPut.push({ uploads: used("evidence_uploads_per_day"), bytes: used("evidence_bytes_per_day") });
      return realPut(input);
    });
    const first = await upload(h, [{ name: "file", filename: "a", contentType: "text/plain", data }]);
    expect(first.statusCode).toBe(201);
    expect(atPut).toEqual([{ uploads: 1, bytes: 100 }]);
    const again = await upload(h, [{ name: "file", filename: "b", contentType: "text/plain", data }]);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    // Answered from the markets_uploads row: no second store call, no quota.
    expect(put).toHaveBeenCalledTimes(1);
    expect(used("evidence_uploads_per_day")).toBe(1);
    expect(used("evidence_bytes_per_day")).toBe(100);
    expect(await h.ctx.database.sql.query("SELECT sha256, cid, kind, size FROM markets_uploads")).toEqual([{ sha256: sha256Hex(data), cid: first.json().cid, kind: "artifact", size: 100 }]);
    expect(h.ctx.audit.entries.filter((entry) => entry.action === "markets.evidence.artifact_uploaded")).toHaveLength(1);
    // Another user uploading the same bytes pays their own quota (the row is per user).
    const other = await h.user();
    expect((await upload(h, [{ name: "file", filename: "c", contentType: "text/plain", data }], other.headers)).statusCode).toBe(201);
    expect(used("evidence_uploads_per_day", other.session.userId)).toBe(1);
    expect(used("evidence_bytes_per_day", other.session.userId)).toBe(100);
    // The byte quota is consumed FIRST: when it refuses, the upload unit is not consumed and nothing is stored.
    h.ctx.quotas.limits.evidence_bytes_per_day = 150;
    const overBytes = await upload(h, [{ name: "file", filename: "e", contentType: "text/plain", data: bytes(100, 3) }]);
    expect(overBytes.statusCode).toBe(429);
    expect(overBytes.json().error.message).toContain("evidence_bytes_per_day");
    expect(used("evidence_uploads_per_day")).toBe(1);
    expect(used("evidence_bytes_per_day")).toBe(100);
    expect(await h.ctx.contentStore.has(sha256Hex(bytes(100, 3)))).toBe(false);
    // The upload-count quota refuses after the bytes were consumed: nothing stored, and the bytes stay spent (the
    // frozen QuotaGateway cannot refund; a deterministic, documented gap bounded by the count quota).
    h.ctx.quotas.limits.evidence_bytes_per_day = 10_000;
    h.ctx.quotas.limits.evidence_uploads_per_day = 1;
    const overCount = await upload(h, [{ name: "file", filename: "d", contentType: "text/plain", data: bytes(100, 2) }]);
    expect(overCount.statusCode).toBe(429);
    expect(overCount.json().error.message).toContain("evidence_uploads_per_day");
    expect(await h.ctx.contentStore.has(sha256Hex(bytes(100, 2)))).toBe(false);
    expect(used("evidence_uploads_per_day")).toBe(1);
    expect(used("evidence_bytes_per_day")).toBe(200);
    expect(put).toHaveBeenCalledTimes(2);
    expect(await h.ctx.database.sql.query("SELECT count(*)::int AS n FROM markets_uploads")).toEqual([{ n: 2 }]);
  });

  it("SEC-EVID-01 stores a re-upload again, paying quota, when the content store no longer has the bytes of the user's row", async () => {
    const h = harnessOf();
    const data = bytes(64, 9);
    const used = (quota: string) => h.ctx.quotas.used.get(`${h.session.userId}:${quota}`);
    const first = await upload(h, [{ name: "file", filename: "a", contentType: "text/plain", data }]);
    expect(first.statusCode).toBe(201);
    // The bytes vanish from the store (the markets_uploads row stays).
    h.ctx.contentStore.items.delete(sha256Hex(data));
    const put = vi.spyOn(h.ctx.contentStore, "put");
    const again = await upload(h, [{ name: "file", filename: "b", contentType: "text/plain", data }]);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect(put).toHaveBeenCalledTimes(1);
    expect(await h.ctx.contentStore.has(sha256Hex(data))).toBe(true);
    expect(used("evidence_uploads_per_day")).toBe(2);
    expect(used("evidence_bytes_per_day")).toBe(128);
    expect(await h.ctx.database.sql.query("SELECT count(*)::int AS n FROM markets_uploads")).toEqual([{ n: 1 }]);
    const audits = h.ctx.audit.entries.filter((entry) => entry.action === "markets.evidence.artifact_uploaded");
    expect(audits.map((entry) => (entry.details as { restored?: boolean }).restored)).toEqual([false, true]);
    // Over quota, the vanished content is not stored again.
    h.ctx.contentStore.items.delete(sha256Hex(data));
    h.ctx.quotas.limits.evidence_uploads_per_day = 2;
    expect((await upload(h, [{ name: "file", filename: "c", contentType: "text/plain", data }])).statusCode).toBe(429);
    expect(await h.ctx.contentStore.has(sha256Hex(data))).toBe(false);
  });

  it("answers a re-submitted manifest of the same user from its row without storing or consuming again", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "q1");
    const manifest = exampleManifest(claim, h.session.wallet);
    const post = () => h.app.inject({ method: "POST", url: "/api/v1/evidence/manifests", headers: h.headers, payload: manifest as unknown as Record<string, unknown> });
    const first = await post();
    expect(first.statusCode).toBe(201);
    const put = vi.spyOn(h.ctx.contentStore, "put");
    h.ctx.quotas.limits.evidence_uploads_per_day = 1;
    const again = await post();
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect(put).not.toHaveBeenCalled();
    expect(h.ctx.quotas.used.get(`${h.session.userId}:evidence_uploads_per_day`)).toBe(1);
  });

  it("is the only multipart route, and it refuses JSON; every other route is JSON or public", async () => {
    const h = harnessOf();
    const multipartRoutes = h.routes.filter((route) => (route.pine as { multipart?: boolean } | null)?.multipart === true).map((route) => route.url);
    expect(multipartRoutes).toEqual(["/api/v1/evidence/artifacts"]);
    const json = await h.app.inject({ method: "POST", url: "/api/v1/evidence/artifacts", headers: h.headers, payload: { file: "x" } });
    expect([400, 406, 415]).toContain(json.statusCode);
    expect(h.ctx.contentStore.items.size).toBe(0);
  });

  it("requires a session", async () => {
    const h = harnessOf();
    expect((await upload(h, [{ name: "file", filename: "a", contentType: "text/plain", data: bytes(4) }], {})).statusCode).toBe(401);
  });
});

describe("POST /api/v1/evidence/manifests", () => {
  const post = (h: ReturnType<typeof harnessOf>, payload: unknown, headers = h.headers) => h.app.inject({ method: "POST", url: "/api/v1/evidence/manifests", headers, payload: payload as Record<string, unknown> });

  it("stores the canonical manifest of the session wallet and is idempotent by digest", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "m1");
    const artifact = bytes(500, 4);
    await h.ctx.contentStore.put({ bytes: artifact, declaredMediaType: "text/plain", maxBytes: 262_144 });
    const manifest = exampleManifest(claim, h.session.wallet, {
      artifacts: [{ name: "trace.txt", sha256: sha256Hex(artifact), size: 500, mediaType: "text/plain", locators: ["http://169.254.169.254/latest"], description: "" }],
    });
    const network = spyNetwork();
    let first;
    try {
      first = await post(h, manifest);
    } finally {
      network.restore();
    }
    // SEC-EVID-09: the locator URL is inert data: no fetch, HTTP or socket attempt is made for it.
    expect(network.attempts).toEqual([]);
    expect(first.statusCode).toBe(201);
    const expected = encodeEvidenceManifest(manifest);
    expect(first.json()).toMatchObject({ sha256: expected.sha256, size: expected.bytes.byteLength });
    const stored = await h.ctx.contentStore.get(expected.sha256);
    expect(Buffer.from(stored!.bytes).equals(Buffer.from(expected.bytes))).toBe(true);
    const second = await post(h, manifest);
    expect(second.json()).toEqual(first.json());
    expect(h.ctx.quotas.used.get(`${h.session.userId}:evidence_uploads_per_day`)).toBe(1);
    expect(h.ctx.quotas.used.get(`${h.session.userId}:evidence_bytes_per_day`)).toBe(expected.bytes.byteLength);
    // ... and no RPC call is made for it either.
    expect(h.chain.calls).toEqual([]);
  });

  it("refuses a manifest naming another submitter", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "m2");
    const response = await post(h, exampleManifest(claim, "0x00000000000000000000000000000000000000b0"));
    expect(response.statusCode).toBe(422);
    expect(response.json().error.issues).toEqual([expect.objectContaining({ path: ["submitter"] })]);
    expect(h.ctx.contentStore.items.size).toBe(0);
  });

  it("refuses a wrong claim: unregistered market, other document digest, other commit", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "m3");
    const base = exampleManifest(claim, h.session.wallet);
    const unknown = await post(h, { ...base, claim: { ...base.claim, market: "0x00000000000000000000000000000000000000c0" } });
    expect(unknown.statusCode).toBe(422);
    const digest = await post(h, { ...base, claim: { ...base.claim, claimDocumentSha256: `0x${"12".repeat(32)}` } });
    expect(digest.json().error.issues).toEqual([expect.objectContaining({ path: ["claim", "claimDocumentSha256"] })]);
    const commit = await post(h, { ...base, claim: { ...base.claim, commit: "cd".repeat(20) } });
    expect(commit.json().error.issues).toEqual([expect.objectContaining({ path: ["claim", "commit"] })]);
    expect(h.ctx.contentStore.items.size).toBe(0);
    expect(h.ctx.quotas.used.size).toBe(0);
  });

  it("refuses a manifest whose artifact is not stored or has another size", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "m4");
    const artifact = { name: "a.txt", sha256: sha256Hex(bytes(10)), size: 10, mediaType: "text/plain", locators: [], description: "" };
    const missing = await post(h, exampleManifest(claim, h.session.wallet, { artifacts: [artifact] }));
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.issues[0].path).toEqual(["artifacts", 0, "sha256"]);
    await h.ctx.contentStore.put({ bytes: bytes(10), declaredMediaType: "text/plain", maxBytes: 262_144 });
    const wrongSize = await post(h, exampleManifest(claim, h.session.wallet, { artifacts: [{ ...artifact, size: 11 }] }));
    expect(wrongSize.json().error.issues[0].path).toEqual(["artifacts", 0, "size"]);
  });

  it("refuses a schema-valid manifest over 256 KiB in canonical form with 413: nothing stored, no quota consumed", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "m6");
    // Control characters are legal in these fields and take 6 bytes each in canonical JSON (\u0007): ~336 KB in total.
    const fill = (length: number) => "\u0007".repeat(length);
    const manifest = exampleManifest(claim, h.session.wallet, {
      violatedRequirement: fill(4_000),
      summary: fill(10_000),
      expectedBehavior: fill(4_000),
      actualBehavior: fill(4_000),
      reproduction: { environment: fill(4_000), setup: fill(10_000), command: "run", initialState: fill(10_000), notes: fill(10_000) },
    });
    expect(() => encodeEvidenceManifest(manifest)).toThrow(/256 KiB/);
    const response = await post(h, manifest);
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(h.ctx.contentStore.items.size).toBe(0);
    expect(h.ctx.quotas.used.size).toBe(0);
  });

  it("refuses non-canonical and schema-invalid manifests", async () => {
    const h = harnessOf();
    const claim = await addClaim(h, "m5");
    const base = exampleManifest(claim, h.session.wallet);
    const mixedCase = await post(h, { ...base, submitter: `0x${h.session.wallet.slice(2).toUpperCase()}` });
    expect(mixedCase.statusCode).toBe(400);
    expect(mixedCase.json().error.message).toMatch(/canonical/);
    const extra = await post(h, { ...base, salt: `0x${"77".repeat(32)}` });
    expect(extra.statusCode).toBe(400);
    const badSchema = await post(h, { ...base, schema: "urn:other" });
    expect(badSchema.statusCode).toBe(400);
    expect(h.ctx.contentStore.items.size).toBe(0);
  });
});
