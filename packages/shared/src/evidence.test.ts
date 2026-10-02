import { describe, expect, it } from "vitest";
import { computeEvidenceCommitment, EVIDENCE_COMMITMENT_TYPEHASH, evidenceManifestSchema } from "./evidence.js";
import { EVIDENCE_COMMITMENT_VECTOR } from "./testing/vectors.js";

describe("evidence commitment", () => {
  it("matches the frozen cross-language vector", () => {
    expect(EVIDENCE_COMMITMENT_TYPEHASH).toBe(EVIDENCE_COMMITMENT_VECTOR.typehash);
    expect(computeEvidenceCommitment(EVIDENCE_COMMITMENT_VECTOR.input)).toBe(EVIDENCE_COMMITMENT_VECTOR.commitment);
  });
  it("binds every field", () => {
    const base = EVIDENCE_COMMITMENT_VECTOR.input;
    const variants = [
      { ...base, chainId: 1 },
      { ...base, registry: "0x1111111111111111111111111111111111111112" as const },
      { ...base, market: "0x2222222222222222222222222222222222222223" as const },
      { ...base, submitter: "0x3333333333333333333333333333333333333334" as const },
      { ...base, contentSha256: "0x4444444444444444444444444444444444444444444444444444444444444445" as const },
      { ...base, salt: "0x5555555555555555555555555555555555555555555555555555555555555556" as const },
    ];
    for (const variant of variants) expect(computeEvidenceCommitment(variant)).not.toBe(EVIDENCE_COMMITMENT_VECTOR.commitment);
  });
  it("rejects a zero salt or zero content hash", () => {
    const zero = `0x${"0".repeat(64)}` as const;
    expect(() => computeEvidenceCommitment({ ...EVIDENCE_COMMITMENT_VECTOR.input, salt: zero })).toThrow();
    expect(() => computeEvidenceCommitment({ ...EVIDENCE_COMMITMENT_VECTOR.input, contentSha256: zero })).toThrow();
  });
});

describe("evidence manifest", () => {
  const manifest = {
    schema: "urn:pine:evidence-manifest:v1",
    claim: { chainId: 100, market: "0x2222222222222222222222222222222222222222", claimDocumentSha256: `0x${"ab".repeat(32)}`, commit: "a".repeat(40) },
    title: "Reporter deposit drawn from arbitration allocation",
    violatedRequirement: "Reporter-deposit principal must not be funded from arbitration allocations.",
    summary: "s",
    expectedBehavior: "e",
    actualBehavior: "a",
    reproduction: { environment: "node 24", setup: "pnpm i", command: "pnpm test repro" },
    artifacts: [{ name: "repro.tar.gz", sha256: `0x${"cd".repeat(32)}`, size: 10, mediaType: "application/gzip" }],
  };
  it("accepts a valid manifest", () => {
    expect(evidenceManifestSchema.parse(manifest).artifacts[0]?.uris).toEqual([]);
  });
  it("rejects unknown keys, path-like artifact names and bad schema ids", () => {
    expect(() => evidenceManifestSchema.parse({ ...manifest, extra: 1 })).toThrow();
    expect(() => evidenceManifestSchema.parse({ ...manifest, artifacts: [{ ...manifest.artifacts[0], name: "../etc/passwd" }] })).toThrow();
    expect(() => evidenceManifestSchema.parse({ ...manifest, schema: "urn:other" })).toThrow();
  });
});
