/**
 * Pine Prism icon set: 24px grid, 1.5px stroke, faceted geometry. Hand-drawn for this app.
 */
import type { SVGProps } from 'react'
import type { Outcome, PolicyFamilyId } from '@pine/core'

type P = SVGProps<SVGSVGElement> & { size?: number }

function Base({ size = 20, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {children}
    </svg>
  )
}

/** The Prism mark: one beam in, three out. */
export function PrismMark({ size = 28, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden {...rest}>
      <defs>
        <linearGradient id="pm-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#F5EDE4" stopOpacity="0.95" />
          <stop offset="1" stopColor="#F5EDE4" stopOpacity="0.35" />
        </linearGradient>
      </defs>
      <path d="M1 17.2 L11.5 16" stroke="#F5EDE4" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M16 5 L25 25 L7 25 Z" fill="rgba(245,237,228,0.08)" stroke="url(#pm-glass)" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M19.6 15.4 L31 11.4" stroke="#FF6B83" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M20.2 16.6 L31 16.8" stroke="#A9B4C1" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M20.6 17.8 L30.6 21.2" stroke="#DCD6E8" strokeWidth="0.9" strokeLinecap="round" strokeOpacity="0.8" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Policy families
// ---------------------------------------------------------------------------

/** FUNC: a facet held between code brackets. */
export function FuncIcon(p: P) {
  return (
    <Base {...p}>
      <path d="M7 5 L3.5 12 L7 19" />
      <path d="M17 5 L20.5 12 L17 19" />
      <path d="M12 7 L15 12 L12 17 L9 12 Z" />
    </Base>
  )
}

/** BOT: a gear-cut facet (automation with a fixed cadence). */
export function BotIcon(p: P) {
  return (
    <Base {...p}>
      <path d="M12 3.5 L14 6 L17.5 5.6 L17.9 9 L20.5 11 L18.6 13.8 L19.4 17.2 L16 17.8 L14.2 20.6 L12 18.6 L9.8 20.6 L8 17.8 L4.6 17.2 L5.4 13.8 L3.5 11 L6.1 9 L6.5 5.6 L10 6 Z" />
      <path d="M12 9 L14.6 12 L12 15 L9.4 12 Z" />
    </Base>
  )
}

/** SC: a shard with a lock notch (gated, disclosure required). */
export function ScIcon(p: P) {
  return (
    <Base {...p}>
      <path d="M12 2.8 L19 9 L16 21 L8 21 L5 9 Z" />
      <path d="M9.5 13.5 h5 v4 h-5 z" />
      <path d="M10.5 13.5 v-1.4 a1.5 1.5 0 0 1 3 0 v1.4" />
    </Base>
  )
}

export function FamilyIcon({ family, ...p }: P & { family: PolicyFamilyId }) {
  if (family === 'BOT') return <BotIcon {...p} />
  if (family === 'SC') return <ScIcon {...p} />
  return <FuncIcon {...p} />
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** YES: fractured crystal. */
export function FracturedIcon(p: P) {
  return (
    <Base {...p}>
      <path d="M12 2.5 L17.5 8 L17.5 15.5 L12 21.5 L6.5 15.5 L6.5 8 Z" />
      <path d="M6.5 11.2 L9.4 12.6 L11 10.6 L13.2 13.4 L15 11.8 L17.5 12.8" strokeWidth={1.8} />
    </Base>
  )
}

/** NO: intact but dimmed crystal (dashed inner light, no rays). */
export function DimmedIcon(p: P) {
  return (
    <Base {...p}>
      <path d="M12 2.5 L17.5 8 L17.5 15.5 L12 21.5 L6.5 15.5 L6.5 8 Z" />
      <path d="M12 2.5 L12 21.5" strokeOpacity={0.45} />
      <path d="M6.5 8 L17.5 8" strokeOpacity={0.45} strokeDasharray="1.5 2" />
    </Base>
  )
}

/** INVALID: clouded crystal. */
export function CloudedIcon(p: P) {
  return (
    <Base {...p}>
      <path d="M12 2.5 L17.5 8 L17.5 15.5 L12 21.5 L6.5 15.5 L6.5 8 Z" strokeDasharray="2.2 1.6" />
      <path d="M8.6 13.4 a1.8 1.8 0 0 1 2.4 -2 a2.2 2.2 0 0 1 4 1 a1.5 1.5 0 0 1 0.4 3 h-6.4 a1.3 1.3 0 0 1 -0.4 -2" />
    </Base>
  )
}

export function OutcomeIcon({ outcome, ...p }: P & { outcome: Outcome }) {
  if (outcome === 'yes') return <FracturedIcon {...p} />
  if (outcome === 'invalid') return <CloudedIcon {...p} />
  return <DimmedIcon {...p} />
}

// ---------------------------------------------------------------------------
// Story steps
// ---------------------------------------------------------------------------

export function CommitIcon(p: P) {
  return (
    <Base {...p}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M3 12 h5.8 M15.2 12 H21" />
      <path d="M12 5.5 L13.2 7 M12 18.5 L13.2 17" strokeOpacity={0.5} />
    </Base>
  )
}
export function PolicyIcon(p: P) {
  return (
    <Base {...p}>
      <path d="M6 3 h9 l3.5 3.5 V21 H6 Z" />
      <path d="M15 3 v3.5 h3.5" />
      <path d="M9 11 h6 M9 14 h6 M9 17 h3.5" />
    </Base>
  )
}
export function QuestionIcon(p: P) {
  return (
    <Base {...p}>
      <path d="M12 2.8 L20 8 L20 16 L12 21.2 L4 16 L4 8 Z" />
      <path d="M9.8 9.8 a2.3 2.3 0 1 1 3.4 2 c-0.8 0.5 -1.2 1 -1.2 1.9" />
      <path d="M12 16.6 v0.2" strokeWidth={2} />
    </Base>
  )
}
export function MarketIcon(p: P) {
  return (
    <Base {...p}>
      <path d="M2.5 12 H8" />
      <path d="M8 6 L14 18 L8 18 Z" transform="translate(1 -0.5)" />
      <path d="M15 11 L21.5 7.5" />
      <path d="M15.4 12.6 L21.5 12.6" strokeOpacity={0.7} />
      <path d="M15.6 14 L21 16.5" strokeOpacity={0.4} />
    </Base>
  )
}
export function EvidenceIcon(p: P) {
  return (
    <Base {...p}>
      <path d="M12 3 L18 9 L18 15 L12 21 L6 15 L6 9 Z" />
      <path d="M2.5 5.5 L8.5 10.5" />
      <path d="M2.5 12 L6.5 12.2" strokeOpacity={0.6} />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </Base>
  )
}
export function OracleIcon(p: P) {
  return (
    <Base {...p}>
      <ellipse cx="9" cy="12" rx="2.2" ry="7" />
      <ellipse cx="16" cy="12" rx="2.2" ry="7" strokeOpacity={0.6} />
      <path d="M2.5 12 H6.8 M11.2 12 h2.6 M18.2 12 H21.5" />
    </Base>
  )
}
export function OutcomeStepIcon(p: P) {
  return (
    <Base {...p}>
      <path d="M5 4 L9 8 L9 14 L5 18 L1.8 14 L1.8 8 Z" transform="translate(1.2 1)" />
      <path d="M12 4 L16 8 L16 14 L12 18 L8.8 14 L8.8 8 Z" transform="translate(1.6 1)" strokeOpacity={0.5} />
      <path d="M19 4 L23 8 L23 14 L19 18 L15.8 14 L15.8 8 Z" transform="translate(-0.4 1)" strokeDasharray="1.8 1.4" />
    </Base>
  )
}
