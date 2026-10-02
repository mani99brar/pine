import type { DepthLevel, DepthSnapshot } from '@pine/core'

/** Price bands (absolute price distance from mid) used by the depth-bars glyph. */
export const DEPTH_BANDS = [0.01, 0.02, 0.05, 0.1, 0.2] as const

/** Amount of collateral below which a band is considered thin and drawn hollow. */
export const THIN_DEPTH = 50

/** Collateral that would fill the side's levels whose price is within `band` of mid. */
function sideCollateral(levels: DepthLevel[], mid: number, band: number, side: 'bid' | 'ask'): number {
  const relevant = levels
    .filter((l) => l.side === side)
    .sort((a, b) => (side === 'ask' ? a.price - b.price : b.price - a.price))
  let prevSize = 0
  let total = 0
  for (const level of relevant) {
    const distance = Math.abs(level.price - mid)
    if (distance > band + 1e-9) break
    const delta = Math.max(0, level.size - prevSize)
    total += delta * level.price
    prevSize = Math.max(prevSize, level.size)
  }
  return total
}

/** Executable collateral (both sides) within each band of mid. */
export function depthByBand(depth: DepthSnapshot | null | undefined, bands: readonly number[] = DEPTH_BANDS): number[] {
  if (!depth || depth.levels.length === 0) return bands.map(() => 0)
  return bands.map(
    (band) => sideCollateral(depth.levels, depth.mid, band, 'ask') + sideCollateral(depth.levels, depth.mid, band, 'bid'),
  )
}

/** Log-scaled bar height in [0, 1] against a reference amount. */
export function depthHeight(amount: number, reference = 2000): number {
  if (amount <= 0) return 0
  return Math.min(1, Math.log10(1 + amount) / Math.log10(1 + reference))
}

/** Executable collateral within ±5 points, the figure the board sorts "thin depth" by. */
export function depthWithin5(depth: DepthSnapshot | null | undefined): number {
  return depthByBand(depth, [0.05])[0] ?? 0
}

/**
 * Walk the book with `amount` of collateral and return the marginal price after the trade (the new
 * knot position). Buys walk asks upward; sells walk bids downward. Returns the last level reached
 * when the book runs out.
 */
export function priceAfterTrade(depth: DepthSnapshot | null | undefined, side: 'buy' | 'sell', amount: number): number | undefined {
  if (!depth) return undefined
  const levels = depth.levels
    .filter((l) => l.side === (side === 'buy' ? 'ask' : 'bid'))
    .sort((a, b) => (side === 'buy' ? a.price - b.price : b.price - a.price))
  let remaining = amount
  let prevSize = 0
  let price = depth.mid
  for (const l of levels) {
    const delta = Math.max(0, l.size - prevSize)
    const cost = delta * l.price
    price = l.price
    if (cost >= remaining) return l.price
    remaining -= cost
    prevSize = Math.max(prevSize, l.size)
  }
  return price
}
