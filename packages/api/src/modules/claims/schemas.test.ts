// Must stay the first import: serializes the memory-heavy claims test files (see test/lock.ts).
import "./test/lock.js";
import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalBytes, type JsonValue } from "@pine/shared/canonical";
import { claimDocumentSchema, parseClaimDocumentBytes, ClaimDocumentError } from "@pine/shared/claim-document";
import { evidenceManifestSchema, parseEvidenceManifestBytes, type EvidenceManifest } from "@pine/shared/evidence";
import { exampleClaimDocument } from "@pine/shared/testing/fixtures";
import type { RouteModule } from "../../contracts/app.js";
import { buildTestApp } from "../../contracts/testing.js";
import { useHarness } from "./test/helpers.js";

const harnessOf = useHarness();
const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.close();
});

function exampleManifest(): EvidenceManifest {
  return {
    schema: "urn:pine:evidence-manifest:v1",
    submitter: "0x0000000000000000000000000000000000000b0b",
    claim: { chainId: 100, market: "0x0000000000000000000000000000000000000ca1", claimDocumentSha256: `0x${"ab".repeat(32)}`, commit: "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12" },
    title: "Reporter deposit drew from the gas reserve",
    violatedRequirement: "Each reporter-funding deposit's principal is allocated only from eligible funds.",
    summary: "A crash between two steps reuses the reserve.",
    expectedBehavior: "Deposit funded from bridging funds.",
    actualBehavior: "Deposit funded from the operator reserve.",
    reproduction: { environment: "Node 24", setup: "yarn install", command: "yarn test reporter", initialState: "", notes: "" },
    artifacts: [{ name: "output.txt", sha256: `0x${"cd".repeat(32)}`, size: 120, mediaType: "text/plain", locators: [], description: "test output" }],
  };
}

/** A strict validator app whose body schema is exactly the served JSON Schema (without $schema). */
async function validatorFor(url: string): Promise<{ check(body: unknown): Promise<number>; served: Record<string, unknown> }> {
  const h = harnessOf();
  const response = await h.app.inject({ method: "GET", url });
  expect(response.statusCode).toBe(200);
  const served = response.json() as Record<string, unknown>;
  expect(String(served.$comment)).toMatch(/text-safety rules.*title rules.*cross-field rules.*server-side only/i);
  const { $schema: _ignored, ...schema } = served;
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } } });
  app.post("/validate", { schema: { body: schema } }, async () => ({ ok: true }));
  await app.ready();
  apps.push(app);
  return {
    served,
    async check(body) {
      return (await app.inject({ method: "POST", url: "/validate", payload: body as Record<string, unknown> })).statusCode;
    },
  };
}

describe("schema endpoints", () => {
  it("claim-document.json accepts valid fixtures and rejects structural tampering", async () => {
    const validator = await validatorFor("/api/v1/schemas/claim-document.json");
    expect(validator.served.title).toBe("urn:pine:claim:v1");
    const valid = exampleClaimDocument();
    expect(await validator.check(valid)).toBe(200);
    expect(await validator.check({ ...valid, target: { ...valid.target, baseCommit: "0123456789abcdef0123456789abcdef01234567" } })).toBe(200);
    expect(await validator.check({ ...valid, target: { ...valid.target, membership: { ...valid.target.membership, ref: { kind: "branch", name: "main" } } } })).toBe(200);

    const { creator: _creator, ...missing } = valid;
    expect(await validator.check(missing)).toBe(400);
    expect(await validator.check({ ...valid, extra: true })).toBe(400);
    expect(await validator.check({ ...valid, claim: { ...valid.claim, unexpected: "x" } })).toBe(400);
    expect(await validator.check({ ...valid, market: { ...valid.market, questionTimeoutSeconds: "302400" } })).toBe(400);
    expect(await validator.check({ ...valid, claim: { ...valid.claim, regressionOnly: "false" } })).toBe(400);
    expect(await validator.check({ ...valid, nonce: "0x1234" })).toBe(400);
    expect(await validator.check({ ...valid, target: { ...valid.target, commit: "xyz" } })).toBe(400);
    expect(await validator.check({ ...valid, schema: "urn:pine:claim:v2" })).toBe(400);
  });

  it("evidence-manifest.json accepts valid fixtures and rejects structural tampering", async () => {
    const validator = await validatorFor("/api/v1/schemas/evidence-manifest.json");
    const valid = exampleManifest();
    expect(evidenceManifestSchema.safeParse(valid).success).toBe(true);
    expect(await validator.check(valid)).toBe(200);
    expect(await validator.check({ ...valid, artifacts: [] })).toBe(200);
    const { summary: _summary, ...missing } = valid;
    expect(await validator.check(missing)).toBe(400);
    expect(await validator.check({ ...valid, claim: { ...valid.claim, extra: 1 } })).toBe(400);
    expect(await validator.check({ ...valid, claim: { ...valid.claim, chainId: "100" } })).toBe(400);
    expect(await validator.check({ ...valid, submitter: "0xnope" })).toBe(400);
    expect(await validator.check({ ...valid, artifacts: [{ ...valid.artifacts[0]!, name: "dir/file.txt" }] })).toBe(400);
  });

  it("refinements JSON Schema cannot express are enforced by the frozen parse functions", async () => {
    const validator = await validatorFor("/api/v1/schemas/claim-document.json");
    const valid = exampleClaimDocument();
    const refined = [
      { ...valid, claim: { ...valid.claim, title: "Title with \" quote" } },
      { ...valid, claim: { ...valid.claim, requirement: "Bidi \u202e override" } },
      { ...valid, claim: { ...valid.claim, violation: "Zero\u200bwidth" } },
      { ...valid, market: { ...valid.market, openingTime: valid.market.openingTime + 1 } },
      { ...valid, claim: { ...valid.claim, regressionOnly: true } },
    ];
    for (const document of refined) {
      // Structurally valid, so the JSON Schema accepts it...
      expect(await validator.check(document)).toBe(200);
      // ...but the server-side parser refuses it.
      expect(claimDocumentSchema.safeParse(document).success).toBe(false);
      expect(() => parseClaimDocumentBytes(canonicalBytes(document as unknown as JsonValue))).toThrow(ClaimDocumentError);
    }
    expect(parseClaimDocumentBytes(canonicalBytes(valid as unknown as JsonValue))).toEqual(valid);
    const manifest = exampleManifest();
    expect(() => parseEvidenceManifestBytes(new TextEncoder().encode(JSON.stringify(manifest, null, 2)))).toThrow(/canonical/);
  });
});

describe("frozen schemas are never response schemas (decisions)", () => {
  it("no claims route declares a Fastify response schema (the frozen zod schemas contain transforms)", async () => {
    const h = harnessOf();
    const routes: RouteOptions[] = [];
    const probe: RouteModule = {
      name: "claims-route-probe",
      async register(scope, ctx) {
        scope.addHook("onRoute", (route) => void routes.push(route));
        await h.module.register(scope, ctx);
      },
    };
    const app = await buildTestApp([probe], h.ctx);
    apps.push(app);
    expect(routes.map((route) => route.url)).toEqual(expect.arrayContaining(["/api/v1/schemas/claim-document.json", "/api/v1/agents/claims/:market", "/api/v1/publications"]));
    expect(routes.filter((route) => route.schema?.response !== undefined).map((route) => route.url)).toEqual([]);
  });
});
