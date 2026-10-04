// VENDORED from packages/shared/src by frontend/scripts/sync-shared.mjs. Do not edit: change the original and re-run
// the script (CI runs it with --check).
// FROZEN. The claim document (urn:pine:claim:v1): the immutable terms a market references by SHA-256.
// Stored and pinned as RFC 8785 canonical JSON bytes, at most CLAIM_DOCUMENT_MAX_BYTES (one raw IPFS block).
// parseClaimDocumentBytes accepts only canonical bytes, so duplicate keys, alternative encodings and unknown fields
// are all rejected (SEC-CLAIM-01/02).

import { z } from "zod";
import { canonicalBytes, sha256Hex, type JsonValue } from "./canonical";
import { MAX_TITLE_BYTES, validateTitle } from "./question";
import { addressSchema, gitObjectIdSchema, hex32Schema, type Hex32 } from "./types";
import { EVIDENCE_MANIFEST_SCHEMA_ID } from "./evidence";

export const CLAIM_DOCUMENT_SCHEMA_ID = "urn:pine:claim:v1";
export const CLAIM_DOCUMENT_MAX_BYTES = 256 * 1024;

// Bidi controls, zero-width characters, the Reality.eth field separator, C1 controls and the BOM.
// eslint-disable-next-line no-control-regex -- the class exists to reject control characters
const FORBIDDEN_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\u241f\ufeff]/u;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Untrusted human text: NFC-normalized, no control/bidi/zero-width characters (newline and tab allowed), bounded. */
export function safeText(max: number, min = 1) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((value) => !LONE_SURROGATE.test(value), "contains an unpaired surrogate")
    .refine((value) => value.normalize("NFC") === value, "must be Unicode NFC normalized")
    .refine((value) => !FORBIDDEN_CHARACTERS.test(value), "contains a forbidden control, bidi or zero-width character");
}

const isoSeconds = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "must be an ISO 8601 UTC timestamp with seconds precision (YYYY-MM-DDTHH:MM:SSZ)");
const unixSeconds = z.number().int().min(1).max(2 ** 32 - 1);
const uintDecimal = z.string().regex(/^(?:0|[1-9][0-9]{0,77})$/, "must be a base-10 unsigned integer string");

// Arbitrary JSON (for policy-specific parameters), bounded in depth, breadth and string size.
type BoundedJson = string | number | boolean | null | BoundedJson[] | { [key: string]: BoundedJson };
const boundedJson: z.ZodType<BoundedJson> = z.lazy(() =>
  z.union([
    safeText(4_000, 0),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(boundedJson).max(50),
    z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), boundedJson).refine((value) => Object.keys(value).length <= 50, "too many keys"),
  ]),
);

export const claimDocumentSchema = z
  .object({
    schema: z.literal(CLAIM_DOCUMENT_SCHEMA_ID),
    /** 32 random bytes chosen at composition; lets a creator publish a fresh document for otherwise identical terms. */
    nonce: hex32Schema,
    policy: z
      .object({
        id: z.string().regex(/^[A-Z]{2,8}-\d{3}$/),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        sha256: hex32Schema,
      })
      .strict(),
    target: z
      .object({
        host: z.literal("github.com"),
        repository: z
          .object({
            /** Stable numeric id: the identity. Owner/name are display snapshots at composition time. */
            id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            ownerLogin: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
            name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
          })
          .strict(),
        commit: gitObjectIdSchema,
        /** Required when claim.regressionOnly is true; otherwise null. */
        baseCommit: gitObjectIdSchema.nullable(),
        membership: z
          .object({
            method: z.enum(["pull_head", "pull_commit", "branch_ancestor"]),
            ref: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("pull"), number: z.number().int().positive() }).strict(),
              z.object({ kind: z.literal("branch"), name: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/) }).strict(),
            ]),
            verifiedAt: isoSeconds,
          })
          .strict(),
      })
      .strict(),
    claim: z
      .object({
        title: z.string().max(MAX_TITLE_BYTES).superRefine((value, ctx) => {
          try {
            validateTitle(value);
          } catch (error) {
            ctx.addIssue({ code: "custom", message: (error as Error).message });
          }
        }),
        requirement: safeText(4_000),
        violation: safeText(4_000),
        scope: z
          .object({
            components: z.array(safeText(300)).min(1).max(50),
            outOfScope: z.array(safeText(300)).max(50),
          })
          .strict(),
        allowedInputs: safeText(4_000),
        assumptions: z.array(safeText(1_000)).max(50),
        faultModel: safeText(4_000),
        regressionOnly: z.boolean(),
        exclusions: z.array(safeText(1_000)).max(50),
        /** Policy-family-specific structured parameters (validated by the policy's own schema in the API). */
        policyParameters: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), boundedJson),
      })
      .strict(),
    environment: z
      .object({
        runtime: safeText(2_000),
        dependencies: safeText(4_000),
        configuration: safeText(8_000),
        externalState: safeText(4_000),
        reproduction: z
          .object({
            setup: safeText(8_000),
            command: safeText(2_000),
            notes: safeText(8_000, 0),
          })
          .strict(),
      })
      .strict(),
    evidence: z
      .object({
        chainId: z.number().int().positive(),
        registry: addressSchema,
        evidenceDeadline: unixSeconds,
        revealDeadline: unixSeconds,
        manifestSchema: z.literal(EVIDENCE_MANIFEST_SCHEMA_ID),
      })
      .strict(),
    market: z
      .object({
        chainId: z.number().int().positive(),
        claimRegistry: addressSchema,
        seerMarketFactory: addressSchema,
        collateralToken: addressSchema,
        realitio: addressSchema,
        arbitrator: addressSchema,
        questionTimeoutSeconds: z.number().int().positive(),
        /** Equals evidence.revealDeadline. */
        openingTime: unixSeconds,
        minBondWei: uintDecimal,
      })
      .strict(),
    disclosure: z
      .object({
        /** Publisher attestation: no counterexample would demonstrate an exploitable flaw in a deployed system holding third-party funds or data. */
        liveSystemImpact: z.literal("none"),
      })
      .strict(),
    /** Wallet that will call ClaimRegistry.createClaim; a market created by any other address is not canonical. */
    creator: addressSchema,
    createdAt: isoSeconds,
  })
  .strict()
  .superRefine((doc, ctx) => {
    if (doc.evidence.revealDeadline <= doc.evidence.evidenceDeadline) {
      ctx.addIssue({ code: "custom", path: ["evidence", "revealDeadline"], message: "revealDeadline must be after evidenceDeadline" });
    }
    if (doc.market.openingTime !== doc.evidence.revealDeadline) {
      ctx.addIssue({ code: "custom", path: ["market", "openingTime"], message: "openingTime must equal evidence.revealDeadline" });
    }
    if (doc.market.chainId !== doc.evidence.chainId) {
      ctx.addIssue({ code: "custom", path: ["market", "chainId"], message: "market and evidence chain ids differ" });
    }
    if (doc.claim.regressionOnly && doc.target.baseCommit === null) {
      ctx.addIssue({ code: "custom", path: ["target", "baseCommit"], message: "regression-only claims need a base commit" });
    }
    if (doc.target.baseCommit !== null && doc.target.baseCommit === doc.target.commit) {
      ctx.addIssue({ code: "custom", path: ["target", "baseCommit"], message: "base commit must differ from the target commit" });
    }
  });

export type ClaimDocument = z.infer<typeof claimDocumentSchema>;

export class ClaimDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimDocumentError";
  }
}

/** Canonical bytes and digest of a document that passes the schema. Throws ClaimDocumentError otherwise. */
export function encodeClaimDocument(document: ClaimDocument): { bytes: Uint8Array; sha256: Hex32 } {
  const parsed = claimDocumentSchema.safeParse(document);
  if (!parsed.success) throw new ClaimDocumentError(`invalid claim document: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const bytes = canonicalBytes(parsed.data as unknown as JsonValue);
  if (bytes.byteLength > CLAIM_DOCUMENT_MAX_BYTES) throw new ClaimDocumentError("claim document exceeds 256 KiB");
  return { bytes, sha256: sha256Hex(bytes) };
}

/**
 * Parses bytes fetched from anywhere (IPFS, a mirror, an upload). Accepts them only if they are valid UTF-8, valid JSON,
 * pass the schema, and are byte-identical to their own RFC 8785 canonical form; optionally checks the expected digest.
 */
export function parseClaimDocumentBytes(bytes: Uint8Array, expectedSha256?: Hex32): ClaimDocument {
  if (bytes.byteLength > CLAIM_DOCUMENT_MAX_BYTES) throw new ClaimDocumentError("claim document exceeds 256 KiB");
  const digest = sha256Hex(bytes);
  if (expectedSha256 !== undefined && digest !== expectedSha256.toLowerCase()) throw new ClaimDocumentError("claim document digest mismatch");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ClaimDocumentError("claim document is not valid UTF-8");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ClaimDocumentError("claim document is not valid JSON");
  }
  const parsed = claimDocumentSchema.safeParse(json);
  if (!parsed.success) throw new ClaimDocumentError("claim document does not match urn:pine:claim:v1");
  const canonical = canonicalBytes(parsed.data as unknown as JsonValue);
  if (canonical.byteLength !== bytes.byteLength || !canonical.every((byte, index) => byte === bytes[index])) {
    throw new ClaimDocumentError("claim document bytes are not in canonical form");
  }
  return parsed.data;
}
