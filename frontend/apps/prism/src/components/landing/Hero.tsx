'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useClaim, useClaims, usePine } from '@pine/react'
import { formatPrice } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { Plus } from 'lucide-react'
import { CrystalGlyph } from '@/components/crystal/CrystalGlyph'
import { AnimatedNumber } from '@/components/ui/interactive'
import { pricesFrom, type BeamPrices } from '@/components/prism/PrismBeam'
import { FAMILY_HEX, OUTCOME_HEX } from '@/lib/crystal'
import { apiOutcomePrices, claimLabel, countdown, type OutcomePrices } from '@/lib/claims'
import { hasWebGL, useInViewport, useMounted, useNowMs, usePageVisible, usePrefersReducedMotion } from '@/lib/hooks'
import { cn } from '@/lib/cn'

const HeroCanvas = dynamic(() => import('./HeroCanvas'), { ssr: false, loading: () => null })

const FLAGSHIP = 'pine-0009'
const FALLBACK_PRICES: BeamPrices = { yes: 0.3, no: 0.67, invalid: 0.03 }

type Mode = 'auto' | 'gl' | 'play' | 'final'

/** Static composition of the final hero state. The fallback for no WebGL, reduced motion and no JS. */
function HeroPoster({ prices, hue, seed, mode }: { prices: BeamPrices; hue: string; seed: string; mode: Mode }) {
  const cy = 286
  const ex = 352
  const beam = (p: number, angle: number) => {
    const len = 288
    const endY = cy - Math.tan(angle) * len
    const t1 = Math.max(3, p * 150)
    const t0 = 3 + p * 8
    return `${ex},${cy - t0 / 2} ${ex + len},${endY - t1 / 2} ${ex + len},${endY + t1 / 2} ${ex},${cy + t0 / 2}`
  }
  return (
    <div className="hp absolute inset-0" data-mode={mode} aria-hidden>
      <svg viewBox="0 0 640 560" className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="hp-in" x1="0" x2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="1" stopColor="#fff" stopOpacity="1" />
          </linearGradient>
          <radialGradient id="hp-pool" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#ffb648" stopOpacity="0.28" />
            <stop offset="0.5" stopColor="#ff6b83" stopOpacity="0.08" />
            <stop offset="1" stopColor="#ff6b83" stopOpacity="0" />
          </radialGradient>
          <filter id="hp-blur" x="-20%" y="-60%" width="140%" height="220%">
            <feGaussianBlur stdDeviation="10" />
          </filter>
          {(['yes', 'no', 'invalid'] as const).map((k) => (
            <linearGradient key={k} id={`hp-${k}`} x1="0" x2="1">
              <stop offset="0" stopColor={OUTCOME_HEX[k]} stopOpacity="1" />
              <stop offset="1" stopColor={OUTCOME_HEX[k]} stopOpacity="0.25" />
            </linearGradient>
          ))}
        </defs>
        <ellipse className="hp-beam" cx="360" cy="478" rx="230" ry="38" fill="url(#hp-pool)" />
        <g className="hp-beam hp-in">
          <rect x="0" y={cy - 8} width="320" height="16" fill="url(#hp-in)" filter="url(#hp-blur)" opacity="0.7" />
          <rect x="0" y={cy - 1.6} width="320" height="3.2" fill="url(#hp-in)" />
        </g>
        {(
          [
            ['yes', 0.26, 0.95],
            ['no', 0, 0.3],
            ['invalid', -0.24, 0.5],
          ] as const
        ).map(([k, a, o]) => (
          <g key={k} className="hp-beam hp-out">
            <polygon points={beam(prices[k], a)} fill={OUTCOME_HEX[k]} filter="url(#hp-blur)" opacity={o * 0.55} />
            <polygon points={beam(prices[k], a)} fill={`url(#hp-${k})`} opacity={o} />
            <line x1={ex} y1={cy} x2={ex + 288} y2={cy - Math.tan(a) * 288} stroke="#fff" strokeOpacity={o * 0.55} strokeWidth="1" />
          </g>
        ))}
      </svg>
      <div className="hp-crystal absolute left-1/2 top-1/2 -translate-x-[46%] -translate-y-[54%]">
        <CrystalGlyph seed={seed} hue={hue} size={360} decorative />
      </div>
    </div>
  )
}

/** The figures under the hero: prices where known ("—" otherwise) and what they mean. */
function Readout({ figures, note, live }: { figures: OutcomePrices; note: string; live: { id: string; number: number; title: string; deadline: string } | null }) {
  const now = useNowMs()
  if (!live) return <div className="cut-lg glass-quiet h-[12.5rem] w-full max-w-[34rem]" aria-hidden />
  return (
    <div className="cut-lg glass relative min-h-[12.5rem] w-full max-w-[34rem] overflow-hidden px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[0.8125rem] text-lumen-3">
          Live now{' '}
          <Link href={`/claims/${live.id}`} className="link font-semibold text-lumen-2">
            {claimLabel(live)}
          </Link>
        </p>
        <p className="tnum text-[0.8125rem] text-lumen-3">{now ? `Evidence window: ${countdown(live.deadline, now)}` : 'Evidence window open'}</p>
      </div>
      <p className="mt-1 truncate text-[0.9375rem] font-medium text-lumen" title={live.title}>
        {live.title}
      </p>
      <dl className="mt-3 grid grid-cols-[1fr_1fr_auto] gap-3">
        {(
          [
            ['yes', COPY.outcome.yes],
            ['no', COPY.outcome.no],
            ['invalid', 'Invalid result'],
          ] as const
        ).map(([k, label]) => (
          <div key={k} className="min-w-0 border-l-2 pl-2.5" style={{ borderColor: OUTCOME_HEX[k] }}>
            <dt className="min-h-[2.5em] text-[0.75rem] leading-[1.25] text-lumen-2">{label}</dt>
            <dd className="t-figure text-[1.6rem] leading-tight text-lumen">
              {figures[k] === undefined ? (
                <span className="text-lumen-3">
                  —<span className="sr-only"> not priced</span>
                </span>
              ) : (
                <AnimatedNumber value={figures[k]} format={formatPrice} />
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[0.78rem] leading-[1.45] text-lumen-3">{note}</p>
    </div>
  )
}

const PRICED_NOTE = `The three beams leaving the crystal are these outcomes, and each beam's width is its price. Yes is the ${COPY.priceLabel.toLowerCase()}.`

/**
 * `api` mode: the figures are only the pool prices Pine reports for the claim shown (Invalid result has no pool), never
 * the decorative beam widths, and the caption says which.
 */
function apiNote(prices: OutcomePrices, loading: boolean): string {
  if (loading) return 'Reading the pool prices Pine reports for this market.'
  if (prices.yes === undefined && prices.no === undefined) return 'Not priced yet: Pine reports no pool price for this market. The beams are an illustration, not prices.'
  return `Figures are the marginal pool prices Pine reports; an outcome without a pool is not priced.${prices.yes !== undefined ? ` Yes is the ${COPY.priceLabel.toLowerCase()}.` : ''} The beams are an illustration, not prices.`
}

export function Hero() {
  const reduce = usePrefersReducedMotion()
  const apiMode = usePine().env.dataSource === 'api'
  // Demo: the flagship claim. api mode has no flagship: the first open claim, with the prices Pine reports for it.
  const flagship = useClaim(apiMode ? undefined : FLAGSHIP, { live: true })
  const fallback = useClaims({ status: 'open', sort: 'liquidity', limit: 1 })
  const claim = flagship.data ?? undefined
  const alt = fallback.data?.items[0]
  const altDetail = useClaim(apiMode ? alt?.id : undefined, { live: true })
  const apiPrices: OutcomePrices = apiMode && altDetail.data ? apiOutcomePrices(altDetail.data) : {}
  // Beam widths: real prices in the demo; decorative in api mode (never labelled as a claim's prices there).
  const prices = (claim ? pricesFrom(claim) : alt && !apiMode ? pricesFrom(alt) : undefined) ?? FALLBACK_PRICES
  const figures: OutcomePrices = apiMode ? apiPrices : prices
  const note = apiMode ? apiNote(apiPrices, Boolean(alt) && altDetail.isLoading) : PRICED_NOTE
  const hue = FAMILY_HEX[claim?.policy.family ?? alt?.policy.family ?? 'BOT']
  const seed = claim ? `${claim.id}:${claim.source.commitSha}` : 'pine-hero'
  const live = claim
    ? { id: claim.id, number: claim.number, title: claim.title, deadline: claim.evidenceDeadline }
    : alt
      ? { id: alt.id, number: alt.number, title: alt.title, deadline: alt.evidenceDeadline }
      : null

  const mounted = useMounted()
  const gl = mounted ? hasWebGL() : null
  const [glReady, setGlReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const [stageRef, inView] = useInViewport<HTMLDivElement>('80px')
  const pageVisible = usePageVisible()

  // If the scene is not ready in time, the poster plays its own reveal instead.
  useEffect(() => {
    if (!mounted || reduce || !gl) return
    const t = setTimeout(() => setTimedOut(true), 4500)
    return () => clearTimeout(t)
  }, [mounted, reduce, gl])

  const mode: Mode = !mounted ? 'auto' : reduce ? 'final' : glReady ? 'gl' : !gl || failed || timedOut ? 'play' : 'auto'
  const wantGl = mounted && !reduce && Boolean(gl) && !failed && !(timedOut && !glReady)

  return (
    <section className="relative" aria-labelledby="hero-title">
      <div className="mx-auto w-full max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <div className="hero-grid grid items-center gap-x-10 gap-y-7 pb-12 pt-10 sm:pt-14 lg:min-h-[calc(100dvh-7.5rem)] lg:pb-16">
          <div className="[grid-area:title]">
            <h1 id="hero-title" className="t-display chroma relative max-w-[11ch]">
              <span>Hold your claim up to the light.</span>
              <span aria-hidden className="hero-sweep pointer-events-none absolute inset-0">
                Hold your claim up to the light.
              </span>
            </h1>
          </div>

          <div
            ref={stageRef}
            className="relative aspect-[8/7] w-full [grid-area:stage] [mask-image:linear-gradient(90deg,transparent_0,#000_9%,#000_80%,transparent_99%)]"
          >
            <div className="absolute inset-[8%] rounded-full bg-[radial-gradient(closest-side,rgba(255,182,72,0.09),transparent)]" aria-hidden />
            <HeroPoster prices={prices} hue={hue} seed={seed} mode={mode} />
            {wantGl && (
              <div className={cn('absolute inset-0 transition-opacity duration-700', glReady ? 'opacity-100' : 'opacity-0')}>
                <HeroCanvas
                  seed={seed}
                  hue={hue}
                  prices={prices}
                  active={inView && pageVisible}
                  onReady={() => setGlReady(true)}
                  onFail={() => {
                    setGlReady(false)
                    setFailed(true)
                  }}
                />
              </div>
            )}
            <p className="sr-only">
              {apiMode
                ? 'Illustration: a white beam enters a crystal and splits into a Yes beam, a No beam and a thin Invalid-result beam.'
                : 'Illustration: a white beam enters a crystal and splits into a Yes beam, a No beam and a thin Invalid-result beam whose widths follow the live market price.'}
            </p>
          </div>

          <div className="[grid-area:body]">
            <p className="t-lead max-w-[54ch]">
              Pine turns one bounded claim about an exact commit into an open market. Anyone, human or AI agent, can try to demonstrate a reproducible counterexample before a fixed UTC deadline. The price is the market-implied chance that one is accepted.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/compose" className="btn btn-light btn-lg">
                <Plus size={17} aria-hidden /> Compose a claim
              </Link>
              <Link href="/claims" className="btn btn-glass btn-lg">
                Open the light table
              </Link>
            </div>
            <div className="mt-10">
              <Readout figures={figures} note={note} live={live} />
            </div>
          </div>
        </div>
      </div>
      <noscript>
        <style>{'.hp .hp-beam,.hp .hp-crystal{opacity:1!important}'}</style>
      </noscript>
    </section>
  )
}
