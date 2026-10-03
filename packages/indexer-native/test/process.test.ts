import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GNOSIS_EXTERNAL } from "@pine/shared/deployment";
import { configSecrets, ConfigError, loadConfig, providerDomain } from "../src/config.js";
import { createHealthServer, createMetrics } from "../src/metrics.js";
import { createRedactor } from "../src/redact.js";
import { InvalidRpcDataError, parseHeader, parseRawLogs, RpcError } from "../src/rpc.js";

const KEY = "abcDEF0123456789secretKEY";
const ENV = {
  DATABASE_URL: "postgres://pine_indexer:dbpassword123@db.internal:5432/pine",
  RPC_PRIMARY_URL: `https://gnosis.rpc-one.example/v1/${KEY}`,
  RPC_SECONDARY_URL: "https://rpc.gnosischain.com",
  CHAIN_ID: "100",
  CLAIM_REGISTRY_ADDRESS: "0x00000000000000000000000000000000000C1a10",
  EVIDENCE_REGISTRY_ADDRESS: "0x00000000000000000000000000000000000e01de",
  DEPLOYMENT_BLOCK: "48000000",
};

describe("configuration (fail closed)", () => {
  it("parses a valid environment with GNOSIS_EXTERNAL defaults", () => {
    const config = loadConfig(ENV);
    expect(config).toMatchObject({
      chainId: 100,
      deploymentBlock: 48_000_000n,
      questionTimeout: 302_400,
      chunkSize: 500,
      metricsHost: "127.0.0.1",
      addresses: {
        claimRegistry: "0x00000000000000000000000000000000000c1a10",
        reality: GNOSIS_EXTERNAL.seer.realitio,
        conditionalTokens: GNOSIS_EXTERNAL.seer.conditionalTokens,
        klerosHomeProxy: GNOSIS_EXTERNAL.kleros.homeProxy,
      },
    });
  });

  it.each([
    ["missing database", { DATABASE_URL: undefined }],
    ["another chain", { CHAIN_ID: "10200" }],
    ["one provider twice", { RPC_SECONDARY_URL: ENV.RPC_PRIMARY_URL }],
    ["a non-http RPC", { RPC_SECONDARY_URL: "ws://rpc.example" }],
    ["two RPCs of one provider (same registrable domain)", { RPC_SECONDARY_URL: "https://other-node.rpc-one.example/v1/abc" }],
    ["an http RPC without the explicit local-development flag", { RPC_SECONDARY_URL: "http://rpc.gnosischain.com" }],
    ["the insecure flag in production", { RPC_SECONDARY_URL: "http://rpc.gnosischain.com", RPC_ALLOW_INSECURE_HTTP: "true", NODE_ENV: "production" }],
    ["the insecure flag in production even with https URLs", { RPC_ALLOW_INSECURE_HTTP: "true", NODE_ENV: "production" }],
    ["the insecure flag without PINE_INDEXER_ENV (never inferred from a missing NODE_ENV)", { RPC_SECONDARY_URL: "http://127.0.0.1:8545", RPC_ALLOW_INSECURE_HTTP: "true" }],
    ["the insecure flag with PINE_INDEXER_ENV=production", { RPC_SECONDARY_URL: "http://127.0.0.1:8545", RPC_ALLOW_INSECURE_HTTP: "true", PINE_INDEXER_ENV: "production" }],
    ["the insecure flag with PINE_INDEXER_ENV=development but NODE_ENV=production", { RPC_SECONDARY_URL: "http://127.0.0.1:8545", RPC_ALLOW_INSECURE_HTTP: "true", PINE_INDEXER_ENV: "development", NODE_ENV: "production" }],
    ["an unknown PINE_INDEXER_ENV", { PINE_INDEXER_ENV: "staging" }],
    ["an http RPC with PINE_INDEXER_ENV=development but without the insecure flag", { RPC_SECONDARY_URL: "http://127.0.0.1:8545", PINE_INDEXER_ENV: "development" }],
    ["a bad address", { CLAIM_REGISTRY_ADDRESS: "0x1234" }],
    ["duplicate indexed addresses", { EVIDENCE_REGISTRY_ADDRESS: ENV.CLAIM_REGISTRY_ADDRESS }],
    ["a chunk below the floor", { CHUNK_SIZE: "10" }],
    ["a negative block", { DEPLOYMENT_BLOCK: "-1" }],
  ])("refuses %s, naming variables but never their values", (_label, override) => {
    const env = { ...ENV, ...override };
    let error: unknown;
    try {
      loadConfig(env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(String((error as Error).message)).not.toContain(KEY);
    expect(String((error as Error).message)).not.toContain("dbpassword123");
  });

  it.each([
    ["DATABASE_URL", { DATABASE_URL: undefined }],
    ["RPC_PRIMARY_URL", { RPC_PRIMARY_URL: undefined }],
    ["RPC_SECONDARY_URL", { RPC_SECONDARY_URL: undefined }],
    ["CHAIN_ID", { CHAIN_ID: undefined }],
    ["CLAIM_REGISTRY_ADDRESS", { CLAIM_REGISTRY_ADDRESS: undefined }],
    ["EVIDENCE_REGISTRY_ADDRESS", { EVIDENCE_REGISTRY_ADDRESS: undefined }],
    ["DEPLOYMENT_BLOCK", { DEPLOYMENT_BLOCK: undefined }],
    ["DEPLOYMENT_BLOCK", { DEPLOYMENT_BLOCK: "1.5" }],
    ["REALITY_ADDRESS", { REALITY_ADDRESS: "0xnot-an-address" }],
    ["CONDITIONAL_TOKENS_ADDRESS", { CONDITIONAL_TOKENS_ADDRESS: "0x12" }],
    ["KLEROS_HOME_PROXY_ADDRESS", { KLEROS_HOME_PROXY_ADDRESS: "" }],
    ["CHUNK_SIZE", { CHUNK_SIZE: "2001" }],
    ["CHUNK_SIZE", { CHUNK_SIZE: "49" }],
    ["POLL_INTERVAL_MS", { POLL_INTERVAL_MS: "499" }],
    ["POLL_INTERVAL_MS", { POLL_INTERVAL_MS: "600001" }],
    ["POLL_INTERVAL_MS", { POLL_INTERVAL_MS: "fast" }],
    ["METRICS_PORT", { METRICS_PORT: "0" }],
    ["METRICS_PORT", { METRICS_PORT: "65536" }],
    ["METRICS_HOST", { METRICS_HOST: "host name with spaces" }],
    ["QUESTION_TIMEOUT", { QUESTION_TIMEOUT: "0" }],
    ["QUESTION_TIMEOUT", { QUESTION_TIMEOUT: "4294967296" }],
    ["LOG_LEVEL", { LOG_LEVEL: "trace" }],
    ["RPC_ALLOW_INSECURE_HTTP", { RPC_ALLOW_INSECURE_HTTP: "yes" }],
  ])("names %s in the refusal (missing or out of range) and never echoes a value", (variable, override) => {
    let error: unknown;
    try {
      loadConfig({ ...ENV, ...override });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = String((error as Error).message);
    expect(message).toContain(variable);
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("dbpassword123");
    for (const value of Object.values(override)) if (value !== undefined && value.length > 1) expect(message).not.toContain(value);
  });

  it("allows http RPC URLs only with the insecure flag AND the explicit PINE_INDEXER_ENV=development marker", () => {
    const insecure = { ...ENV, RPC_SECONDARY_URL: "http://127.0.0.1:8545", RPC_ALLOW_INSECURE_HTTP: "true" };
    expect(loadConfig({ ...insecure, PINE_INDEXER_ENV: "development" }).rpcSecondaryUrl).toBe("http://127.0.0.1:8545");
    // The flag alone (no NODE_ENV, no marker: what a production host that forgot NODE_ENV looks like) is refused.
    expect(() => loadConfig(insecure)).toThrow(/RPC_ALLOW_INSECURE_HTTP/);
    // The marker alone does not allow http.
    expect(() => loadConfig({ ...ENV, RPC_SECONDARY_URL: "http://127.0.0.1:8545", PINE_INDEXER_ENV: "development" })).toThrow(/RPC_SECONDARY_URL/);
  });

  it("provider independence uses the last two DNS labels (a documented registrable-domain heuristic)", () => {
    expect(providerDomain("https://gnosis-mainnet.g.alchemy.com/v2/key")).toBe("alchemy.com");
    expect(providerDomain("https://rpc.gnosischain.com")).toBe("gnosischain.com");
    expect(providerDomain("https://RPC.Ankr.com./gnosis")).toBe("ankr.com");
    expect(() => loadConfig({ ...ENV, RPC_PRIMARY_URL: "https://a.gnosischain.com", RPC_SECONDARY_URL: "https://b.gnosischain.com" })).toThrow(ConfigError);
    expect(loadConfig({ ...ENV, RPC_PRIMARY_URL: "https://gnosis-mainnet.g.alchemy.com/v2/k", RPC_SECONDARY_URL: "https://rpc.ankr.com/gnosis" }).chainId).toBe(100);
  });

  it("registers URL secrets with the redactor", () => {
    const redact = createRedactor(configSecrets(loadConfig(ENV)));
    const text = redact(`failed ${ENV.RPC_PRIMARY_URL} and ${ENV.DATABASE_URL}; key ${KEY}; password dbpassword123`);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("dbpassword123");
  });
});

describe("metrics and health endpoints", () => {
  it("serves /healthz, /readyz and /metrics and nothing else", async () => {
    const metrics = createMetrics();
    metrics.indexedBlock.set(42);
    let ready = false;
    const server = createHealthServer({ metrics, host: "127.0.0.1", port: 0, ready: async () => ready });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const get = (path: string, method = "GET") => fetch(`http://127.0.0.1:${port}${path}`, { method });
    try {
      expect((await get("/healthz")).status).toBe(200);
      expect((await get("/readyz")).status).toBe(503);
      ready = true;
      expect((await get("/readyz")).status).toBe(200);
      const body = await (await get("/metrics")).text();
      expect(body).toContain("pine_indexer_indexed_block 42");
      expect(body).toContain("pine_indexer_errors_total");
      expect((await get("/other")).status).toBe(404);
      expect((await get("/metrics", "POST")).status).toBe(405);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("RPC response validation", () => {
  const log = {
    address: "0xE78996A233895bE74a66F451f1019cA9734205cc",
    topics: [`0x${"ab".repeat(32)}`],
    data: "0x",
    blockNumber: "0x10",
    blockHash: `0x${"cd".repeat(32)}`,
    transactionHash: `0x${"ef".repeat(32)}`,
    logIndex: "0x2",
    removed: false,
  };

  it("lowercases and converts a valid log", () => {
    expect(parseRawLogs([log])).toEqual([
      { address: "0xe78996a233895be74a66f451f1019ca9734205cc", topics: log.topics, data: "0x", blockNumber: 16n, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: 2 },
    ]);
  });

  it.each([
    ["a removed log", { removed: true }],
    ["a pending log", { blockHash: null }],
    ["odd-length data", { data: "0x123" }],
    ["no topics", { topics: [] }],
    ["five topics", { topics: Array(5).fill(log.topics[0]) }],
    ["a non-hex quantity", { blockNumber: "16" }],
    ["a short address", { address: "0x1234" }],
  ])("rejects %s as invalid RPC data (halt)", (_label, override) => {
    expect(() => parseRawLogs([{ ...log, ...override }])).toThrow(InvalidRpcDataError);
  });

  it("more logs than the parser cap is a size failure (split), never invalid data (halt)", () => {
    const many = Array.from({ length: 6 }, (_, index) => ({ ...log, logIndex: `0x${index.toString(16)}` }));
    expect(parseRawLogs(many, 6)).toHaveLength(6);
    let error: unknown;
    try {
      parseRawLogs(many, 5);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).kind).toBe("size");
  });

  it("rejects malformed headers", () => {
    expect(parseHeader({ number: "0x1", hash: `0x${"00".repeat(32)}`, timestamp: "0x5" })).toEqual({ number: 1n, hash: `0x${"00".repeat(32)}`, timestamp: 5 });
    expect(() => parseHeader({ number: "0x1", hash: "0x00", timestamp: "0x5" })).toThrow(InvalidRpcDataError);
    expect(() => parseHeader(null)).toThrow(InvalidRpcDataError);
  });
});

describe("driver portability (decisions.md)", () => {
  it("production code never reads rowCount/affectedRows", () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".ts"))) {
      const text = readFileSync(path.join(dir, name), "utf8");
      expect(/rowCount|affectedRows/.test(text.replace(/^\s*\/\/.*$/gm, "")), name).toBe(false);
    }
  });
});
