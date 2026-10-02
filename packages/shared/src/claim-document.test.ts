import { describe, expect, it } from "vitest";
import { ClaimDocumentError, encodeClaimDocument, parseClaimDocumentBytes } from "./claim-document.js";
import { exampleClaimDocument } from "./testing/fixtures.js";

const encoder = new TextEncoder();

describe("claim document", () => {
  it("round-trips canonical bytes and digest", () => {
    const { bytes, sha256 } = encodeClaimDocument(exampleClaimDocument());
    expect(parseClaimDocumentBytes(bytes, sha256)).toEqual(exampleClaimDocument());
  });
  it("rejects a digest mismatch", () => {
    const { bytes } = encodeClaimDocument(exampleClaimDocument());
    expect(() => parseClaimDocumentBytes(bytes, `0x${"00".repeat(32)}`)).toThrow(/digest/);
  });
  it("SEC-CLAIM-01 rejects non-canonical bytes, duplicate keys and unknown fields", () => {
    const { bytes } = encodeClaimDocument(exampleClaimDocument());
    const text = new TextDecoder().decode(bytes);
    expect(() => parseClaimDocumentBytes(encoder.encode(` ${text}`))).toThrow(ClaimDocumentError);
    expect(() => parseClaimDocumentBytes(encoder.encode(text.replace('{"claim":', '{"claim":{},"claim":')))).toThrow(ClaimDocumentError);
    expect(() => parseClaimDocumentBytes(encoder.encode(text.replace('"creator":', '"extra":1,"creator":')))).toThrow(ClaimDocumentError);
    expect(() => parseClaimDocumentBytes(encoder.encode(text.replace("0x00000000000000000000000000000000000a11ce", "0x00000000000000000000000000000000000A11CE")))).toThrow(ClaimDocumentError);
  });
  it("SEC-CLAIM-02 rejects bidi, zero-width, separator and non-NFC text", () => {
    const base = exampleClaimDocument();
    for (const requirement of ["abc\u202edef", "a\u200bb", "x\u241fy", "Cafe\u0301", "nul\u0000"]) {
      expect(() => encodeClaimDocument({ ...base, claim: { ...base.claim, requirement } })).toThrow(ClaimDocumentError);
    }
    expect(() => encodeClaimDocument({ ...base, claim: { ...base.claim, title: "quote\"title" } })).toThrow(ClaimDocumentError);
  });
  it("enforces cross-field rules", () => {
    const base = exampleClaimDocument();
    expect(() => encodeClaimDocument({ ...base, evidence: { ...base.evidence, revealDeadline: base.evidence.evidenceDeadline } })).toThrow(/revealDeadline/);
    expect(() => encodeClaimDocument({ ...base, market: { ...base.market, openingTime: base.market.openingTime + 1 } })).toThrow(/openingTime/);
    expect(() => encodeClaimDocument({ ...base, claim: { ...base.claim, regressionOnly: true } })).toThrow(/base commit/);
  });
  it("rejects invalid UTF-8 and oversized input", () => {
    expect(() => parseClaimDocumentBytes(new Uint8Array([0xff, 0xfe, 0x7b]))).toThrow(/UTF-8/);
    expect(() => parseClaimDocumentBytes(new Uint8Array(256 * 1024 + 1))).toThrow(/256 KiB/);
  });
});
