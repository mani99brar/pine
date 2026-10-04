// Browser-safe twin of packages/shared/src/canonical.ts (the original uses node:crypto, Buffer, canonicalize and
// multiformats). Same exports and semantics: RFC 8785 canonical JSON, SHA-256 content identity and the raw-codec
// CIDv1 locator. packages/core/test/pine-shared.test.ts checks every function against the original on shared vectors.

import { sha256 } from 'viem'
import { canonicalJson as jcs } from '../hash'
import type { Hex32 } from './types'

/** Values allowed in canonical documents: no undefined, functions, symbols, bigint, NaN or Infinity. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** RFC 8785 canonical JSON text. Throws on values JSON cannot represent exactly. */
export function canonicalJson(value: JsonValue): string {
  assertJson(value, '$')
  return jcs(value)
}

export function canonicalBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}

export function sha256Hex(bytes: Uint8Array): Hex32 {
  return sha256(bytes, 'hex').toLowerCase() as Hex32
}

const RAW_CODEC = 0x55
const SHA2_256_CODE = 0x12
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lowercase, no padding (multibase prefix "b" is added by the caller). */
function base32(bytes: Uint8Array): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31]
  return out
}

function fromBase32(text: string): Uint8Array | null {
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of text) {
    const value = BASE32.indexOf(char)
    if (value < 0) return null
    buffer = (buffer << 5) | value
    bits += 5
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function cidFromDigest(digest: Uint8Array): string {
  // CIDv1 = varint(1) varint(0x55 raw) multihash(varint(0x12 sha2-256) varint(32) digest); all four varints are 1 byte.
  const bytes = new Uint8Array(4 + digest.length)
  bytes.set([0x01, RAW_CODEC, SHA2_256_CODE, digest.length], 0)
  bytes.set(digest, 4)
  return `b${base32(bytes)}`
}

/** CIDv1, raw codec, sha2-256, base32 lowercase ("bafkrei..."). */
export function rawCidFromBytes(bytes: Uint8Array): string {
  return cidFromDigest(hexToBytes(sha256Hex(bytes)))
}

/** Recomputes the raw CID for a SHA-256 digest (both identify the same bytes). */
export function rawCidFromSha256(sha256Digest: Hex32): string {
  const digest = hexToBytes(sha256Digest)
  if (!/^0x[0-9a-fA-F]{64}$/.test(sha256Digest) || digest.length !== 32) throw new Error('sha256 must be 32 bytes')
  return cidFromDigest(digest)
}

/** Extracts the SHA-256 digest from a raw-codec sha2-256 CIDv1 (base32 multibase); null for any other CID shape. */
export function sha256FromRawCid(cidText: string): Hex32 | null {
  if (!cidText.startsWith('b')) return null
  const bytes = fromBase32(cidText.slice(1))
  if (!bytes || bytes.length !== 36) return null
  if (bytes[0] !== 0x01 || bytes[1] !== RAW_CODEC || bytes[2] !== SHA2_256_CODE || bytes[3] !== 32) return null
  if (cidFromDigest(bytes.slice(4)) !== cidText) return null
  return `0x${bytesToHex(bytes.slice(4))}` as Hex32
}

/**
 * Largest content Pine stores: one raw IPFS block of the default chunk size, so the raw CID computed here equals what
 * `ipfs add --cid-version=1 --raw-leaves` (and pinning services) return for the same bytes.
 */
export const RAW_CID_MAX_BYTES = 262_144

export interface ContentIdentity {
  sha256: Hex32
  /** Raw-codec CIDv1 for content of at most RAW_CID_MAX_BYTES, otherwise null (sha256 is the only identity). */
  cid: string | null
  size: number
}

export function identify(bytes: Uint8Array): ContentIdentity {
  return { sha256: sha256Hex(bytes), cid: bytes.byteLength <= RAW_CID_MAX_BYTES ? rawCidFromBytes(bytes) : null, size: bytes.byteLength }
}

function assertJson(value: unknown, at: string): void {
  if (value === null) return
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`Non-finite number at ${at}`)
      return
    case 'object':
      if (Array.isArray(value)) {
        value.forEach((item, index) => assertJson(item, `${at}[${index}]`))
        return
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new Error(`Non-plain object at ${at}`)
      }
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (item === undefined) throw new Error(`Undefined value at ${at}.${key}`)
        assertJson(item, `${at}.${key}`)
      }
      return
    default:
      throw new Error(`Unsupported ${typeof value} at ${at}`)
  }
}
