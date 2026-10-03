/**
 * Static SVG markup for crystals and beams (server-safe, no React): used by the OG image routes, where
 * the image renderer embeds the SVG as a data URI.
 */
import { crystalCrack, crystalShape, facetShade, FACET_ORDER, OUTCOME_HEX, pointsAttr, type CrystalState, type FacetId } from './crystal'

export function crystalSvg(opts: { seed: string; hue: string; state: CrystalState; cut?: FacetId[]; facetSeeds?: Partial<Record<FacetId, string | undefined>> }): string {
  const shape = crystalShape(opts.seed)
  const color = opts.state === 'dim' ? OUTCOME_HEX.no : opts.state === 'frosted' ? OUTCOME_HEX.invalid : opts.state === 'unlit' ? '#A69789' : opts.hue
  const dim = opts.state === 'dim' ? 0.42 : opts.state === 'frosted' ? 0.55 : opts.state === 'settling' ? 0.85 : opts.state === 'unlit' ? 0 : 1
  const cut = new Set(opts.state === 'unlit' ? [] : (opts.cut ?? FACET_ORDER))
  const defs: string[] = []
  const faces: string[] = []
  for (const f of shape.facets) {
    if (!cut.has(f.id)) {
      faces.push(`<polygon points="${pointsAttr(f.points)}" fill="none" stroke="#A69789" stroke-opacity="0.55" stroke-width="0.7" stroke-dasharray="2.2 2.2"/>`)
      continue
    }
    const s = facetShade(f, opts.facetSeeds?.[f.id] ?? `${opts.seed}:${f.id}`)
    defs.push(
      `<linearGradient id="g-${f.id}" gradientTransform="rotate(${s.angle} 0.5 0.5)"><stop offset="0" stop-color="${color}" stop-opacity="${(s.hi * dim).toFixed(3)}"/><stop offset="1" stop-color="${color}" stop-opacity="${(s.lo * dim).toFixed(3)}"/></linearGradient>`,
    )
    faces.push(`<polygon points="${pointsAttr(f.points)}" fill="url(#g-${f.id})" stroke="#F5EDE4" stroke-opacity="${opts.state === 'dim' ? 0.22 : 0.4}" stroke-width="0.6"/>`)
  }
  const edges = shape.edges.map(([a, b]) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#fff" stroke-opacity="${opts.state === 'dim' ? 0.12 : 0.45}" stroke-width="0.6"/>`).join('')
  const outline = `<polygon points="${pointsAttr(shape.outline)}" fill="none" stroke="#F5EDE4" stroke-opacity="${opts.state === 'dim' ? 0.3 : 0.6}" stroke-width="0.8" ${opts.state === 'unlit' ? 'stroke-dasharray="3 2.5"' : ''}/>`
  const glow = opts.state === 'luminous' || opts.state === 'settling' || opts.state === 'fractured'
  defs.push(`<radialGradient id="halo" cx="50%" cy="48%" r="50%"><stop offset="0" stop-color="${color}" stop-opacity="0.5"/><stop offset="0.6" stop-color="${color}" stop-opacity="0.1"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`)
  let body = `<g>${faces.join('')}${edges}${outline}</g>`
  if (opts.state === 'fractured') {
    const crack = crystalCrack(shape, opts.seed)
    defs.push(`<clipPath id="up"><polygon points="${pointsAttr(crack.upper)}"/></clipPath><clipPath id="lo"><polygon points="${pointsAttr(crack.lower)}"/></clipPath>`)
    body = `<g clip-path="url(#up)" transform="translate(-1.8 -1.4)">${body}</g><g clip-path="url(#lo)" transform="translate(1.8 1.6)">${body}</g><polyline points="${pointsAttr(crack.path)}" fill="none" stroke="${OUTCOME_HEX.yes}" stroke-width="2.4" stroke-linejoin="round"/><polyline points="${pointsAttr(crack.path)}" fill="none" stroke="#FFE3E8" stroke-width="0.8"/>`
  }
  if (opts.state === 'frosted') body = `<g opacity="0.85">${body}<polygon points="${pointsAttr(shape.outline)}" fill="#DCD6E8" fill-opacity="0.18"/></g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-12 -12 124 184"><defs>${defs.join('')}</defs>${glow ? `<ellipse cx="50" cy="80" rx="62" ry="88" fill="url(#halo)" opacity="0.7"/>` : ''}${body}</svg>`
}

/** A prism with three outcome beams; widths are prices. `outcome` shows only the settled beam. */
export function beamSvg(opts: { yes: number; no: number; invalid: number; outcome?: 'yes' | 'no' | 'invalid'; width?: number; height?: number; prism?: boolean }): string {
  const W = opts.width ?? 720
  const H = opts.height ?? 300
  const ex = W * 0.47
  const ey = H / 2
  const beam = (p: number, endY: number) => {
    const t1 = Math.max(2, p * H * 0.44)
    const t0 = 3 + p * 12
    return `${ex},${ey - t0 / 2} ${W},${endY - t1 / 2} ${W},${endY + t1 / 2} ${ex},${ey + t0 / 2}`
  }
  const show = (k: 'yes' | 'no' | 'invalid') => (opts.outcome ? opts.outcome === k : true)
  const w = (k: 'yes' | 'no' | 'invalid') => (opts.outcome ? 0.6 : opts[k])
  const beams = (
    [
      ['yes', H * 0.2, OUTCOME_HEX.yes, 0.95],
      ['no', H * 0.53, OUTCOME_HEX.no, 0.5],
      ['invalid', H * 0.84, OUTCOME_HEX.invalid, 0.55],
    ] as const
  )
    .filter(([k]) => show(k))
    .map(([k, y, c, o]) => `<polygon points="${beam(w(k), y)}" fill="url(#b-${k})" opacity="${opts.outcome === 'no' ? 0.45 : o}"/><defs><linearGradient id="b-${k}" x1="0" x2="1"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="${c}" stop-opacity="0.25"/></linearGradient></defs>`)
    .join('')
  const px = W * 0.38
  const prism = opts.prism === false ? '' : `<polygon points="${px + W * 0.04},${H * 0.1} ${px + W * 0.16},${H * 0.88} ${px - W * 0.08},${H * 0.88}" fill="rgba(245,237,228,0.08)" stroke="#F5EDE4" stroke-opacity="0.6" stroke-width="1.6" stroke-linejoin="round"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="in" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect x="0" y="${ey - 2}" width="${px}" height="4" fill="url(#in)"/>${beams}${prism}</svg>`
}

export const svgDataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
