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
import { isResolved, pulseSeconds, shortRepo, statusLabel, timeLeft } from '@/lib/claims'
import { cn } from '@/lib/cn'
import { useReduceMotion } from '@/lib/hooks'

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

interface Placed {
  claim: ClaimSummary
  x: number // 0..1
  y: number // 0..1
  size: number // px
  priced: boolean
}

function layout(claims: ClaimSummary[], nowMs: number, w: number, h: number, compact: boolean): Placed[] {
  const maxLiq = Math.max(1, ...claims.map((c) => Number(c.liquidity) || 0))
  const placed: Placed[] = claims.map((c) => {
    const dt = Date.parse(c.evidenceDeadline) - nowMs
    const x = 0.5 + scaleDt(dt) * 0.46
    const priced = c.yesPrice !== undefined && c.status !== 'publishing' && c.status !== 'failed'
    const p = isResolved(c.status) ? (c.outcome === 'yes' ? 0.96 : c.outcome === 'no' ? 0.06 : 0.5) : (c.yesPrice ?? 0.5)
    const y = priced || isResolved(c.status) ? 0.08 + (1 - p) * 0.8 : 0.93
    const liq = Number(c.liquidity) || 0
    const size = (compact ? 34 : 44) + (compact ? 30 : 46) * Math.sqrt(liq / maxLiq)
    return { claim: c, x, y, size, priced }
  })
  // Deterministic relaxation so crystals never sit on top of each other.
  for (let iter = 0; iter < 60; iter++) {
    let moved = false
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]
        const b = placed[j]
        const dx = (a.x - b.x) * w
        const dy = (a.y - b.y) * h
        const minX = (a.size + b.size) * 0.34
        const minY = (a.size + b.size) * 0.52
        if (Math.abs(dx) < minX && Math.abs(dy) < minY) {
          const push = (minY - Math.abs(dy)) / 2 / h + 0.002
          const dir = dy === 0 ? (i % 2 ? 1 : -1) : Math.sign(dy)
          a.y = Math.min(0.95, Math.max(0.06, a.y + dir * push))
          b.y = Math.min(0.95, Math.max(0.06, b.y - dir * push))
          if (Math.abs(dx) < minX * 0.5) {
            const px = (minX * 0.5 - Math.abs(dx)) / 2 / w
            const dxs = dx === 0 ? (j % 2 ? 1 : -1) : Math.sign(dx)
            a.x = Math.min(0.97, Math.max(0.03, a.x + dxs * px))
            b.x = Math.min(0.97, Math.max(0.03, b.x - dxs * px))
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
    <div className="glass-float cut-lg w-[19rem] p-4">
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
  const H = compact ? 440 : 600
  const placed = useMemo(() => layout(claims, nowMs, W, H, compact), [claims, nowMs, H, compact])
  const [hover, setHover] = useState<string | null>(null)
  const active = placed.find((p) => p.claim.id === hover)

  return (
    <div className={cn('relative overflow-x-auto overflow-y-hidden', className)}>
      <div className="relative w-full min-w-[720px] overflow-hidden" style={{ aspectRatio: `${W} / ${H}` }}>
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
          {[0.08, 0.48, 0.88].map((t) => (
            <line key={t} x1="0" x2={W} y1={H * t} y2={H * t} stroke="#F5EDE4" strokeOpacity="0.06" strokeDasharray="2 6" />
          ))}
          {TICKS.map((t) => {
            const x = (0.5 + scaleDt(t.dt) * 0.46) * W
            return <line key={t.dt} x1={x} x2={x} y1={14} y2={H - 14} stroke="#F5EDE4" strokeOpacity="0.05" />
          })}
          <rect x={W / 2 - 60} y="0" width="120" height={H} fill="url(#slit-glow)" />
          <rect x={W / 2 - 1.5} y="0" width="3" height={H} fill="url(#slit)" />
          <line x1={W / 2} x2={W / 2} y1="0" y2={H} stroke="#fff" strokeOpacity="0.9" strokeWidth="0.75" />
        </svg>

        {/* axis captions */}
        <div aria-hidden className="pointer-events-none absolute inset-x-3 top-2 flex justify-between text-[0.72rem] text-lumen-3">
          <span>Evidence deadline passed</span>
          <span className="rounded-[3px] bg-[rgba(14,10,9,0.7)] px-1.5 text-lumen-2">now</span>
          <span>Evidence window open</span>
        </div>
        <div aria-hidden className="pointer-events-none absolute bottom-2 left-3 text-[0.72rem] text-lumen-3">
          Higher means the market sees a counterexample as more likely
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-2 hidden text-[0.72rem] text-lumen-3 sm:block">
          {TICKS.map((t) => (
            <span key={t.dt} className="absolute -translate-x-1/2" style={{ left: `${(0.5 + scaleDt(t.dt) * 0.46) * 100}%`, bottom: 18 }}>
              {Math.abs(t.dt) === SPAN ? '30d' : t.label}
            </span>
          ))}
        </div>

        <ul className="absolute inset-0" aria-label="Claims on the light table">
          {placed.map((p, i) => {
            const c = p.claim
            const resolved = isResolved(c.status)
            const label = `${formatClaimNumber(c.number)}: ${c.title}. ${statusLabel(c.status, c.outcome)}. ${
              p.priced && !resolved ? `Yes price ${formatPrice(c.yesPrice ?? 0)}.` : ''
            } ${c.status === 'open' ? timeLeft(c.evidenceDeadline, nowMs).label : ''}`
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
