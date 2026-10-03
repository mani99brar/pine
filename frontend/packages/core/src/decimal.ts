/**
 * Exact decimal helpers on bigint. Money is never summed as floats.
 *
 * `parseDecimal` accepts plain decimals ("12.5", "-0.1", ".5", "5.") and scientific notation
 * ("1e-7", "2.5E3"), and returns `null` for anything else (empty, "abc", "1,000", NaN, Infinity).
 */
import type { DecimalString } from './types'

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/

export interface ParsedDecimal {
  negative: boolean
  /** integer digits without sign, no leading zeros (or "0") */
  digits: string
  /** decimal exponent: value = digits × 10^exponent */
  exponent: number
}

export function parseDecimalParts(input: string | number): ParsedDecimal | null {
  let s: string
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null
    s = String(input)
  } else if (typeof input === 'string') {
    s = input.trim()
  } else {
    return null
  }
  if (s === '') return null
  const m = DECIMAL_RE.exec(s)
  if (!m) return null
  const intPart = m[2] ?? ''
  const fracPart = m[3] ?? ''
  if (intPart === '' && fracPart === '') return null
  const exp = m[4] ? Number.parseInt(m[4], 10) : 0
  if (!Number.isFinite(exp) || Math.abs(exp) > 400) return null
  let digits = (intPart + fracPart).replace(/^0+/, '')
  if (digits === '') digits = '0'
  return { negative: m[1] === '-' && digits !== '0', digits, exponent: exp - fracPart.length }
}

/** True when `input` is a finite decimal (plain or scientific notation). */
export function isDecimal(input: unknown): boolean {
  return (typeof input === 'string' || typeof input === 'number') && parseDecimalParts(input) !== null
}

/**
 * Parse to a bigint scaled by 10^decimals. Rounds half away from zero when the input has more
 * precision than `decimals` (and reports it via `exact: false`). Returns null when unparseable.
 */
export function toScaled(input: string | number, decimals: number): { value: bigint; exact: boolean } | null {
  const p = parseDecimalParts(input)
  if (!p) return null
  const shift = p.exponent + decimals
  let value: bigint
  let exact = true
  if (shift >= 0) {
    value = BigInt(p.digits) * 10n ** BigInt(shift)
  } else {
    const divisor = 10n ** BigInt(-shift)
    const n = BigInt(p.digits)
    value = n / divisor
    const rem = n % divisor
    if (rem !== 0n) {
      exact = false
      if (rem * 2n >= divisor) value += 1n
    }
  }
  return { value: p.negative ? -value : value, exact }
}

/** Format a scaled bigint back to a plain decimal string with trailing zeros trimmed ("12.5", "0", "-0.001"). */
export function fromScaled(value: bigint, decimals: number): DecimalString {
  const negative = value < 0n
  const abs = negative ? -value : value
  const base = 10n ** BigInt(decimals)
  const int = abs / base
  let frac = decimals > 0 ? (abs % base).toString().padStart(decimals, '0') : ''
  frac = frac.replace(/0+$/, '')
  const s = frac ? `${int}.${frac}` : `${int}`
  return negative && abs !== 0n ? `-${s}` : s
}

/** Normalize any accepted decimal input to a plain decimal string (no exponent), or null. Precision is kept up to 36 places. */
export function normalizeDecimal(input: string | number, maxDecimals = 36): DecimalString | null {
  const r = toScaled(input, maxDecimals)
  return r ? fromScaled(r.value, maxDecimals) : null
}

/** Round a scaled value to `keep` decimals (half away from zero), staying at the original scale. */
export function roundScaled(value: bigint, decimals: number, keep: number): bigint {
  if (keep >= decimals) return value
  const unit = 10n ** BigInt(decimals - keep)
  const negative = value < 0n
  const abs = negative ? -value : value
  let q = abs / unit
  if ((abs % unit) * 2n >= unit) q += 1n
  const r = q * unit
  return negative ? -r : r
}

/** Exact sum of decimal strings at a given scale. Unparseable entries count as 0. */
export function sumDecimals(values: (string | number)[], decimals = 18): DecimalString {
  let total = 0n
  for (const v of values) total += toScaled(v, decimals)?.value ?? 0n
  return fromScaled(total, decimals)
}

/** Compare two decimals: -1, 0, 1. Unparseable values compare as 0. */
export function compareDecimals(a: string | number, b: string | number, decimals = 36): -1 | 0 | 1 {
  const x = toScaled(a, decimals)?.value ?? 0n
  const y = toScaled(b, decimals)?.value ?? 0n
  return x < y ? -1 : x > y ? 1 : 0
}
