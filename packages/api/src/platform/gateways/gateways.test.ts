// Must stay the first import: serializes the memory-heavy (PGlite) gateways test files across vitest workers.
import "./testing/suite-lock.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { identify, rawCidFromSha256 } from "@pine/shared/canonical";
import type { Database } from "../../contracts/app.js";
import { FakeClock, FakeModeration, MemoryMetrics, testConfig } from "../../contracts/testing.js";
import { createRedactor } from "../../contracts/redact.js";
import { buildGateways, createGateways, JOB_NAMES } from "./index.js";
import { createHttpClient, HttpError } from "./http.js";
import { chainIdOnly, FakeFetch, scriptedTransport, testSecrets } from "./testing/harness.js";

// Wiring tests only: a database that answers every statement with no rows (the stores are covered on PGlite elsewhere).
const emptyDb = { execute: async () => ({ rows: [] }) } as unknown as Database;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function deps(overrides: { secrets?: ReturnType<typeof testSecrets>; environment?: "production" | "test" } = {}) {
  const secrets = overrides.secrets ?? testSecrets();
  return {
    config: testConfig(overrides.environment ? { environment: overrides.environment } : {}),
    secrets,
    db: emptyDb,
    clock: new FakeClock(),
    redact: createRedactor([secrets.rpcUrls.primary, secrets.rpcUrls.secondary]),
    metrics: new MemoryMetrics(),
    moderation: new FakeModeration(),
  };
}

const io = (fetch = new FakeFetch()) => ({
  fetch: fetch.fetch,
  transports: { primary: scriptedTransport(chainIdOnly), secondary: scriptedTransport(chainIdOnly) },
  log: () => undefined,
});

describe("createGateways (production wiring)", () => {
  it("checks eth_chainId over HTTP on both configured RPC URLs and fetches only configured hosts with redirects refused", async () => {
    const calls: { url: string; redirect: RequestInit["redirect"] }[] = [];
    const remote = new TextEncoder().encode("pinned elsewhere");
    const id = identify(remote);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, redirect: init?.redirect });
      if (url.startsWith("https://rpc1.example.test/") || url.startsWith("https://rpc2.example.test/")) {
        const body = JSON.parse(String(init?.body)) as { id: number; method: string };
        if (body.method !== "eth_chainId") throw new Error(`unexpected RPC ${body.method}`);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x64" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Bytes that do not match the digest: retrieve verifies, rejects them and stores nothing.
      if (url === `https://gw1.ipfs.test/ipfs/${rawCidFromSha256(id.sha256)}?format=raw`) return new Response(Buffer.from("tampered"), { status: 200 });
      if (url === `https://gw2.ipfs.test/ipfs/${rawCidFromSha256(id.sha256)}?format=raw`) return new Response(null, { status: 404 });
      throw new TypeError(`unexpected fetch ${url}`);
    });
    const gateways = await createGateways(deps());
    expect(gateways.chain.chainId).toBe(100);
    const rpcHosts = calls.map((call) => new URL(call.url).host).sort();
    expect(rpcHosts).toEqual(["rpc1.example.test", "rpc2.example.test"]);
    expect(calls.every((call) => call.redirect === "error")).toBe(true);

    calls.length = 0;
    expect(await gateways.contentStore.retrieve(id.sha256, 1_000)).toBeNull();
    expect(calls.map((call) => new URL(call.url).host)).toEqual(["gw1.ipfs.test", "gw2.ipfs.test"]);
    expect(calls.every((call) => call.redirect === "error")).toBe(true);
    expect(gateways.jobs.map((job) => job.name).sort()).toEqual(Object.values(JOB_NAMES).sort());
    await gateways.close();
  });

  /** Stubs global fetch: rpc1 answers eth_chainId; rpc2 is handled by `secondary`. Returns rpc2's calls. */
  function stubRpc(secondary: (init: RequestInit | undefined) => Promise<Response>) {
    const calls: { init: RequestInit | undefined; startedAt: number; abortedAt: number | null }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://rpc1.example.test/")) {
        const body = JSON.parse(String(init?.body)) as { id: number };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x64" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const call = { init, startedAt: Date.now(), abortedAt: null as number | null };
      init?.signal?.addEventListener("abort", () => {
        call.abortedAt = Date.now();
      });
      calls.push(call);
      return secondary(init);
    });
    return calls;
  }

  it("PRD-02 3.3 an RPC answering HTTP 500 is retried a limited number of times (3 requests) and the error is redacted", async () => {
    const calls = stubRpc(async () => new Response("internal error", { status: 500 }));
    const error = await createGateways(deps()).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(calls).toHaveLength(3);
    expect((error as Error).message).not.toContain("key-secondary-123456");
    expect((error as Error).message).toMatch(/eth_chainId on the secondary RPC failed/);
  });

  it("PRD-02 3.3 each RPC attempt is aborted after exactly 10 s and a hung RPC fails startup after at most 3 attempts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const calls = stubRpc(
        (init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
          }),
      );
      let settled: unknown = "pending";
      const started = createGateways(deps()).then(
        () => (settled = "resolved"),
        (caught: unknown) => (settled = caught),
      );
      await vi.advanceTimersByTimeAsync(9_999);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.abortedAt).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(calls[0]?.abortedAt).not.toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      await started;
      expect(settled).toBeInstanceOf(Error);
      expect((settled as Error).message).not.toContain("key-secondary-123456");
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls.length).toBeLessThanOrEqual(3);
      for (const call of calls) expect((call.abortedAt ?? Number.NaN) - call.startedAt).toBe(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to start when an RPC reports another chain", async () => {
    await expect(
      buildGateways(deps(), { ...io(), transports: { primary: scriptedTransport(chainIdOnly), secondary: scriptedTransport((method) => (method === "eth_chainId" ? "0x1" : null)) } }),
    ).rejects.toThrow(/secondary RPC reports chain id 1/);
    await expect(
      buildGateways(deps(), { ...io(), transports: { primary: scriptedTransport((method) => (method === "eth_chainId" ? "0x1" : null)), secondary: scriptedTransport(chainIdOnly) } }),
    ).rejects.toThrow(/primary RPC reports chain id 1/);
  });

  it("refuses invalid token keys and IPFS URLs", async () => {
    const badKey = testSecrets({ tokenEncryptionKeys: { current: { id: "k", key: new Uint8Array(16) }, previous: [] } });
    await expect(buildGateways(deps({ secrets: badKey }), io())).rejects.toThrow(/32 bytes/);
    const query = testSecrets({ ipfs: { kuboApiUrl: null, pinningServiceUrl: null, pinningServiceToken: null, gatewayUrls: ["https://gw.test/?token=abc"] } });
    await expect(buildGateways(deps({ secrets: query }), io())).rejects.toThrow(/query/);
    const insecure = testSecrets({ ipfs: { kuboApiUrl: null, pinningServiceUrl: null, pinningServiceToken: null, gatewayUrls: ["http://gw.test"] } });
    await expect(buildGateways(deps({ secrets: insecure, environment: "production" }), io())).rejects.toThrow(/https/);
    const credentials = testSecrets({ ipfs: { kuboApiUrl: "http://user:pw@127.0.0.1:5001", pinningServiceUrl: null, pinningServiceToken: null, gatewayUrls: [] } });
    await expect(buildGateways(deps({ secrets: credentials }), io())).rejects.toThrow(/Kubo/);
  });
});

describe("migrations/gateways", () => {
  it("never name the pine_api role (platform 0002_ default privileges cover these tables)", () => {
    const dir = fileURLToPath(new URL("../../../migrations/gateways/", import.meta.url));
    const files = readdirSync(dir).filter((file) => file.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      expect(readFileSync(join(dir, file), "utf8")).not.toMatch(/pine_api|\bGRANT\b|\bCREATE ROLE\b/i);
    }
  });
});

describe("gateway production sources", () => {
  const dir = fileURLToPath(new URL("./", import.meta.url));
  const sources = readdirSync(dir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));

  it("never touch audit_log: core audits every gateway-backed security event at its call sites (decisions.md)", () => {
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) expect(readFileSync(join(dir, file), "utf8")).not.toMatch(/audit_log|auditLog|\.audit\(/);
  });

  it("never import from a testing/ directory", () => {
    for (const file of sources) expect(readFileSync(join(dir, file), "utf8")).not.toMatch(/from\s+["'][^"']*\/testing\//);
  });
});

describe("outbound HTTP guard (SSRF, SEC-EVID-09)", () => {
  it("refuses any origin that is not configured, before fetching", async () => {
    const fetch = new FakeFetch();
    const http = createHttpClient(fetch.fetch, ["https://api.github.com"]);
    for (const url of ["http://169.254.169.254/latest", "https://api.github.com.evil.test/", "http://api.github.com/", "https://user:pw@api.github.com/", "file:///etc/passwd"]) {
      const error = await http.request(url, { maxBytes: 10 }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).kind).toBe("blocked");
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it("sets redirect: error and a timeout signal on every request", async () => {
    const seen: RequestInit[] = [];
    const http = createHttpClient(async (_url, init) => {
      seen.push(init);
      return new Response("{}", { status: 200 });
    }, ["https://api.github.com"]);
    await http.request("https://api.github.com/user", { maxBytes: 10 });
    expect(seen[0]?.redirect).toBe("error");
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("a 3xx returned despite redirect: error is refused by the client itself (kind redirect), and only manual mode returns it", async () => {
    // A fetch that hands back the redirect instead of rejecting (as a lenient implementation might).
    const http = createHttpClient(async () => new Response("body", { status: 302, headers: { location: "http://169.254.169.254/" } }), ["https://api.github.com"]);
    const error = await http.request("https://api.github.com/user", { maxBytes: 100 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).kind).toBe("redirect");
    const manual = await http.request("https://api.github.com/user", { maxBytes: 100, redirect: "manual" });
    expect(manual.status).toBe(302);
    expect(manual.body.byteLength).toBe(0);
  });

  it("a request whose upstream never answers fails at the timeout as a network error", async () => {
    const http = createHttpClient(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
        }),
      ["https://api.github.com"],
      200,
    );
    const started = Date.now();
    const error = await http.request("https://api.github.com/user", { maxBytes: 10 }).catch((caught: unknown) => caught);
    const elapsed = Date.now() - started;
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).kind).toBe("network");
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1_500);
  });

  it("every request through buildGateways carries a 10 s timeout signal (PRD-02 3.1/3.2)", async () => {
    const fetch = new FakeFetch();
    const remote = identify(new TextEncoder().encode("timeout probe"));
    for (const base of ["https://gw1.ipfs.test", "https://gw2.ipfs.test"]) fetch.json("GET", `${base}/ipfs/${rawCidFromSha256(remote.sha256)}?format=raw`, 404, {});
    const gateways = await buildGateways(deps(), io(fetch));
    const timeouts: { ms: number; signal: AbortSignal }[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const signal = original(ms);
      timeouts.push({ ms, signal });
      return signal;
    });
    expect(await gateways.contentStore.retrieve(remote.sha256, 1_000)).toBeNull();
    expect(fetch.calls).toHaveLength(2);
    expect(timeouts.map((entry) => entry.ms)).toEqual([10_000, 10_000]);
    // Without a job signal the timeout signal itself is what fetch receives.
    expect(fetch.calls.map((call) => call.signal)).toEqual(timeouts.map((entry) => entry.signal));
  });
});
