/** 302400 → "3.5 days (84 hours)"; 3600 → "1 hour". */
export function formatTimeout(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Not set'
  const hours = seconds / 3600
  if (hours < 24) return `${trim(hours)} hour${hours === 1 ? '' : 's'}`
  const days = hours / 24
  return `${trim(days)} day${days === 1 ? '' : 's'} (${trim(hours)} hours)`
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '')
}

/** Kleros arbitration always runs on Ethereum mainnet and is paid in ETH, whatever chain the market is on. */
export const ARBITRATION_CURRENCY = 'ETH'
export const ARBITRATION_DURATION_NOTE =
  'Kleros arbitration runs on Ethereum mainnet. A first ruling takes about two weeks, plus about 11 days for each appeal round.'

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

/** Seer always adds a third "Invalid result" outcome token. On invalid, only that token redeems. */
export const INVALID_TOKEN_NOTE =
  'Every Seer market has a third outcome token, “Invalid result”. If the question resolves invalid, only that token redeems; Yes and No tokens pay nothing.'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Compact UTC: "Oct 7, 19:00 UTC" (year added when it differs from the current UTC year). */
export function formatCompactUtc(iso: string, withTime = true): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const year = d.getUTCFullYear() !== new Date().getUTCFullYear() ? `, ${d.getUTCFullYear()}` : ''
  const date = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year}`
  if (!withTime) return date
  return `${date}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
}
