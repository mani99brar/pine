// VENDORED from packages/shared/src by frontend/scripts/sync-shared.mjs. Do not edit: change the original and re-run
// the script (CI runs it with --check).
// FROZEN. Evidence commitment (byte-identical to EvidenceRegistry.computeCommitment) and the evidence manifest format.

import { encodeAbiParameters, keccak256, toBytes } from "viem";
import { z } from "zod";
import { canonicalBytes, RAW_CID_MAX_BYTES, sha256Hex, type JsonValue } from "./canonical";
import type { Address, Hex32 } from "./types";
import { addressSchema, gitObjectIdSchema, hex32Schema } from "./types";

export const EVIDENCE_COMMITMENT_TYPE =
  "PineEvidenceCommitment(uint256 chainId,address registry,address market,address submitter,bytes32 contentSha256,bytes32 salt)";

export const EVIDENCE_COMMITMENT_TYPEHASH: Hex32 = keccak256(toBytes(EVIDENCE_COMMITMENT_TYPE));

export interface CommitmentInput {
  chainId: number;
  registry: Address;
  market: Address;
  submitter: Address;
  contentSha256: Hex32;
  /** 32 random bytes, generated client-side and kept secret until reveal. Must be nonzero. */
  salt: Hex32;
}

/** keccak256(abi.encode(TYPEHASH, chainId, registry, market, submitter, contentSha256, salt)). */
export function computeEvidenceCommitment(input: CommitmentInput): Hex32 {
  if (/^0x0{64}$/.test(input.salt)) throw new Error("salt must be nonzero");
  if (/^0x0{64}$/.test(input.contentSha256)) throw new Error("contentSha256 must be nonzero");
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        EVIDENCE_COMMITMENT_TYPEHASH,
        BigInt(input.chainId),
        input.registry,
        input.market,
        input.submitter,
        input.contentSha256,
        input.salt,
      ],
    ),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Evidence manifest v1: the document whose SHA-256 is committed/revealed on-chain. RFC 8785 canonical UTF-8 JSON of
// at most 256 KiB (one raw IPFS block; its CID is derivable from the digest). It names its submitter, so a copied
// manifest revealed by someone else is attributable to the original author. Artifacts are referenced by SHA-256 (each
// at most 256 KiB) and are opaque, untrusted blobs that the platform never extracts, renders or executes.
// ---------------------------------------------------------------------------------------------------------------

export const EVIDENCE_MANIFEST_SCHEMA_ID = "urn:pine:evidence-manifest:v1";
export const EVIDENCE_MANIFEST_MAX_BYTES = RAW_CID_MAX_BYTES;
export const EVIDENCE_ARTIFACT_MAX_BYTES = RAW_CID_MAX_BYTES;

const text = (max: number) => z.string().min(1).max(max);

export const evidenceArtifactSchema = z
  .object({
    // eslint-disable-next-line no-control-regex -- rejects control characters in file names
    name: text(200).regex(/^[^/\\\u0000-\u001f]+$/, "plain file name without path separators or control characters"),
    sha256: hex32Schema,
    size: z.number().int().nonnegative().max(EVIDENCE_ARTIFACT_MAX_BYTES),
    mediaType: text(100).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
    /** Inert, untrusted text the platform never fetches; the artifact is located by its sha256 (raw CID). */
    locators: z.array(text(512)).max(4),
    description: z.string().max(2_000),
  })
  .strict();

export const evidenceManifestSchema = z
  .object({
    schema: z.literal(EVIDENCE_MANIFEST_SCHEMA_ID),
    /** The wallet that commits/publishes this manifest on the EvidenceRegistry. */
    submitter: addressSchema,
    claim: z
      .object({
        chainId: z.number().int().positive(),
        market: addressSchema,
        claimDocumentSha256: hex32Schema,
        commit: gitObjectIdSchema,
      })
      .strict(),
    title: text(200),
    /** Quote of the exact requirement/invariant from the claim document that is violated. */
    violatedRequirement: text(4_000),
    summary: text(10_000),
    expectedBehavior: text(4_000),
    actualBehavior: text(4_000),
    reproduction: z
      .object({
        environment: text(4_000),
        setup: text(10_000),
        command: text(2_000),
        initialState: z.string().max(10_000),
        notes: z.string().max(10_000),
      })
      .strict(),
    artifacts: z.array(evidenceArtifactSchema).max(16),
  })
  .strict();

export type EvidenceManifest = z.infer<typeof evidenceManifestSchema>;
export type EvidenceArtifact = z.infer<typeof evidenceArtifactSchema>;

export class EvidenceManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceManifestError";
  }
}

export function encodeEvidenceManifest(manifest: EvidenceManifest): { bytes: Uint8Array; sha256: Hex32 } {
  const parsed = evidenceManifestSchema.safeParse(manifest);
  if (!parsed.success) throw new EvidenceManifestError("invalid evidence manifest");
  const bytes = canonicalBytes(parsed.data as unknown as JsonValue);
  if (bytes.byteLength > EVIDENCE_MANIFEST_MAX_BYTES) throw new EvidenceManifestError("evidence manifest exceeds 256 KiB");
  return { bytes, sha256: sha256Hex(bytes) };
}

/** Accepts only valid UTF-8 JSON that matches the schema and is byte-identical to its RFC 8785 canonical form. */
export function parseEvidenceManifestBytes(bytes: Uint8Array, expectedSha256?: Hex32): EvidenceManifest {
  if (bytes.byteLength > EVIDENCE_MANIFEST_MAX_BYTES) throw new EvidenceManifestError("evidence manifest exceeds 256 KiB");
  if (expectedSha256 !== undefined && sha256Hex(bytes) !== expectedSha256.toLowerCase()) throw new EvidenceManifestError("evidence manifest digest mismatch");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new EvidenceManifestError("evidence manifest is not valid UTF-8 JSON");
  }
  const parsed = evidenceManifestSchema.safeParse(json);
  if (!parsed.success) throw new EvidenceManifestError("evidence manifest does not match urn:pine:evidence-manifest:v1");
  const canonical = canonicalBytes(parsed.data as unknown as JsonValue);
  if (canonical.byteLength !== bytes.byteLength || !canonical.every((byte, index) => byte === bytes[index])) {
    throw new EvidenceManifestError("evidence manifest bytes are not in canonical form");
  }
  return parsed.data;
}
