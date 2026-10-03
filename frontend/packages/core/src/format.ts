/**
 * Display formatting. Deterministic on server and client (no locale/timezone dependence):
 * all dates render in UTC, numbers use "," thousands separators and "." decimals.
 */
import { CHAINS } from './chains'
import { fromScaled, parseDecimalParts, roundScaled, toScaled } from './decimal'
import type { Address, DecimalString, Hex, IsoDate } from './types'

const PLACEHOLDER = '—'

function groupThousands(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Format a token amount. Accepts decimal strings ("12.5", "1e-7") or numbers.
 * - `maxDecimals` (default 4; 2 in compact mode below 1000) rounds half away from zero, trailing zeros trimmed.
 * - Non-zero values that round to zero render as "<0.0001".
 * - `compact` renders 1.2K / 3.4M / 5.6B / 7.8T.
 * - Unparseable input renders "—".
 */
export function formatAmount(
  v: DecimalString | number,
  opts: { symbol?: string; maxDecimals?: number; compact?: boolean } = {},
): string {
  const suffix = opts.symbol ? ` ${opts.symbol}` : ''
  const parts = parseDecimalParts(v)
  if (!parts) return PLACEHOLDER
  const SCALE = 36
  const scaled = toScaled(v, SCALE)
  if (!scaled) return PLACEHOLDER
  const negative = scaled.value < 0n
  const abs = negative ? -scaled.value : scaled.value

  if (opts.compact) {
    const units: [bigint, string][] = [
      [10n ** 12n, 'T'],
      [10n ** 9n, 'B'],
      [10n ** 6n, 'M'],
      [10n ** 3n, 'K'],
    ]
    for (const [threshold, label] of units) {
      const t = threshold * 10n ** BigInt(SCALE)
      if (abs >= t) {
        const keep = opts.maxDecimals ?? 1
        // value / threshold at SCALE, rounded to `keep` decimals
        const ratio = (abs * 10n ** BigInt(SCALE)) / t
        const rounded = roundScaled(ratio, SCALE, keep)
        const s = fromScaled(rounded, SCALE)
        return `${negative ? '-' : ''}${s}${label}${suffix}`
      }
    }
  }

  const maxDecimals = Math.max(0, Math.min(18, opts.maxDecimals ?? (opts.compact ? 2 : 4)))
  const rounded = roundScaled(abs, SCALE, maxDecimals)
  if (rounded === 0n && abs !== 0n) {
    const tiny = maxDecimals === 0 ? '1' : `0.${'0'.repeat(maxDecimals - 1)}1`
    return `${negative ? '>-' : '<'}${tiny}${suffix}`
  }
  const plain = fromScaled(rounded, SCALE)
  const [int = '0', frac] = plain.split('.')
  const body = frac ? `${groupThousands(int)}.${frac}` : groupThousands(int)
  return `${negative && rounded !== 0n ? '-' : ''}${body}${suffix}`
}

/** Price-as-chance: 0.153 → "15.3%", 0.15 → "15%", tiny → "<0.1%", near-one → ">99.9%". */
export function formatPrice(p: number): string {
  if (typeof p !== 'number' || !Number.isFinite(p)) return PLACEHOLDER
  const clamped = Math.min(1, Math.max(0, p))
  if (clamped > 0 && clamped < 0.0005) return '<0.1%'
  if (clamped < 1 && clamped > 0.9995) return '>99.9%'
  const tenths = Math.round(clamped * 1000)
  const int = Math.floor(tenths / 10)
  const dec = tenths % 10
  return dec === 0 ? `${int}%` : `${int}.${dec}%`
}

/** Price in collateral per outcome token: 0.153 → "0.153" (3 decimals). */
export function formatPriceCents(p: number): string {
  if (typeof p !== 'number' || !Number.isFinite(p)) return PLACEHOLDER
  return Math.min(1, Math.max(0, p)).toFixed(3)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function parseIso(iso: IsoDate | Date | number): Date | null {
  const d = iso instanceof Date ? iso : new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "YYYY-MM-DD HH:mm UTC" — the format used inside question text. */
export function formatUtcMinute(iso: IsoDate | Date): string {
  const d = parseIso(iso)
  if (!d) return PLACEHOLDER
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`
}

/**
 * Dates always render in UTC so server and client agree and deadlines are unambiguous.
 * - short: "Oct 10, 2026"
 * - long:  "Oct 10, 2026, 18:00 UTC"
 * - utc:   "2026-10-10 18:00 UTC"
 */
export function formatDate(iso: IsoDate, style: 'short' | 'long' | 'utc' = 'short'): string {
  const d = parseIso(iso)
  if (!d) return PLACEHOLDER
  if (style === 'utc') return formatUtcMinute(d)
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
  if (style === 'short') return base
  return `${base}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`
}

/** Compact duration: "2d 4h", "4h 12m", "12m", "<1m". */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (abs < minute) return '<1m'
  const d = Math.floor(abs / day)
  const h = Math.floor((abs % day) / hour)
  const m = Math.floor((abs % hour) / minute)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

/** "in 2d 4h", "3h 5m ago", "just now". */
export function formatRelative(iso: IsoDate, now: Date = new Date()): string {
  const d = parseIso(iso)
  if (!d) return PLACEHOLDER
  const diff = d.getTime() - now.getTime()
  if (Math.abs(diff) < 60_000) return 'just now'
  const label = formatDuration(diff)
  return diff > 0 ? `in ${label}` : `${label} ago`
}

/** 0x1234…abcd (chars = hex chars kept on each side, default 4). */
export function shortHash(h: string, chars = 4): string {
  if (!h) return ''
  const hasPrefix = h.startsWith('0x') || h.startsWith('0X')
  const body = hasPrefix ? h.slice(2) : h
  if (body.length <= chars * 2 + 1) return h
  return `${hasPrefix ? '0x' : ''}${body.slice(0, chars)}…${body.slice(-chars)}`
}

/** First 7 characters of a commit SHA, lowercased. */
export function shortSha(sha: string): string {
  return (sha ?? '').trim().toLowerCase().slice(0, 7)
}

/** 42 → "PINE-0042" (pads to 4 digits; larger numbers are not truncated). */
export function formatClaimNumber(n: number): string {
  const safeN = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
  return `PINE-${String(safeN).padStart(4, '0')}`
}

function explorerBase(chainId: number): string {
  return CHAINS[chainId]?.explorer ?? 'https://blockscan.com'
}

export function explorerTxUrl(chainId: number, hash: Hex): string {
  return `${explorerBase(chainId)}/tx/${hash}`
}

export function explorerAddressUrl(chainId: number, address: Address): string {
  return `${explorerBase(chainId)}/address/${address}`
}
