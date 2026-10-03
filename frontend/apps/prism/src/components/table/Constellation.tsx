'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ClaimSummary } from '@pine/core'
import { formatClaimNumber, formatPrice, shortSha } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { ClaimCrystal } from '@/components/crystal/ClaimCrystal'
import { PrismMini, pricesFrom } from '@/components/prism/PrismBeam'
import { StatusBadge } from '@/components/claim/StatusBadge'
import { CrystalGlyph } from '@/components/crystal/CrystalGlyph'
import { FamilyIcon } from '@/components/icons'
import { FAMILY_HEX, FAMILY_NAME, FAMILY_VAR, type FacetId } from '@/lib/crystal'
import { isResolved, pulseSeconds, shortRepo, statusLabel, timeLeft } from '@/lib/claims'
import { cn } from '@/lib/cn'
import { useElementWidth, useReduceMotion } from '@/lib/hooks'

const HOUR = 3_600_000
const SPAN = 30 * 24 * HOUR
const TICKS = [
  { dt: -30 * 24 * HOUR, label: '30 days ago' },
  { dt: -7 * 24 * HOUR, label: '7d' },
  { dt: -24 * HOUR, label: '1d' },
  { dt: 24 * HOUR, label: '1d' },
  { dt: 7 * 24 * HOUR, label: '7d' },
  { dt: 30 * 24 * HOUR, label: '30 days' },
]

/** Symmetric log scale around "now": −1 (30 days past) … 0 (now) … +1 (30 days ahead). */
function scaleDt(dt: number): number {
  const s = Math.log10(1 + Math.abs(dt) / HOUR) / Math.log10(1 + SPAN / HOUR)
  return Math.sign(dt) * Math.min(1, s)
}

/** Horizontal position (0..1) of a deadline offset. Leaves room at the edges for the price scale. */
const xOf = (dt: number, span = 0.43) => 0.5 + scaleDt(dt) * span

// Vertical bands (fractions of the table height). The top band holds the captions, the bottom band the
// time ticks; priced claims sit between Y_TOP (Yes 100%) and Y_BOTTOM (Yes 0%), unpriced ones on a lane.
const Y_TOP = 0.17
const Y_BOTTOM = 0.74
const Y_LANE = 0.86
const yOfPrice = (p: number) => Y_TOP + (1 - p) * (Y_BOTTOM - Y_TOP)

interface Placed {
  claim: ClaimSummary
  x: number // 0..1
  y: number // 0..1
  size: number // px
  priced: boolean
}

function layout(claims: ClaimSummary[], nowMs: number, w: number, h: number, compact: boolean, scale = 1, span = 0.43): Placed[] {
  const maxLiq = Math.max(1, ...claims.map((c) => Number(c.liquidity) || 0))
  const placed: Placed[] = claims.map((c) => {
    const dt = Date.parse(c.evidenceDeadline) - nowMs
    const x = xOf(dt, span)
    const priced = c.yesPrice !== undefined && c.status !== 'publishing' && c.status !== 'failed'
    const p = isResolved(c.status) ? (c.outcome === 'yes' ? 0.96 : c.outcome === 'no' ? 0.06 : 0.5) : (c.yesPrice ?? 0.5)
    const y = priced || isResolved(c.status) ? yOfPrice(p) : Y_LANE
    const liq = Number(c.liquidity) || 0
    const size = ((compact ? 44 : 60) + (compact ? 40 : 64) * (Math.log10(1 + liq) / Math.log10(1 + maxLiq))) * scale
    return { claim: c, x, y, size, priced }
  })
  const onLane = (p: Placed) => !p.priced && !isResolved(p.claim.status)
  const loOf = (p: Placed) => (onLane(p) ? Y_LANE - 0.03 : 0.14)
  const hiOf = (p: Placed) => (onLane(p) ? 0.9 : Y_BOTTOM + 0.05)
  // Deterministic relaxation so crystals never sit on top of each other.
  for (let iter = 0; iter < 60; iter++) {
    let moved = false
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]
        const b = placed[j]
        if (!a || !b) continue
        const dx = (a.x - b.x) * w
        const dy = (a.y - b.y) * h
        const minX = (a.size + b.size) * 0.34
        const minY = (a.size + b.size) * 0.52
        if (Math.abs(dx) < minX && Math.abs(dy) < minY) {
          const push = (minY - Math.abs(dy)) / 2 / h + 0.002
          const dir = dy === 0 ? (i % 2 ? 1 : -1) : Math.sign(dy)
          // Each crystal stays in its band: priced ones never drift onto the "No price yet" lane.
          const ay = Math.min(hiOf(a), Math.max(loOf(a), a.y + dir * push))
          const by = Math.min(hiOf(b), Math.max(loOf(b), b.y - dir * push))
          const blocked = Math.abs(ay - a.y) + Math.abs(by - b.y) < push
          a.y = ay
          b.y = by
          if (Math.abs(dx) < minX * 0.5 || blocked) {
            const px = ((blocked ? minX : minX * 0.5) - Math.abs(dx)) / 2 / w
            const dxs = dx === 0 ? (j % 2 ? 1 : -1) : Math.sign(dx)
            a.x = Math.min(0.96, Math.max(0.06, a.x + dxs * px))
            b.x = Math.min(0.96, Math.max(0.06, b.x - dxs * px))
          }
          moved = true
        }
      }
    }
    if (!moved) break
  }
  return placed
}

function Card({ p, nowMs }: { p: Placed; nowMs: number }) {
  const c = p.claim
  const prices = pricesFrom(c)
  const resolved = isResolved(c.status)
  const tl = timeLeft(c.evidenceDeadline, nowMs)
  return (
    <div className="glass-float cut-lg w-[19rem] max-w-[calc(100vw-3rem)] !bg-[rgba(26,20,18,0.97)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="tnum text-[0.8125rem] font-semibold text-lumen-3">{formatClaimNumber(c.number)}</span>
        <StatusBadge status={c.status} outcome={c.outcome} size="sm" />
      </div>
      <p className="mt-2 text-[0.96875rem] font-semibold leading-snug text-lumen">{c.title}</p>
      <p className="mt-1 text-[0.8125rem] text-lumen-3">
        {shortRepo(c)} <span className="t-code text-[0.75rem] text-lumen-2">{shortSha(c.source.commitSha)}</span>
      </p>
      <div className="mt-3 flex items-center gap-3">
        <PrismMini prices={resolved ? undefined : prices} outcome={resolved ? c.outcome : undefined} />
        <div className="text-[0.8125rem] leading-tight">
          {resolved ? (
            <span className="text-lumen-2">{statusLabel(c.status, c.outcome)}</span>
          ) : prices ? (
            <>
              <span className="t-figure text-[1.3rem] text-lumen">{formatPrice(prices.yes)}</span>
              <span className="block text-lumen-3">{COPY.priceLabelShort}</span>
            </>
          ) : (
            <span className="text-lumen-3">No price yet</span>
          )}
        </div>
      </div>
      <p className={cn('tnum mt-3 text-[0.8125rem]', !tl.past && tl.ms < 24 * HOUR ? 'text-na' : 'text-lumen-2')}>
        {c.status === 'publishing' || c.status === 'failed' ? 'Not open for evidence' : tl.past ? `Evidence window ${tl.label}` : `Evidence window: ${tl.label}`}
      </p>
    </div>
  )
}

/**
 * The light table: claims as crystals around a vertical "now" slit. Left of the slit the evidence
 * deadline has passed; right of it the window is open. Height is the Yes price, size is liquidity,
 * hue is policy family, and the glow pulses faster as the deadline nears.
 */
export function Constellation({ claims, nowMs, compact = false, className }: { claims: ClaimSummary[]; nowMs: number; compact?: boolean; className?: string }) {
  const reduce = useReduceMotion()
  const W = 1200
  const H = compact ? 440 : 540
  // Fit the table to its box instead of scrolling sideways: on a phone the whole span (past, the "now"
  // slit and the open window) stays visible, the box gets taller and the crystals scale down.
  const [boxRef, boxW] = useElementWidth<HTMLDivElement>()
  const w = boxW || W
  const narrow = boxW > 0 && boxW < 640
  const ratio = narrow ? 0.95 : H / W
  const scale = Math.min(1, Math.max(0.42, w / W))
  const span = narrow ? 0.36 : 0.43
  const placed = useMemo(() => layout(claims, nowMs, w, w * ratio, compact, scale, span), [claims, nowMs, w, ratio, compact, scale, span])
  const [hover, setHover] = useState<string | null>(null)
  const active = placed.find((p) => p.claim.id === hover)

  return (
    <div ref={boxRef} className={cn('relative', className)}>
      <div className="relative w-full overflow-hidden" style={{ aspectRatio: `1 / ${ratio}` }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" aria-hidden preserveAspectRatio="none">
          <defs>
            <linearGradient id="slit" x1="0" x2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0" />
              <stop offset="0.5" stopColor="#fff6ec" stopOpacity="0.85" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="slit-glow" x1="0" x2="1">
              <stop offset="0" stopColor="#ffb648" stopOpacity="0" />
              <stop offset="0.5" stopColor="#ffb648" stopOpacity="0.12" />
              <stop offset="1" stopColor="#ffb648" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="past" x1="0" x2="1">
              <stop offset="0" stopColor="#0e0a09" stopOpacity="0.55" />
              <stop offset="1" stopColor="#0e0a09" stopOpacity="0" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width={W / 2} height={H} fill="url(#past)" />
          {[Y_TOP, (Y_TOP + Y_BOTTOM) / 2, Y_BOTTOM].map((t) => (
            <line key={t} x1="0" x2={W} y1={H * t} y2={H * t} stroke="#F5EDE4" strokeOpacity="0.07" strokeDasharray="2 6" />
          ))}
          <line x1="0" x2={W} y1={H * Y_LANE} y2={H * Y_LANE} stroke="#A69789" strokeOpacity="0.22" strokeDasharray="6 5" />
          {TICKS.map((t) => {
            const x = xOf(t.dt, span) * W
            return <line key={t.dt} x1={x} x2={x} y1={14} y2={H - 14} stroke="#F5EDE4" strokeOpacity="0.05" />
          })}
          <rect x={W / 2 - 60} y="0" width="120" height={H} fill="url(#slit-glow)" />
          <rect x={W / 2 - 1.5} y="0" width="3" height={H} fill="url(#slit)" />
          <line x1={W / 2} x2={W / 2} y1="0" y2={H} stroke="#fff" strokeOpacity="0.9" strokeWidth="0.75" />
        </svg>

        {/* axis captions */}
        <div aria-hidden className="pointer-events-none absolute inset-x-3 top-2 flex justify-between text-[0.72rem] text-lumen-3">
          <span>{narrow ? 'Deadline passed' : 'Evidence deadline passed'}</span>
          <span className="rounded-[3px] bg-[rgba(14,10,9,0.7)] px-1.5 text-lumen-2">now</span>
          <span>{narrow ? 'Window open' : 'Evidence window open'}</span>
        </div>
        {/* Yes-price scale and the unpriced lane */}
        <div aria-hidden className="pointer-events-none absolute inset-y-0 left-3 text-[0.72rem] leading-none text-lumen-3">
          {(
            [
              [Y_TOP, narrow ? '100%' : 'Yes 100%'],
              [(Y_TOP + Y_BOTTOM) / 2, '50%'],
              [Y_BOTTOM, '0%'],
              [Y_LANE, 'No price yet'],
            ] as const
          ).map(([t, label]) => (
            <span key={label} className="absolute -translate-y-[130%] whitespace-nowrap" style={{ top: `${t * 100}%` }}>
              {label}
            </span>
          ))}
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-2 hidden text-[0.72rem] text-lumen-3 sm:block">
          {TICKS.map((t) => (
            <span key={t.dt} className="absolute -translate-x-1/2" style={{ left: `${xOf(t.dt, span) * 100}%`, bottom: 4 }}>
              {Math.abs(t.dt) === SPAN ? '30d' : t.label}
            </span>
          ))}
        </div>

        <ul className="absolute inset-0" aria-label="Claims on the light table">
          {placed.map((p, i) => {
            const c = p.claim
            const resolved = isResolved(c.status)
            const label = `${formatClaimNumber(c.number)}: ${c.title}. ${statusLabel(c.status, c.outcome)}. ${c.policy.id}, ${FAMILY_NAME[c.policy.family].toLowerCase()}. ${
              p.priced && !resolved ? `Yes price ${formatPrice(c.yesPrice ?? 0)}.` : ''
            } ${c.status === 'open' ? `Evidence window: ${timeLeft(c.evidenceDeadline, nowMs).label}.` : ''}`.trim()
            return (
              <motion.li
                key={c.id}
                className="absolute"
                style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, zIndex: hover === c.id ? 5 : 1 }}
                initial={reduce ? false : { opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: reduce ? 0 : 0.03 * i, type: 'spring', stiffness: 260, damping: 22 }}
              >
                <Link
                  href={`/claims/${c.id}`}
                  aria-label={label}
                  onMouseEnter={() => setHover(c.id)}
                  onMouseLeave={() => setHover((h) => (h === c.id ? null : h))}
                  onFocus={() => setHover(c.id)}
                  onBlur={() => setHover((h) => (h === c.id ? null : h))}
                  className="group block -translate-x-1/2 -translate-y-1/2 rounded-full p-1 outline-offset-2 transition-transform duration-300 hover:scale-110 focus-visible:scale-110"
                >
                  <ClaimCrystal claim={c} size={p.size} glow={!compact || !resolved} pulse={pulseSeconds(c.evidenceDeadline, nowMs)} decorative />
                </Link>
              </motion.li>
            )
          })}
        </ul>

        <AnimatePresence>
          {active && (
            <motion.div
              key={active.claim.id}
              className="pointer-events-none absolute z-10"
              style={{ left: `${active.x * 100}%`, top: `${active.y * 100}%` }}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.18 }}
            >
              <div style={{ transform: `translate(${active.x > 0.62 ? 'calc(-100% - 2.5rem)' : '2.5rem'}, ${active.y > 0.55 ? '-90%' : '-12%'})` }}>
                <Card p={active} nowMs={nowMs} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

/** What the light table's marks mean: hue, endings, size, height and pulse. Text carries every meaning. */
export function ConstellationLegend({ className }: { className?: string }) {
  const endings: { state: 'luminous' | 'settling' | 'fractured' | 'dim' | 'frosted' | 'partial' | 'unlit'; label: string; cut?: FacetId[] }[] = [
    { state: 'luminous', label: 'Open, pulsing faster near its deadline' },
    { state: 'settling', label: 'With the oracle or contested' },
    { state: 'fractured', label: 'Counterexample demonstrated' },
    { state: 'dim', label: 'No qualifying counterexample submitted' },
    { state: 'frosted', label: 'Resolved invalid' },
    { state: 'partial', label: 'Publishing, partly cut', cut: ['commit', 'policy', 'question'] },
    { state: 'unlit', label: 'Failed, never lit' },
  ]
  return (
    <div className={cn('grid gap-x-8 gap-y-3 text-[0.8125rem] text-lumen-2 md:grid-cols-[auto_minmax(0,1fr)]', className)}>
      <div>
        <p className="mb-1.5 text-[0.75rem] font-semibold text-lumen-3">Hue is the policy family</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
          {(['FUNC', 'BOT', 'SC'] as const).map((f) => (
            <li key={f} className="inline-flex items-center gap-1.5">
              <span style={{ color: FAMILY_VAR[f] }}>
                <FamilyIcon family={f} size={14} />
              </span>
              <span>
                <span className="font-semibold text-lumen">{f}</span> {FAMILY_NAME[f].toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="mb-1.5 text-[0.75rem] font-semibold text-lumen-3">The crystal shows where the claim is</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
          {endings.map((e, i) => (
            <li key={e.state} className="inline-flex items-center gap-1.5">
              <CrystalGlyph
                seed={`legend:${i}`}
                hue={FAMILY_HEX.FUNC}
                state={e.state}
                cut={e.cut}
                size={30}
                glow={false}
                decorative
              />
              {e.label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
