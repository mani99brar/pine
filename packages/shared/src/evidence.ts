// FROZEN. Evidence commitment (byte-identical to EvidenceRegistry.computeCommitment) and the evidence manifest format.

import { encodeAbiParameters, keccak256, toBytes } from "viem";
import { z } from "zod";
import type { Address, Hex32 } from "./types.js";
import { addressSchema, gitObjectIdSchema, hex32Schema } from "./types.js";

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
// Evidence manifest v1: the document whose SHA-256 is committed/revealed on-chain. Small UTF-8 JSON (RFC 8785
// canonical form recommended, not required: the hash is over the exact bytes). Artifacts are referenced by SHA-256
// and are opaque, untrusted blobs that the platform never extracts, renders or executes.
// ---------------------------------------------------------------------------------------------------------------

export const EVIDENCE_MANIFEST_SCHEMA_ID = "urn:pine:evidence-manifest:v1";
export const EVIDENCE_MANIFEST_MAX_BYTES = 256 * 1024;

const text = (max: number) => z.string().min(1).max(max);

export const evidenceArtifactSchema = z
  .object({
    name: text(200).regex(/^[^/\\\u0000-\u001f]+$/, "plain file name without path separators or control characters"),
    sha256: hex32Schema,
    size: z.number().int().nonnegative().max(1024 * 1024 * 1024),
    mediaType: text(100).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
    uris: z.array(text(512)).max(8).default([]),
    description: z.string().max(2_000).optional(),
  })
  .strict();

export const evidenceManifestSchema = z
  .object({
    schema: z.literal(EVIDENCE_MANIFEST_SCHEMA_ID),
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
        initialState: z.string().max(10_000).optional(),
        notes: z.string().max(10_000).optional(),
      })
      .strict(),
    artifacts: z.array(evidenceArtifactSchema).max(32).default([]),
  })
  .strict();

export type EvidenceManifest = z.infer<typeof evidenceManifestSchema>;
export type EvidenceArtifact = z.infer<typeof evidenceArtifactSchema>;
