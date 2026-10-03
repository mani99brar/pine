import { formatUnits, keccak256, parseUnits, stringToBytes } from 'viem'
import type { Address, DecimalString, Hex } from '@pine/core'

/** Fixed precision used for summing decimal strings (all supported collaterals use 18 decimals). */
const PRECISION = 18

/** Parses a human decimal string into a bigint with 18 decimals. Returns null for invalid input. */
export function toUnits(value: DecimalString | number | undefined | null): bigint | null {
  if (value === undefined || value === null) return null
  const s = typeof value === 'number' ? numberToDecimal(value) : value.trim()
  if (!/^-?\d*\.?\d*$/.test(s) || s === '' || s === '.' || s === '-') return null
  try {
    // parseUnits rounds beyond `decimals`; trim to keep it exact.
    const [int, frac = ''] = s.split('.')
    const trimmed = frac.length > PRECISION ? `${int}.${frac.slice(0, PRECISION)}` : s
    return parseUnits(trimmed, PRECISION)
  } catch {
    return null
  }
}

export function fromUnits(v: bigint): DecimalString {
  return formatUnits(v, PRECISION)
}

export function numberToDecimal(n: number): string {
  if (!Number.isFinite(n)) return '0'
  // Avoid exponent notation for tiny/huge numbers.
  const s = String(n)
  if (!/e/i.test(s)) return s
  return n.toFixed(PRECISION).replace(/\.?0+$/, '')
}

/** Sums decimal strings exactly. Invalid entries count as zero. */
export function sumDecimals(values: (DecimalString | undefined)[]): DecimalString {
  let total = 0n
  for (const v of values) total += toUnits(v) ?? 0n
  return fromUnits(total)
}

export function compareDecimals(a: DecimalString, b: DecimalString): number {
  const x = toUnits(a) ?? 0n
  const y = toUnits(b) ?? 0n
  return x === y ? 0 : x > y ? 1 : -1
}

export function subDecimals(a: DecimalString, b: DecimalString): DecimalString {
  return fromUnits((toUnits(a) ?? 0n) - (toUnits(b) ?? 0n))
}

export function randomId(prefix = ''): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  const raw =
    typeof g.crypto?.randomUUID === 'function'
      ? g.crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
  return `${prefix}${raw.slice(0, 20)}`
}

/** Deterministic pseudo hash for demo transactions and addresses. */
export function fakeHash(...parts: (string | number)[]): Hex {
  return keccak256(stringToBytes(parts.join(':')))
}

export function fakeAddress(...parts: (string | number)[]): Address {
  return `0x${fakeHash(...parts).slice(26)}` as Address
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const anyE = e as { shortMessage?: unknown; message?: unknown; details?: unknown }
    if (typeof anyE.shortMessage === 'string' && anyE.shortMessage) return anyE.shortMessage
    if (typeof anyE.message === 'string' && anyE.message) return anyE.message
  }
  if (typeof e === 'string') return e
  return 'Something went wrong.'
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve()
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    })
  })
}

export function isoNow(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
