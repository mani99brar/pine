// FROZEN canonical encoding and content identity.
//
// Canonical JSON is RFC 8785 (JCS) over UTF-8. A document's identity is the SHA-256 of its canonical bytes
// ("contentSha256"); its IPFS locator is the CIDv1 (raw codec 0x55, sha2-256 multihash) of the same bytes, which is
// what `ipfs add --cid-version=1 --raw-leaves` produces for a single-block file (< 256 KiB) and what pinning
// services accept for raw blocks. On-chain registries store the 32-byte SHA-256 digest; the CID is only a locator
// and readers must verify the digest of whatever bytes they fetch.

import { createHash } from "node:crypto";
import canonicalizeImport from "canonicalize";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { create as createDigest } from "multiformats/hashes/digest";
import type { Hex32 } from "./types.js";

const SHA2_256_CODE = 0x12;

type Canonicalize = (input: unknown) => string | undefined;
const canonicalizeFn = canonicalizeImport as unknown as Canonicalize;

/** Values allowed in canonical documents: no undefined, functions, symbols, bigint, NaN or Infinity. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** RFC 8785 canonical JSON text. Throws on values JSON cannot represent exactly. */
export function canonicalJson(value: JsonValue): string {
  assertJson(value, "$");
  const text = canonicalizeFn(value);
  if (typeof text !== "string") throw new Error("Value cannot be canonicalized");
  return text;
}

export function canonicalBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function sha256Hex(bytes: Uint8Array): Hex32 {
  return `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex32;
}

/** CIDv1, raw codec, sha2-256, base32 lowercase ("bafkrei..."). */
export function rawCidFromBytes(bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest();
  return CID.createV1(raw.code, createDigest(SHA2_256_CODE, new Uint8Array(digest))).toString();
}

/** Recomputes the raw CID for a SHA-256 digest (both identify the same bytes). */
export function rawCidFromSha256(sha256: Hex32): string {
  const digest = Buffer.from(sha256.slice(2), "hex");
  if (digest.length !== 32) throw new Error("sha256 must be 32 bytes");
  return CID.createV1(raw.code, createDigest(SHA2_256_CODE, new Uint8Array(digest))).toString();
}

/** Extracts the SHA-256 digest from a raw-codec sha2-256 CIDv1; null for any other CID shape. */
export function sha256FromRawCid(cidText: string): Hex32 | null {
  let cid: CID;
  try {
    cid = CID.parse(cidText);
  } catch {
    return null;
  }
  if (cid.version !== 1 || cid.code !== raw.code || cid.multihash.code !== SHA2_256_CODE || cid.multihash.digest.length !== 32) {
    return null;
  }
  return `0x${Buffer.from(cid.multihash.digest).toString("hex")}` as Hex32;
}

/** Largest content addressed by a raw-codec CID: one IPFS block (larger raw blocks do not transfer over Bitswap). */
export const RAW_CID_MAX_BYTES = 1024 * 1024;

export interface ContentIdentity {
  sha256: Hex32;
  /** Raw-codec CIDv1 for content of at most RAW_CID_MAX_BYTES, otherwise null (sha256 is the only identity). */
  cid: string | null;
  size: number;
}

export function identify(bytes: Uint8Array): ContentIdentity {
  return { sha256: sha256Hex(bytes), cid: bytes.byteLength <= RAW_CID_MAX_BYTES ? rawCidFromBytes(bytes) : null, size: bytes.byteLength };
}

function assertJson(value: unknown, at: string): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new Error(`Non-finite number at ${at}`);
      return;
    case "object":
      if (Array.isArray(value)) {
        value.forEach((item, index) => assertJson(item, `${at}[${index}]`));
        return;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new Error(`Non-plain object at ${at}`);
      }
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (item === undefined) throw new Error(`Undefined value at ${at}.${key}`);
        assertJson(item, `${at}.${key}`);
      }
      return;
    default:
      throw new Error(`Unsupported ${typeof value} at ${at}`);
  }
}
