// Pure helpers of common.ts and the registration guard; no database (no suite lock: it holds no in-memory Postgres).
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../../contracts/app.js";
import type { AppConfig } from "../../contracts/config.js";
import { testConfig } from "../../contracts/testing.js";
import { BoundedCache } from "./common.js";
import { createMarketsModule } from "./index.js";

describe("BoundedCache (server cache of public RPC fan-out routes)", () => {
  it("serves an entry until exactly ttl seconds after it was set", () => {
    const cache = new BoundedCache<string>(10, 4);
    cache.set("a", "x", 100);
    expect(cache.get("a", 109)).toBe("x");
    expect(cache.get("a", 110)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("never grows beyond maxEntries: expired entries go first, then the oldest", () => {
    const cache = new BoundedCache<number>(10, 3);
    cache.set("a", 1, 100);
    cache.set("b", 2, 105);
    cache.set("c", 3, 106);
    // "a" expired at 110: it is evicted, the live entries stay.
    cache.set("d", 4, 111);
    expect(cache.size).toBe(3);
    expect([cache.get("b", 111), cache.get("c", 111), cache.get("d", 111)]).toEqual([2, 3, 4]);
    // Nothing expired: the oldest live entry ("b") makes room.
    cache.set("e", 5, 112);
    expect(cache.size).toBe(3);
    expect(cache.get("b", 112)).toBeUndefined();
    expect([cache.get("c", 112), cache.get("d", 112), cache.get("e", 112)]).toEqual([3, 4, 5]);
    // Re-setting a key refreshes it without evicting another.
    cache.set("c", 33, 113);
    expect(cache.size).toBe(3);
    expect(cache.get("c", 122)).toBe(33);
  });
});

describe("registration guard (PRD-04 4b): the module refuses to start on a configuration that disagrees with the manifest", () => {
  /** A Fastify stand-in that accepts any route registration and records the paths. */
  const stubApp = (paths: string[]): FastifyInstance => {
    const handler: ProxyHandler<object> = {
      get: (_target, property) => {
        if (property === "withTypeProvider") return () => proxy;
        if (property === "get" || property === "post") return (path: string) => void paths.push(path);
        return undefined;
      },
    };
    const proxy = new Proxy({}, handler);
    return proxy as FastifyInstance;
  };
  const register = async (config: AppConfig) => {
    const paths: string[] = [];
    await createMarketsModule().register(stubApp(paths), { config } as unknown as AppContext);
    return paths;
  };
  const base = testConfig();
  const other = "0x00000000000000000000000000000000000000e1";

  it("registers every route with the test configuration (positive control)", async () => {
    expect(await register(base)).toContain("/api/v1/evidence/artifacts");
  });

  it("throws for a questionCategory or questionLanguage other than the ClaimRegistry constants", async () => {
    await expect(register({ ...base, claims: { ...base.claims, questionCategory: "technology" } })).rejects.toThrow(/claims\.questionCategory/);
    await expect(register({ ...base, claims: { ...base.claims, questionLanguage: "en" } })).rejects.toThrow(/claims\.questionLanguage/);
  });

  it("throws for a Seer or Kleros address that differs from the deployment manifest", async () => {
    for (const field of ["realitio", "arbitrator", "realityProxy", "marketFactory", "gnosisRouter", "conditionalTokens", "wrapped1155Factory", "collateralToken", "klerosForeignProxy"] as const) {
      await expect(register({ ...base, seer: { ...base.seer, [field]: other } }), field).rejects.toThrow(new RegExp(`seer\\.${field}`));
    }
    await expect(register({ ...base, seer: { ...base.seer, questionTimeoutSeconds: 86_400 } })).rejects.toThrow(/seer\.questionTimeoutSeconds/);
    await expect(register({ ...base, seer: { ...base.seer, klerosForeignChainId: 5 } })).rejects.toThrow(/seer\.klerosForeignChainId/);
    // Address case does not matter (EIP-55 configuration).
    expect(await register({ ...base, seer: { ...base.seer, realitio: base.seer.realitio.toUpperCase().replace("0X", "0x") as typeof base.seer.realitio } })).not.toHaveLength(0);
  });

  it("throws for evidence.maxUploadBytes outside 1..262144", async () => {
    for (const maxUploadBytes of [0, -1, 262_145, 1.5, Number.NaN]) {
      await expect(register({ ...base, evidence: { ...base.evidence, maxUploadBytes } }), String(maxUploadBytes)).rejects.toThrow(/maxUploadBytes must be 1\.\.262144/);
    }
    expect(await register({ ...base, evidence: { ...base.evidence, maxUploadBytes: 1 } })).not.toHaveLength(0);
    expect(await register({ ...base, evidence: { ...base.evidence, maxUploadBytes: 262_144 } })).not.toHaveLength(0);
  });
});
