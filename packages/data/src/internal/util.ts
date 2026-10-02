import { formatUnits, getAddress, keccak256, parseUnits, stringToBytes } from 'viem'
import type { Address, DecimalString, Hex, Page } from '@pine/core'

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** mulberry32 — tiny deterministic PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic 32-byte hex derived from a label. */
export function fakeHash(label: string): Hex {
  return keccak256(stringToBytes(`pine-fixture:${label}`))
}

/** Deterministic checksummed address derived from a label. */
export function fakeAddress(label: string): Address {
  return getAddress(`0x${fakeHash(label).slice(-40)}`)
}

/** Deterministic 40-hex git SHA derived from a label. */
export function fakeSha(label: string): string {
  return fakeHash(`sha:${label}`).slice(2, 42)
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32 (lowercase, no padding) — used to fake CIDv1 strings. */
export function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

function hexToBytes(hex: Hex): Uint8Array {
  const clean = hex.slice(2)
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Deterministic CIDv1-looking identifier ("bafkrei…", 59 chars) derived from a 32-byte hash.
 * It is NOT a real IPFS CID of the content (IPFS uses sha2-256); mock storage only.
 */
export function fakeCid(hash: Hex): string {
  // CIDv1 raw sha2-256 multihash prefix bytes: 0x01 0x55 0x12 0x20 → base32 "afkrei" after the "b" multibase.
  const bytes = new Uint8Array(36)
  bytes.set([0x01, 0x55, 0x12, 0x20], 0)
  bytes.set(hexToBytes(hash), 4)
  return `b${base32(bytes)}`
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const HOUR = 3_600_000

/** `ms` rounded down to the hour. */
export function hourFloor(ms: number): number {
  return Math.floor(ms / HOUR) * HOUR
}

/**
 * Fixture anchor: "now" rounded down to the hour. Fixtures are (re)built per anchor hour (see
 * `getFixtures`), so server and browser agree within the same hour and the demo never goes stale.
 * `withAnchor` sets it while a fixture build runs; `hoursFromNow` reads it.
 */
let anchorMs = hourFloor(Date.now())

export function getAnchor(): number {
  return anchorMs
}

export function withAnchor<T>(anchor: number, fn: () => T): T {
  const prev = anchorMs
  anchorMs = anchor
  try {
    return fn()
  } finally {
    anchorMs = prev
  }
}

/** ISO timestamp `h` hours from the anchor (negative = past). Fractions allowed. */
export function hoursFromNow(h: number): string {
  return new Date(anchorMs + Math.round(h * HOUR)).toISOString().replace('.000Z', 'Z')
}

export function daysFromNow(d: number): string {
  return hoursFromNow(d * 24)
}

export function isoToMs(iso: string): number {
  return Date.parse(iso)
}

// ---------------------------------------------------------------------------
// Money (bigint; never float addition)
// ---------------------------------------------------------------------------

export const COLLATERAL_DECIMALS = 18

export function toUnits(v: DecimalString | number, decimals = COLLATERAL_DECIMALS): bigint {
  const s = typeof v === 'number' ? v.toFixed(Math.min(decimals, 12)) : v.trim()
  if (s === '' || s === '-') return 0n
  try {
    return parseUnits(s, decimals)
  } catch {
    return 0n
  }
}

/** Exact decimal string, trimmed to at most `maxDecimals` (rounded down toward zero). */
export function fromUnits(v: bigint, decimals = COLLATERAL_DECIMALS, maxDecimals = 6): DecimalString {
  const s = formatUnits(v, decimals)
  const [int, frac = ''] = s.split('.')
  const f = frac.slice(0, maxDecimals).replace(/0+$/, '')
  const out = f ? `${int}.${f}` : `${int}`
  return out === '-0' ? '0' : out
}

export function sumDecimal(values: (DecimalString | undefined)[], maxDecimals = 6): DecimalString {
  let total = 0n
  for (const v of values) if (v) total += toUnits(v)
  return fromUnits(total, COLLATERAL_DECIMALS, maxDecimals)
}

/** Multiply a decimal amount by a float factor (e.g. a price) using a 1e9 fixed-point factor. */
export function mulDecimal(v: DecimalString, factor: number, maxDecimals = 6): DecimalString {
  const f = BigInt(Math.round(factor * 1e9))
  return fromUnits((toUnits(v) * f) / 1_000_000_000n, COLLATERAL_DECIMALS, maxDecimals)
}

export function compareDecimal(a: DecimalString | undefined, b: DecimalString | undefined): number {
  const x = toUnits(a ?? '0')
  const y = toUnits(b ?? '0')
  return x < y ? -1 : x > y ? 1 : 0
}

/** Round a float price to `d` decimals. */
export function round(n: number, d = 4): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

// ---------------------------------------------------------------------------
// Pagination (cursor = offset string)
// ---------------------------------------------------------------------------

export function paginate<T>(items: T[], cursor?: string, limit = 20, maxLimit = 100): Page<T> {
  const offset = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0)
  const size = Math.min(Math.max(1, Math.floor(limit) || 20), maxLimit)
  const slice = items.slice(offset, offset + size)
  const next = offset + size
  return { items: slice, nextCursor: next < items.length ? String(next) : undefined, total: items.length }
}

// ---------------------------------------------------------------------------
// Safe browser storage (isomorphic)
// ---------------------------------------------------------------------------

export function hasLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined' && window.localStorage !== null
  } catch {
    return false
  }
}

export function readStorage<T>(key: string): T | undefined {
  if (!hasLocalStorage()) return undefined
  try {
    const raw = window.localStorage.getItem(key)
    return raw == null ? undefined : (JSON.parse(raw) as T)
  } catch {
    return undefined
  }
}

/** Returns false when the value could not be stored (no storage, quota exceeded, privacy mode). */
export function writeStorage(key: string, value: unknown): boolean {
  if (!hasLocalStorage()) return false
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function removeStorage(key: string): void {
  if (!hasLocalStorage()) return
  try {
    window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function lower(s: string | undefined | null): string {
  return (s ?? '').toLowerCase()
}

export function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

export function clone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T)
}
