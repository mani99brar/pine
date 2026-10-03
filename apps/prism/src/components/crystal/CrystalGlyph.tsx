'use client'

import { memo, useId, useMemo } from 'react'
import { motion } from 'motion/react'
import { useReduceMotion } from '@/lib/hooks'
import {
  crystalCrack,
  crystalShape,
  FACET_ORDER,
  facetShade,
  OUTCOME_HEX,
  pointsAttr,
  type CrystalState,
  type FacetId,
} from '@/lib/crystal'

export interface CrystalGlyphProps {
  /** Seed for the silhouette (claim id + commit, manifest hash, draft id). */
  seed: string
  /** Inputs that shade each facet (hashes, SHAs, values). */
  facetSeeds?: Partial<Record<FacetId, string | undefined>>
  /** Family hue (hex). */
  hue: string
  state?: CrystalState
  /** Facets that are cut. Defaults to all. */
  cut?: FacetId[]
  /** Rendered height in px (width follows 100:160 plus margin). */
  size?: number
  /** Halo glow (off for tiny glyphs). */
  glow?: boolean
  /** Seconds per glow pulse (light table: faster when the deadline is near). */
  pulse?: number
  /** Animate the fracture on first render (resolved YES). */
  animateFracture?: boolean
  /** Sealed: facets locked, edges brightened (publish). */
  sealed?: boolean
  /** Cut facets fade in with a glint when they mount (composer): a facet that becomes cut mounts anew. */
  animateCut?: boolean
  label?: string
  className?: string
  decorative?: boolean
}

const VIEW = '-12 -12 124 184'
const ASPECT = 124 / 184

function stateHue(state: CrystalState, hue: string): string {
  if (state === 'dim') return OUTCOME_HEX.no
  if (state === 'frosted') return OUTCOME_HEX.invalid
  if (state === 'unlit') return '#A69789'
  return hue
}

function CrystalGlyphImpl({
  seed,
  facetSeeds,
  hue,
  state = 'luminous',
  cut,
  size = 160,
  glow = true,
  pulse,
  animateFracture = false,
  sealed = false,
  animateCut = false,
  label,
  className,
  decorative,
}: CrystalGlyphProps) {
  const raw = useId()
  const uid = `c${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const reduce = useReduceMotion()
  const shape = useMemo(() => crystalShape(seed), [seed])
  const crack = useMemo(() => (state === 'fractured' ? crystalCrack(shape, seed) : null), [shape, seed, state])
  const color = stateHue(state, hue)
  const cutSet = useMemo(() => new Set<FacetId>(state === 'unlit' ? [] : (cut ?? FACET_ORDER)), [cut, state])

  const shades = useMemo(() => {
    const m = new Map<FacetId, ReturnType<typeof facetShade>>()
    for (const f of shape.facets) m.set(f.id, facetShade(f, facetSeeds?.[f.id] ?? `${seed}:${f.id}`))
    return m
    // facetSeeds values are strings; stringify for a stable key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, seed, JSON.stringify(facetSeeds ?? {})])

  const dimFactor = state === 'dim' ? 0.42 : state === 'frosted' ? 0.55 : state === 'settling' ? 0.85 : state === 'unlit' ? 0 : 1
  const showGlow = glow && (state === 'luminous' || state === 'settling' || state === 'fractured' || sealed)
  const width = size * ASPECT

  const body = (
    <g>
      {shape.facets.map((f) => {
        const isCut = cutSet.has(f.id)
        if (!isCut) {
          return (
            <polygon
              key={`${f.id}-raw`}
              points={pointsAttr(f.points)}
              fill="rgba(255,236,220,0.02)"
              stroke="#A69789"
              strokeOpacity={0.55}
              strokeWidth={0.7}
              strokeDasharray="2.2 2.2"
              strokeLinejoin="round"
            />
          )
        }
        return (
          <g key={`${f.id}-cut`}>
            <motion.polygon
              points={pointsAttr(f.points)}
              fill={`url(#${uid}-g-${f.id})`}
              stroke="#F5EDE4"
              strokeOpacity={state === 'dim' ? 0.22 : 0.38}
              strokeWidth={0.6}
              strokeLinejoin="round"
              initial={animateCut && !reduce ? { opacity: 0 } : false}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.64, ease: [0.16, 1, 0.3, 1] }}
            />
            {animateCut && !reduce && (
              <motion.polygon
                points={pointsAttr(f.points)}
                fill="#FFFFFF"
                initial={{ opacity: 0.85 }}
                animate={{ opacity: 0 }}
                transition={{ duration: 0.7, ease: [0.65, 0, 0.35, 1] }}
                style={{ mixBlendMode: 'screen' }}
              />
            )}
          </g>
        )
      })}
      {/* Specular edges */}
      {state !== 'unlit' &&
        shape.edges.map(([a, b], i) => (
          <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#FFFFFF" strokeOpacity={state === 'dim' ? 0.12 : sealed ? 0.7 : 0.4} strokeWidth={sealed ? 0.9 : 0.6} />
        ))}
      <polygon
        points={pointsAttr(shape.outline)}
        fill="none"
        stroke={state === 'unlit' ? '#A69789' : '#F5EDE4'}
        strokeOpacity={state === 'dim' ? 0.3 : state === 'unlit' ? 0.6 : sealed ? 0.85 : 0.55}
        strokeWidth={sealed ? 1.1 : 0.8}
        strokeDasharray={state === 'unlit' ? '3 2.5' : undefined}
        strokeLinejoin="round"
      />
    </g>
  )

  return (
    <svg
      viewBox={VIEW}
      width={width}
      height={size}
      className={className}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label}
      style={{ overflow: 'visible' }}
    >
      <defs>
        {shape.facets.map((f) => {
          const s = shades.get(f.id)!
          return (
            <linearGradient key={f.id} id={`${uid}-g-${f.id}`} gradientTransform={`rotate(${s.angle} 0.5 0.5)`}>
              <stop offset="0%" stopColor={color} stopOpacity={s.hi * dimFactor} />
              <stop offset="55%" stopColor={color} stopOpacity={((s.hi + s.lo) / 2) * dimFactor * 0.8} />
              <stop offset="100%" stopColor={color} stopOpacity={s.lo * dimFactor} />
            </linearGradient>
          )
        })}
        <radialGradient id={`${uid}-halo`} cx="50%" cy="48%" r="50%">
          <stop offset="0%" stopColor={color} stopOpacity={0.55} />
          <stop offset="60%" stopColor={color} stopOpacity={0.12} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </radialGradient>
        {state === 'frosted' && (
          <filter id={`${uid}-frost`} x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} seed={3} result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale={2.2} result="d" />
            <feGaussianBlur in="d" stdDeviation={0.7} />
          </filter>
        )}
        {crack && (
          <>
            <clipPath id={`${uid}-up`}>
              <polygon points={pointsAttr(crack.upper)} />
            </clipPath>
            <clipPath id={`${uid}-lo`}>
              <polygon points={pointsAttr(crack.lower)} />
            </clipPath>
            <filter id={`${uid}-crackglow`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation={2.2} />
            </filter>
          </>
        )}
      </defs>

      {showGlow && (
        <ellipse
          cx={50}
          cy={80}
          rx={62}
          ry={88}
          fill={`url(#${uid}-halo)`}
          opacity={state === 'settling' ? 0.45 : 0.7}
          style={pulse && !reduce ? { animation: `glow-pulse ${pulse}s ease-in-out infinite` } : undefined}
        />
      )}

      {crack ? (
        <>
          <motion.g
            clipPath={`url(#${uid}-up)`}
            initial={animateFracture && !reduce ? { x: 0, y: 0, rotate: 0 } : false}
            animate={{ x: -1.8, y: -1.4, rotate: -1.2 }}
            transition={{ delay: 0.55, duration: 0.6, ease: [0.34, 1.56, 0.64, 1] }}
            style={{ transformOrigin: '50px 60px' }}
          >
            {body}
          </motion.g>
          <motion.g
            clipPath={`url(#${uid}-lo)`}
            initial={animateFracture && !reduce ? { x: 0, y: 0, rotate: 0 } : false}
            animate={{ x: 1.8, y: 1.6, rotate: 1.1 }}
            transition={{ delay: 0.55, duration: 0.6, ease: [0.34, 1.56, 0.64, 1] }}
            style={{ transformOrigin: '50px 100px' }}
          >
            {body}
          </motion.g>
          <motion.polyline
            points={pointsAttr(crack.path)}
            fill="none"
            stroke={OUTCOME_HEX.yes}
            strokeWidth={5}
            strokeLinecap="round"
            strokeLinejoin="round"
            filter={`url(#${uid}-crackglow)`}
            initial={animateFracture && !reduce ? { pathLength: 0, opacity: 0 } : false}
            animate={{ pathLength: 1, opacity: 0.9 }}
            transition={{ duration: 0.6, ease: [0.65, 0, 0.35, 1] }}
          />
          <motion.polyline
            points={pointsAttr(crack.path)}
            fill="none"
            stroke="#FFE3E8"
            strokeWidth={1}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={animateFracture && !reduce ? { pathLength: 0 } : false}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.6, ease: [0.65, 0, 0.35, 1] }}
          />
        </>
      ) : state === 'frosted' ? (
        <g filter={`url(#${uid}-frost)`} opacity={0.92}>
          {body}
          <polygon points={pointsAttr(shape.outline)} fill="#DCD6E8" fillOpacity={0.16} />
        </g>
      ) : (
        <g opacity={state === 'dim' ? 0.82 : 1}>{body}</g>
      )}

      {(state === 'luminous' || sealed) && (
        <g transform={`translate(${shape.apexTop[0]} ${shape.apexTop[1] + 1})`} opacity={0.95}>
          <path d="M0,-6 L0.9,-0.9 L6,0 L0.9,0.9 L0,6 L-0.9,0.9 L-6,0 L-0.9,-0.9 Z" fill="#FFFFFF" opacity={0.9} />
        </g>
      )}
    </svg>
  )
}

export const CrystalGlyph = memo(CrystalGlyphImpl)
