// Must stay the first import: serializes the memory-heavy claims test files (see test/lock.ts).
import "./test/lock.js";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../contracts/config.js";
import { buildTestApp, testSessionHeaders } from "../../contracts/testing.js";
import { fileURLToPath } from "node:url";
import { claimsModule, createClaimsModule, DEFAULT_CATALOG_DIR } from "./index.js";
import { BOT_POLICY_SHA, copyCatalog, draftBody, useHarness } from "./test/helpers.js";

const harnessOf = useHarness();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function catalog(): Promise<string> {
  const dir = await copyCatalog();
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The shared harness, or a variant app on the same database when the test needs another configuration. */
async function harness(options: { config?: Partial<AppConfig> } = {}) {
  const h = harnessOf();
  if (!options.config) return h;
  const variant = await h.variant(options.config);
  return { ...h, ...variant };
}

const claimsConfig = () => harnessOf().ctx.config.claims;

async function editCatalog(dir: string, edit: (json: { policies: Record<string, unknown>[] }) => void): Promise<void> {
  const file = path.join(dir, "catalog.json");
  const json = JSON.parse(await readFile(file, "utf8")) as { policies: Record<string, unknown>[] };
  edit(json);
  await writeFile(file, JSON.stringify(json));
}

describe("policy catalog loading (SEC-CLAIM-03)", () => {
  it("refuses startup when a policy file's digest differs from the catalog", async () => {
    const dir = await catalog();
    const file = path.join(dir, "BOT-001", "0.1.0.md");
    const text = await readFile(file, "utf8");
    // Same length, one byte changed.
    await writeFile(file, text.replace("Automation", "Automatiom"));
    await expect(buildTestApp([createClaimsModule({ catalogDir: dir })], harnessOf().ctx)).rejects.toThrow(/digest differs/);
  });

  it("refuses startup for oversized files, malformed ids or versions, and duplicate versions", async () => {
    const ctx = harnessOf().ctx;
    const oversized = await catalog();
    await writeFile(path.join(oversized, "FUNC-001", "0.1.0.md"), "x".repeat(262_145));
    await expect(buildTestApp([createClaimsModule({ catalogDir: oversized })], ctx)).rejects.toThrow(/exceeds 262144 bytes/);

    const badId = await catalog();
    await editCatalog(badId, (json) => {
      json.policies[0]!.id = "func-001";
    });
    await expect(buildTestApp([createClaimsModule({ catalogDir: badId })], ctx)).rejects.toThrow(/malformed/);

    const badVersion = await catalog();
    await editCatalog(badVersion, (json) => {
      json.policies[0]!.version = "1.0";
    });
    await expect(buildTestApp([createClaimsModule({ catalogDir: badVersion })], ctx)).rejects.toThrow(/malformed/);

    const duplicate = await catalog();
    await editCatalog(duplicate, (json) => {
      json.policies.push({ ...json.policies[0]! });
    });
    await expect(buildTestApp([createClaimsModule({ catalogDir: duplicate })], ctx)).rejects.toThrow(/appears twice/);

    const escape = await catalog();
    await editCatalog(escape, (json) => {
      json.policies[0]!.file = "../catalog.json";
    });
    await expect(buildTestApp([createClaimsModule({ catalogDir: escape })], ctx)).rejects.toThrow(/malformed|outside/);
  });

  it("module registration throws when config.seer differs from the deployment manifest", async () => {
    const dir = await catalog();
    const base = harnessOf().ctx;
    const ctx = { ...base, config: { ...base.config, seer: { ...base.config.seer, realitio: "0x0000000000000000000000000000000000000bad" as const } } };
    await expect(buildTestApp([createClaimsModule({ catalogDir: dir })], ctx)).rejects.toThrow(/seer\.realitio/);
    // Jobs use the same memoized loader, so they refuse too even without register().
    const module = createClaimsModule({ catalogDir: dir });
    await expect(module.jobs![0]!.run(ctx, new AbortController().signal)).rejects.toThrow(/seer\.realitio/);
  });
});

describe("default module instance", () => {
  it("claimsModule is createClaimsModule over <repo>/policies/catalog and registers with the real (verified) catalog", async () => {
    expect(DEFAULT_CATALOG_DIR).toBe(fileURLToPath(new URL("../../../../../policies/catalog", import.meta.url)));
    expect(claimsModule.name).toBe("claims");
    expect(claimsModule.jobs?.map((job) => job.name)).toEqual(["claims.reconcile-publications", "claims.verify-integrity"]);
    const app = await buildTestApp([claimsModule], harnessOf().ctx);
    cleanups.push(() => app.close());
    const body = (await app.inject({ method: "GET", url: "/api/v1/policies" })).json() as { policies: { id: string; version: string; sha256: string }[] };
    expect(body.policies).toEqual(expect.arrayContaining([expect.objectContaining({ id: "BOT-001", version: "0.1.0", sha256: BOT_POLICY_SHA })]));
  });
});

describe("public policy routes", () => {
  it("lists policies with digest, CID, status and publishability", async () => {
    const h = await harness();
    const response = await h.app.inject({ method: "GET", url: "/api/v1/policies" });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBeTruthy();
    const body = response.json() as { policies: { id: string; publishable: boolean; sha256: string; cid: string; status: string }[] };
    const byId = new Map(body.policies.map((policy) => [policy.id, policy]));
    expect(byId.get("BOT-001")).toMatchObject({ status: "draft", publishable: true, sha256: "0x9404b90b7ea23aabc44a78b76b19e7b156e8e8ffaec699bd12b4dabdb2da2cfc" });
    expect(byId.get("BOT-001")!.cid).toMatch(/^bafkrei/);
    expect(byId.get("SC-001")).toMatchObject({ publishable: false });

    const again = await h.app.inject({ method: "GET", url: "/api/v1/policies", headers: { "if-none-match": String(response.headers.etag) } });
    expect(again.statusCode).toBe(304);
  });

  it("returns the policy text and a JSON Schema for its parameters", async () => {
    const h = await harness();
    const detail = await h.app.inject({ method: "GET", url: "/api/v1/policies/FUNC-001/0.1.0" });
    expect(detail.statusCode).toBe(200);
    const policy = detail.json() as { text: string; sha256: string };
    expect(policy.text).toContain("FUNC-001");

    const schema = await h.app.inject({ method: "GET", url: "/api/v1/policies/BOT-001/0.1.0/parameters.schema.json" });
    expect(schema.statusCode).toBe(200);
    const json = schema.json() as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean; $comment: string };
    expect(Object.keys(json.properties).sort()).toEqual(["simulatedAdapters", "sourceRequirement", "startingStates"]);
    expect(json.additionalProperties).toBe(false);
    expect(json.$comment).toMatch(/server-side/);

    expect((await h.app.inject({ method: "GET", url: "/api/v1/policies/NOPE-001/0.1.0" })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/policies/bad/0.1.0" })).statusCode).toBe(400);
  });

  it("reports draft policies as not publishable when allowDraftPolicies is false", async () => {
    const h = await harness({ config: { claims: { ...claimsConfig(), allowDraftPolicies: false } } });
    const body = (await h.app.inject({ method: "GET", url: "/api/v1/policies" })).json() as { policies: { id: string; publishable: boolean }[] };
    expect(body.policies.every((policy) => !policy.publishable)).toBe(true);
  });
});

describe("publication gate (SEC-CLAIM-06)", () => {
  it("SC-001 is FEATURE_DISABLED at draft creation in every configuration", async () => {
    const h = await harness({ config: { claims: { ...claimsConfig(), enabledPolicyFamilies: ["FUNC-001", "BOT-001", "SC-001"], allowDraftPolicies: true } } });
    const response = await h.app.inject({ method: "POST", url: "/api/v1/drafts", headers: h.headers, payload: draftBody({ policy: { id: "SC-001", version: "0.1.0" }, policyParameters: {} }) });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "FEATURE_DISABLED" } });
  });

  it("refuses draft policies when allowDraftPolicies is false, and in production even when it is true", async () => {
    const strict = await harness({ config: { claims: { ...claimsConfig(), allowDraftPolicies: false } } });
    const refused = await strict.app.inject({ method: "POST", url: "/api/v1/drafts", headers: strict.headers, payload: draftBody() });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: { code: "UNPROCESSABLE" } });

    const production = await harness({ config: { environment: "production", claims: { ...claimsConfig(), allowDraftPolicies: true } } });
    const alsoRefused = await production.app.inject({ method: "POST", url: "/api/v1/drafts", headers: production.headers, payload: draftBody() });
    expect(alsoRefused.statusCode).toBe(422);
  });

  it("refuses families that are not enabled and unknown policies", async () => {
    const h = await harness({ config: { claims: { ...claimsConfig(), enabledPolicyFamilies: ["FUNC-001"] } } });
    const disabled = await h.app.inject({ method: "POST", url: "/api/v1/drafts", headers: h.headers, payload: draftBody() });
    expect(disabled.json()).toMatchObject({ error: { code: "FEATURE_DISABLED" } });
    const unknown = await h.app.inject({ method: "POST", url: "/api/v1/drafts", headers: h.headers, payload: draftBody({ policy: { id: "FUNC-001", version: "9.9.9" } }) });
    expect(unknown.json()).toMatchObject({ error: { code: "UNPROCESSABLE" } });
  });

  it("validates policy parameters with the per-version schema (unknown keys refused)", async () => {
    const h = await harness();
    const extra = await h.app.inject({
      method: "POST",
      url: "/api/v1/drafts",
      headers: h.headers,
      payload: draftBody({ policyParameters: { sourceRequirement: "x", startingStates: "y", simulatedAdapters: [], unknown: 1 } }),
    });
    expect(extra.statusCode).toBe(400);
    const missing = await h.app.inject({ method: "POST", url: "/api/v1/drafts", headers: h.headers, payload: draftBody({ policyParameters: {} }) });
    expect(missing.statusCode).toBe(400);
    const func = await h.app.inject({
      method: "POST",
      url: "/api/v1/drafts",
      headers: testSessionHeaders(h.session),
      payload: draftBody({ policy: { id: "FUNC-001", version: "0.1.0" }, policyParameters: {} }),
    });
    expect(func.statusCode).toBe(201);
  });

  it("SEC-CLAIM-03 enforces the per-policy parameter length caps at the limit and one past it (PRD-03 §8c)", async () => {
    const h = await harness();
    const create = (policy: { id: string; version: string }, policyParameters: Record<string, unknown>) =>
      h.app.inject({ method: "POST", url: "/api/v1/drafts", headers: h.headers, payload: draftBody({ policy, policyParameters }) });
    const BOT = { id: "BOT-001", version: "0.1.0" };
    const FUNC = { id: "FUNC-001", version: "0.1.0" };
    const bot = (overrides: Record<string, unknown>) => ({ sourceRequirement: "spec 2.2", startingStates: "empty journal", simulatedAdapters: ["lifi"], ...overrides });
    const a = (length: number) => "a".repeat(length);
    const cases: [string, { id: string; version: string }, Record<string, unknown>, number][] = [
      ["sourceRequirement 1000", BOT, bot({ sourceRequirement: a(1_000) }), 201],
      ["sourceRequirement 1001", BOT, bot({ sourceRequirement: a(1_001) }), 400],
      ["startingStates 4000", BOT, bot({ startingStates: a(4_000) }), 201],
      ["startingStates 4001", BOT, bot({ startingStates: a(4_001) }), 400],
      ["simulatedAdapters 20 x 100", BOT, bot({ simulatedAdapters: Array.from({ length: 20 }, () => a(100)) }), 201],
      ["simulatedAdapters 21 items", BOT, bot({ simulatedAdapters: Array.from({ length: 21 }, () => a(1)) }), 400],
      ["simulatedAdapters item of 101", BOT, bot({ simulatedAdapters: [a(101)] }), 400],
      ["formatDefinition 4000", FUNC, { formatDefinition: a(4_000) }, 201],
      ["formatDefinition 4001", FUNC, { formatDefinition: a(4_001) }, 400],
    ];
    for (const [name, policy, parameters, status] of cases) expect((await create(policy, parameters)).statusCode, name).toBe(status);

    // The served JSON Schemas carry the same caps.
    const schemaOf = async (policy: { id: string; version: string }) =>
      (await h.app.inject({ method: "GET", url: `/api/v1/policies/${policy.id}/${policy.version}/parameters.schema.json` })).json() as { properties: Record<string, { maxLength?: number; maxItems?: number; items?: { maxLength?: number } }> };
    const botSchema = await schemaOf(BOT);
    expect(botSchema.properties.sourceRequirement?.maxLength).toBe(1_000);
    expect(botSchema.properties.startingStates?.maxLength).toBe(4_000);
    expect(botSchema.properties.simulatedAdapters).toMatchObject({ maxItems: 20, items: { maxLength: 100 } });
    expect((await schemaOf(FUNC)).properties.formatDefinition?.maxLength).toBe(4_000);
  });
});
