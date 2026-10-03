/**
 * Deterministic crystal geometry. Every claim's crystal is generated from its own hashes, so the same
 * claim always produces the same gem, and two claims never look alike.
 *
 * 2D: a double-terminated quartz point drawn front-on in a 100×160 box with nine facets.
 * 3D: a point cloud for three's ConvexGeometry (elongated hexagonal prism with terminations).
 */
import type { ClaimStatus, Outcome, PolicyFamilyId } from '@pine/core'

export type Pt = [number, number]

/** The nine facets, one per pinned input. */
export type FacetId = 'commit' | 'policy' | 'question' | 'environment' | 'deadline' | 'oracle' | 'funding' | 'manifest' | 'market'

export const FACET_ORDER: FacetId[] = ['commit', 'policy', 'question', 'environment', 'deadline', 'oracle', 'funding', 'manifest', 'market']

export const FACET_LABEL: Record<FacetId, string> = {
  commit: 'Commit',
  policy: 'Policy',
  question: 'Question',
  environment: 'Environment',
  deadline: 'Evidence deadline',
  oracle: 'Oracle',
  funding: 'Funding',
  manifest: 'Manifest',
  market: 'Market',
}

export type CrystalState = 'luminous' | 'settling' | 'partial' | 'dim' | 'frosted' | 'fractured' | 'unlit'

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/** xmur3 string hash → 32-bit seed. */
export function seedFrom(input: string): number {
  let h = 1779033703 ^ input.length
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

/** mulberry32 PRNG in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Bytes of a 0x-hex hash or SHA when possible; otherwise bytes drawn from a seeded PRNG. */
export function bytesOf(input: string, count = 32): number[] {
  const hex = input.replace(/^0x/i, '')
  if (/^[0-9a-f]+$/i.test(hex) && hex.length >= 8) {
    const out: number[] = []
    for (let i = 0; i < count; i++) {
      const j = (i * 2) % (hex.length - 1)
      out.push(parseInt(hex.slice(j, j + 2), 16))
    }
    return out
  }
  const r = prng(seedFrom(input))
  return Array.from({ length: count }, () => Math.floor(r() * 256))
}

// ---------------------------------------------------------------------------
// 2D crystal
// ---------------------------------------------------------------------------

export interface Facet {
  id: FacetId
  points: Pt[]
  centroid: Pt
  /** Base lightness 0..1 from the light direction (upper left). */
  light: number
}

export interface CrystalShape {
  outline: Pt[]
  facets: Facet[]
  apexTop: Pt
  apexBottom: Pt
  /** Front vertical edges (highlight lines). */
  edges: [Pt, Pt][]
  bounds: { left: number; right: number; top: number; bottom: number }
}

const centroid = (pts: Pt[]): Pt => {
  const x = pts.reduce((s, p) => s + p[0], 0) / pts.length
  const y = pts.reduce((s, p) => s + p[1], 0) / pts.length
  return [x, y]
}

const round = (n: number) => Math.round(n * 100) / 100

/** Front-on, double-terminated quartz point in a 100×160 box. */
export function crystalShape(seed: string): CrystalShape {
  const r = prng(seedFrom(`shape:${seed}`))
  const cx = 50
  const halfW = 22 + r() * 7
  const L = round(cx - halfW)
  const R = round(cx + halfW)
  const l = round(cx - halfW * (0.36 + r() * 0.16))
  const rr = round(cx + halfW * (0.36 + r() * 0.16))
  const lean = (r() - 0.5) * 7
  const shL = round(48 + r() * 12)
  const shl = round(40 + r() * 10)
  const shr = round(40 + r() * 10)
  const shR = round(48 + r() * 12)
  const apexTop: Pt = [round(cx + lean), round(5 + r() * 9)]
  const bL = round(110 + r() * 10)
  const bl = round(117 + r() * 10)
  const br = round(117 + r() * 10)
  const bR = round(110 + r() * 10)
  const apexBottom: Pt = [round(cx - lean * 0.6), round(149 + r() * 7)]

  const P = {
    tL: [L, shL] as Pt,
    tl: [l, shl] as Pt,
    tr: [rr, shr] as Pt,
    tR: [R, shR] as Pt,
    bL: [L, bL] as Pt,
    bl: [l, bl] as Pt,
    br: [rr, br] as Pt,
    bR: [R, bR] as Pt,
  }

  const make = (id: FacetId, points: Pt[], light: number): Facet => ({ id, points, centroid: centroid(points), light })
  const facets: Facet[] = [
    make('commit', [P.tl, P.tr, P.br, P.bl], 0.62),
    make('policy', [P.tL, P.tl, P.bl, P.bL], 0.78),
    make('question', [P.tr, P.tR, P.bR, P.br], 0.4),
    make('environment', [P.tL, apexTop, P.tl], 0.95),
    make('deadline', [P.tl, apexTop, P.tr], 0.85),
    make('oracle', [P.tr, apexTop, P.tR], 0.55),
    make('funding', [P.bL, P.bl, apexBottom], 0.5),
    make('manifest', [P.bl, P.br, apexBottom], 0.36),
    make('market', [P.br, P.bR, apexBottom], 0.24),
  ]

  return {
    outline: [P.tL, apexTop, P.tR, P.bR, apexBottom, P.bL],
    facets,
    apexTop,
    apexBottom,
    edges: [
      [P.tl, P.bl],
      [P.tr, P.br],
    ],
    bounds: { left: L, right: R, top: apexTop[1], bottom: apexBottom[1] },
  }
}

export interface FacetShade {
  /** Gradient angle in degrees */
  angle: number
  /** Opacity at the bright end and the dark end */
  hi: number
  lo: number
}

/** Per-facet shading from the bytes of that facet's input (its hash, SHA or value). */
export function facetShade(facet: Facet, input: string | undefined): FacetShade {
  const b = bytesOf(input ?? facet.id, 4)
  const jitter = (b[0] / 255 - 0.5) * 0.28
  const hi = Math.min(0.98, Math.max(0.3, facet.light + jitter))
  return {
    angle: Math.round(((b[1] / 255) * 120 - 60 + 135) % 360),
    hi,
    lo: Math.max(0.06, hi * (0.18 + (b[2] / 255) * 0.22)),
  }
}

export interface Crack {
  path: Pt[]
  /** Clip polygons for the two halves (upper, lower). */
  upper: Pt[]
  lower: Pt[]
}

/** Seeded fracture across the body of the crystal. */
export function crystalCrack(shape: CrystalShape, seed: string): Crack {
  const r = prng(seedFrom(`crack:${seed}`))
  const { left, right } = shape.bounds
  const leftTop = shape.facets.find((f) => f.id === 'policy')!.points
  const rightTop = shape.facets.find((f) => f.id === 'question')!.points
  const y0 = leftTop[0][1] + (leftTop[3][1] - leftTop[0][1]) * (0.2 + r() * 0.55)
  const y1 = rightTop[1][1] + (rightTop[2][1] - rightTop[1][1]) * (0.2 + r() * 0.55)
  const steps = 6
  const path: Pt[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = left - 1 + (right - left + 2) * t
    const base = y0 + (y1 - y0) * t
    const jag = i === 0 || i === steps ? 0 : (r() - 0.5) * 16
    path.push([round(x), round(base + jag)])
  }
  const reversed = [...path].reverse()
  const upper: Pt[] = [[-10, -10], [110, -10], [110, path[steps][1]], ...reversed, [-10, path[0][1]]]
  const lower: Pt[] = [[-10, 170], [110, 170], [110, path[steps][1]], ...reversed, [-10, path[0][1]]]
  return { path, upper, lower }
}

export const pointsAttr = (pts: Pt[]) => pts.map((p) => `${p[0]},${p[1]}`).join(' ')

// ---------------------------------------------------------------------------
// 3D crystal (ConvexGeometry input)
// ---------------------------------------------------------------------------

/** Points for three's ConvexGeometry: an elongated hexagonal prism with seeded terminations. */
export function crystalPoints3D(seed: string): [number, number, number][] {
  const r = prng(seedFrom(`3d:${seed}`))
  const radius = 0.52 + r() * 0.1
  const yTop = 0.5 + r() * 0.22
  const yBottom = -(0.55 + r() * 0.22)
  const leanX = (r() - 0.5) * 0.18
  const leanZ = (r() - 0.5) * 0.18
  const pts: [number, number, number][] = []
  for (let k = 0; k < 6; k++) {
    const a = ((k * 60 + (r() - 0.5) * 14) * Math.PI) / 180
    const rk = radius * (0.86 + r() * 0.28)
    pts.push([Math.cos(a) * rk, yTop + (r() - 0.5) * 0.22, Math.sin(a) * rk])
    const rb = rk * (0.92 + r() * 0.12)
    pts.push([Math.cos(a) * rb, yBottom + (r() - 0.5) * 0.2, Math.sin(a) * rb])
    const am = (((k * 60 + 30) + (r() - 0.5) * 10) * Math.PI) / 180
    const rm = radius * (0.84 + r() * 0.1)
    pts.push([Math.cos(am) * rm, (r() - 0.5) * 0.5, Math.sin(am) * rm])
  }
  pts.push([leanX, 1.2 + r() * 0.35, leanZ])
  pts.push([leanX + (r() - 0.5) * 0.12, 1.02 + r() * 0.2, leanZ + 0.14])
  pts.push([-leanX * 0.6, -(1.0 + r() * 0.3), -leanZ * 0.6])
  return pts
}

// ---------------------------------------------------------------------------
// Claim → crystal mapping
// ---------------------------------------------------------------------------

export const FAMILY_HEX: Record<PolicyFamilyId, string> = { FUNC: '#5AD8FF', BOT: '#FFB648', SC: '#B79AFF' }
export const FAMILY_VAR: Record<PolicyFamilyId, string> = { FUNC: 'var(--hb)', BOT: 'var(--na)', SC: 'var(--ca)' }
export const FAMILY_NAME: Record<PolicyFamilyId, string> = {
  FUNC: 'Functional correctness',
  BOT: 'Automation and keepers',
  SC: 'Smart-contract invariants',
}

export const OUTCOME_HEX = { yes: '#FF6B83', no: '#A9B4C1', invalid: '#DCD6E8' } as const

export function crystalStateFor(status: ClaimStatus, outcome?: Outcome): CrystalState {
  if (status === 'resolved' || status === 'settled') {
    if (outcome === 'yes') return 'fractured'
    if (outcome === 'invalid') return 'frosted'
    return 'dim'
  }
  if (status === 'open') return 'luminous'
  if (status === 'publishing' || status === 'draft') return 'partial'
  if (status === 'failed') return 'unlit'
  return 'settling'
}

/** Facets cut for a publishing claim: everything except funding and market until those confirm. */
export function cutFacetsForStatus(status: ClaimStatus, confirmedSteps: string[] = []): FacetId[] {
  if (status === 'failed') return []
  if (status !== 'publishing' && status !== 'draft') return FACET_ORDER
  const cut: FacetId[] = ['commit', 'policy', 'question', 'environment', 'deadline', 'oracle', 'manifest']
  if (confirmedSteps.includes('create_market')) cut.push('market')
  if (confirmedSteps.includes('split_position') || confirmedSteps.includes('add_liquidity_yes')) cut.push('funding')
  return cut
}
