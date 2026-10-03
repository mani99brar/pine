// Must stay the first import: serializes the memory-heavy (PGlite) gateways test files across vitest workers.
import "./testing/suite-lock.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hex32 } from "@pine/shared/types";
import type { StoredContent } from "../../contracts/app.js";
import { createRedactor } from "../../contracts/redact.js";
import { FakeModeration, MemoryContentStore } from "../../contracts/testing.js";
import { buildContentApp } from "./content-server.js";
import type { ContentStoreInternals } from "./content-store.js";
import { createLogger } from "./log.js";

// The server is tested over an in-memory store with the same interface and moderation semantics as the Postgres store
// (whose own block/hide behaviour is covered in content-store.test.ts).
const moderation = new FakeModeration();
let memory = new MemoryContentStore();
const isBlocked = async (sha256: Hex32) => [...(await moderation.states("content", [sha256])).values()].some((state) => state.action === "block");
const store: ContentStoreInternals = {
  isBlocked,
  put: (input) => memory.put(input),
  get: async (sha256) => ((await isBlocked(sha256)) ? null : memory.get(sha256)),
  has: async (sha256) => !(await isBlocked(sha256)) && (await memory.has(sha256)),
  retrieve: async (sha256, maxBytes) => ((await isBlocked(sha256)) ? null : memory.retrieve(sha256, maxBytes)),
};
const logs: { level: string; msg: string }[] = [];

let app: FastifyInstance;
beforeAll(async () => {
  app = buildContentApp(store, createRedactor(), createLogger((line) => logs.push(line), createRedactor()));
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  memory = new MemoryContentStore();
  moderation.items.clear();
});

const polyglot = new TextEncoder().encode("<!doctype html><script>document.cookie</script>%PDF-1.4");

async function stored(): Promise<StoredContent> {
  return store.put({ bytes: polyglot, declaredMediaType: "text/html", maxBytes: 1_000 });
}

function expectSafeHeaders(headers: Record<string, unknown>) {
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["set-cookie"]).toBeUndefined();
}

describe("user-content server (SEC-EVID-06/07/11)", () => {
  it("SEC-EVID-06 serves bytes as an attachment with the sandbox headers, never inline", async () => {
    const record = await stored();
    const response = await app.inject({ method: "GET", url: `/c/${record.sha256}`, headers: { cookie: "__Host-pine_session=pine_s1_abcdefghijklmnopqrstuvwxyz" } });
    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.rawPayload).equals(Buffer.from(polyglot))).toBe(true);
    expect(response.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${record.sha256}.bin"`,
      "cache-control": "public, max-age=31536000, immutable",
      "cross-origin-resource-policy": "cross-origin",
    });
    expectSafeHeaders(response.headers);
  });

  it("HEAD answers with the same headers and no body", async () => {
    const record = await stored();
    const response = await app.inject({ method: "HEAD", url: `/c/${record.sha256}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-disposition"]).toBe(`attachment; filename="${record.sha256}.bin"`);
    expect(response.rawPayload.byteLength).toBe(0);
  });

  it("SEC-EVID-11 answers 451 for blocked content without the bytes", async () => {
    const record = await stored();
    moderation.set("content", record.sha256, "block", "takedown");
    const response = await app.inject({ method: "GET", url: `/c/${record.sha256}` });
    expect(response.statusCode).toBe(451);
    expect(response.body).not.toContain("script");
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expectSafeHeaders(response.headers);
  });

  it("serves hidden (not blocked) content", async () => {
    const record = await stored();
    moderation.set("content", record.sha256, "hide", "spam");
    expect((await app.inject({ method: "GET", url: `/c/${record.sha256}` })).statusCode).toBe(200);
  });

  it("answers 404 for absent content and malformed digests", async () => {
    for (const url of [`/c/0x${"ab".repeat(32)}`, "/c/0x1234", "/c/..%2f..%2fetc%2fpasswd", `/c/0x${"zz".repeat(32)}`]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expectSafeHeaders(response.headers);
    }
  });

  it("SEC-EVID-07 serves nothing but GET/HEAD /c/:sha256 and never sets cookies", async () => {
    const record = await stored();
    for (const request of [
      { method: "GET" as const, url: "/" },
      { method: "GET" as const, url: "/api/v1/auth/session" },
      { method: "GET" as const, url: `/content/${record.sha256}` },
      { method: "POST" as const, url: `/c/${record.sha256}` },
      { method: "DELETE" as const, url: `/c/${record.sha256}` },
      { method: "OPTIONS" as const, url: `/c/${record.sha256}` },
    ]) {
      const response = await app.inject({ ...request, headers: { cookie: "a=b", origin: "https://evil.test" } });
      expect(response.statusCode).toBe(404);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expectSafeHeaders(response.headers);
    }
  });

  it("has no in-app per-IP rate limit (decided: the edge proxy limits the user-content host)", async () => {
    const record = await stored();
    // More than the main app's 600/min per-IP flood guard, from one socket address within one minute.
    for (let index = 0; index < 650; index += 1) {
      const response = await app.inject({ method: "GET", url: `/c/${record.sha256}`, remoteAddress: "203.0.113.7" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-ratelimit-limit"]).toBeUndefined();
      expect(response.headers["retry-after"]).toBeUndefined();
    }
  });

  it("answers a generic 500 and logs only a redacted message when the store fails", async () => {
    const record = await stored();
    const original = store.get;
    store.get = async () => {
      throw new Error("connection to postgres://api:hunter2secret@db.internal/pine failed");
    };
    try {
      const response = await app.inject({ method: "GET", url: `/c/${record.sha256}` });
      expect(response.statusCode).toBe(500);
      expect(response.body).toBe("Internal error");
      expectSafeHeaders(response.headers);
      expect(logs.at(-1)?.msg).not.toContain("hunter2secret");
    } finally {
      store.get = original;
    }
  });
});
