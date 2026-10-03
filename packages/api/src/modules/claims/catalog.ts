// Policy catalog (PRD-03 §2, SEC-CLAIM-03/06): loaded once from <catalogDir>/catalog.json, every file verified against
// its pinned SHA-256 and size. Refuses to load on any discrepancy, so the module refuses to start.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { rawCidFromBytes, sha256Hex } from "@pine/shared/canonical";
import { safeText } from "@pine/shared/claim-document";
import type { Hex32 } from "@pine/shared/types";
import type { AppConfig } from "../../contracts/config.js";
import { ApiError } from "../../contracts/errors.js";

export const POLICY_FILE_MAX_BYTES = 262_144;
/** Disabled in every environment until a human-approved disclosure process exists (SEC-CLAIM-06, SEC-LEGAL-09). */
export const DISABLED_POLICY_IDS: ReadonlySet<string> = new Set(["SC-001"]);

export const policyIdSchema = z.string().regex(/^[A-Z]{2,8}-\d{3}$/, "must be a policy id such as FUNC-001");
export const policyVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/, "must be a semantic version such as 0.1.0");

const catalogEntrySchema = z.object({
  id: policyIdSchema,
  family: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  version: policyVersionSchema,
  file: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.md$/, "must be <dir>/<file>.md inside the catalog"),
  sha256: z.string().regex(/^0x[0-9a-f]{64}$/),
  bytes: z.number().int().positive().max(POLICY_FILE_MAX_BYTES),
  status: z.enum(["draft", "approved", "disabled", "retired"]),
  enabled: z.boolean(),
  gate: z.string().max(1000).optional(),
});

const catalogSchema = z.object({
  schema: z.literal("urn:pine:policy-catalog:v1"),
  description: z.string().optional(),
  policies: z.array(catalogEntrySchema).min(1).max(500),
});

export type PolicyStatus = z.infer<typeof catalogEntrySchema>["status"];

export interface PolicyEntry {
  id: string;
  version: string;
  family: string;
  title: string;
  sha256: Hex32;
  cid: string;
  bytes: number;
  status: PolicyStatus;
  enabled: boolean;
  gate: string | null;
  text: string;
  /** The verified file bytes (digest `sha256`): what POST /publications stores and pins next to the claim document. */
  content: Uint8Array;
}

/**
 * Policy-parameter schemas per id@version. Frozen with the version they belong to: a published version's schema never
 * changes. Unknown keys are refused.
 */
export const POLICY_PARAMETER_SCHEMAS: ReadonlyMap<string, z.ZodType<Record<string, unknown>>> = new Map<string, z.ZodType<Record<string, unknown>>>([
  [
    "BOT-001@0.1.0",
    z
      .object({
        sourceRequirement: safeText(1_000),
        startingStates: safeText(4_000),
        simulatedAdapters: z.array(safeText(100)).max(20),
      })
      .strict(),
  ],
  ["FUNC-001@0.1.0", z.object({ formatDefinition: safeText(4_000).optional() }).strict()],
]);

export class PolicyCatalog {
  private readonly byKey = new Map<string, PolicyEntry>();

  constructor(readonly entries: readonly PolicyEntry[]) {
    for (const entry of entries) this.byKey.set(`${entry.id}@${entry.version}`, entry);
  }

  get(id: string, version: string): PolicyEntry | null {
    return this.byKey.get(`${id}@${version}`) ?? null;
  }

  parameterSchema(id: string, version: string): z.ZodType<Record<string, unknown>> | null {
    return POLICY_PARAMETER_SCHEMAS.get(`${id}@${version}`) ?? null;
  }

  /** Every catalog entry with this exact file digest (any status). */
  bySha256(sha256: string): PolicyEntry[] {
    return this.entries.filter((entry) => entry.sha256 === sha256);
  }

  /** Policy parameters against the per-version schema (false when the version has none). */
  parametersValid(id: string, version: string, parameters: unknown): boolean {
    const schema = this.parameterSchema(id, version);
    return schema !== null && schema.safeParse(parameters).success;
  }

  /** Publication gate (PRD-03 §2): applied at draft create/update, preview and publication. */
  isPublishable(entry: PolicyEntry, config: AppConfig): boolean {
    return publishRefusal(this, entry, config) === null;
  }

  /**
   * Digests of the currently publishable policies (PRD-03 §8a): the listing filter, computed per request from the
   * catalog and the configuration and never stored. Empty in production until a policy is approved (a launch gate).
   */
  publishableDigests(config: AppConfig): Hex32[] {
    // A digest shared by several entries counts only when every one of them is publishable (safer reading).
    const digests = new Set(this.entries.map((entry) => entry.sha256));
    return [...digests].filter((digest) => this.bySha256(digest).every((entry) => this.isPublishable(entry, config)));
  }

  /** The policy for a draft/preview/publication, or the ApiError explaining why it cannot be published. */
  requirePublishable(id: string, version: string, config: AppConfig): PolicyEntry {
    if (DISABLED_POLICY_IDS.has(id)) throw new ApiError("FEATURE_DISABLED", `Policy ${id} is disabled until a disclosure process is approved`);
    const entry = this.get(id, version);
    if (!entry) throw new ApiError("UNPROCESSABLE", "Unknown policy id or version", { issues: [{ path: ["policy"], message: "not in the policy catalog" }] });
    const refusal = publishRefusal(this, entry, config);
    if (refusal) throw refusal;
    return entry;
  }
}

function publishRefusal(catalog: PolicyCatalog, entry: PolicyEntry, config: AppConfig): ApiError | null {
  if (DISABLED_POLICY_IDS.has(entry.id)) return new ApiError("FEATURE_DISABLED", `Policy ${entry.id} is disabled until a disclosure process is approved`);
  if (!entry.enabled || entry.status === "disabled") return new ApiError("FEATURE_DISABLED", `Policy ${entry.id} is disabled`);
  if (!config.claims.enabledPolicyFamilies.includes(entry.id)) return new ApiError("FEATURE_DISABLED", `Policy ${entry.id} is not enabled on this deployment`);
  if (entry.status === "retired") return new ApiError("UNPROCESSABLE", `Policy ${entry.id}@${entry.version} is retired`);
  if (entry.status === "draft" && !(config.claims.allowDraftPolicies && config.environment !== "production")) {
    return new ApiError("UNPROCESSABLE", `Policy ${entry.id}@${entry.version} is a draft and cannot be published on this deployment`);
  }
  if (!catalog.parameterSchema(entry.id, entry.version)) return new ApiError("FEATURE_DISABLED", `Policy ${entry.id}@${entry.version} has no parameter schema`);
  return null;
}

/** Loads and verifies the catalog. Throws (refusing startup) on any malformed entry, duplicate, size or digest mismatch. */
export function loadPolicyCatalog(catalogDir: string): PolicyCatalog {
  const root = path.resolve(catalogDir);
  const rawCatalog = readFileSync(path.join(root, "catalog.json"));
  if (rawCatalog.byteLength > POLICY_FILE_MAX_BYTES) throw new Error("policy catalog: catalog.json is too large");
  const parsed = catalogSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawCatalog)));
  if (!parsed.success) {
    throw new Error(`policy catalog: malformed catalog.json (${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")})`);
  }
  const seen = new Set<string>();
  const entries: PolicyEntry[] = [];
  for (const item of parsed.data.policies) {
    const key = `${item.id}@${item.version}`;
    if (seen.has(key)) throw new Error(`policy catalog: ${key} appears twice`);
    seen.add(key);
    const file = path.resolve(root, item.file);
    if (!file.startsWith(root + path.sep)) throw new Error(`policy catalog: ${key} file is outside the catalog`);
    const size = statSync(file).size;
    if (size > POLICY_FILE_MAX_BYTES) throw new Error(`policy catalog: ${key} file exceeds ${POLICY_FILE_MAX_BYTES} bytes`);
    const bytes = new Uint8Array(readFileSync(file));
    if (bytes.byteLength > POLICY_FILE_MAX_BYTES) throw new Error(`policy catalog: ${key} file exceeds ${POLICY_FILE_MAX_BYTES} bytes`);
    if (bytes.byteLength !== item.bytes) throw new Error(`policy catalog: ${key} file size differs from the catalog`);
    const digest = sha256Hex(bytes);
    if (digest !== item.sha256) throw new Error(`policy catalog: ${key} file digest differs from the catalog`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`policy catalog: ${key} file is not valid UTF-8`);
    }
    entries.push({
      id: item.id,
      version: item.version,
      family: item.family,
      title: item.title,
      sha256: digest,
      cid: rawCidFromBytes(bytes),
      bytes: bytes.byteLength,
      status: item.status,
      enabled: item.enabled,
      gate: item.gate ?? null,
      text,
      content: bytes,
    });
  }
  return new PolicyCatalog(entries);
}
