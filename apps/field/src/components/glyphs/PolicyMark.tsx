import type { PolicyFamilyId } from '@pine/core'
import { cn } from '@/lib/cn'

const FAMILY_NAME: Record<PolicyFamilyId, string> = {
  FUNC: 'Functional correctness',
  BOT: 'Automation and keeper reliability',
  SC: 'Smart-contract invariant',
}

export interface PolicyMarkProps {
  family: PolicyFamilyId
  /** e.g. "BOT-001" or "BOT-001@0.1.0" */
  code?: string
  gated?: boolean
  size?: number
  showCode?: boolean
  className?: string
}

/** Shape for each policy family: FUNC circle, BOT hexagon, SC diamond. Gated policies are dashed with a padlock bar. */
export function PolicyShape({ family, gated, size = 16 }: { family: PolicyFamilyId; gated?: boolean; size?: number }) {
  const s = size
  const sw = Math.max(1.5, s / 9)
  const inset = sw / 2 + 0.5
  const dash = gated ? `${s / 7} ${s / 9}` : undefined
  let shape: React.ReactNode
  if (family === 'FUNC') {
    shape = <circle cx={s / 2} cy={s / 2} r={s / 2 - inset} />
  } else if (family === 'BOT') {
    const r = s / 2 - inset
    const pts = Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i - Math.PI / 2
      return `${s / 2 + r * Math.cos(a)},${s / 2 + r * Math.sin(a)}`
    }).join(' ')
    shape = <polygon points={pts} />
  } else {
    const r = s / 2 - inset
    shape = <polygon points={`${s / 2},${s / 2 - r} ${s / 2 + r},${s / 2} ${s / 2},${s / 2 + r} ${s / 2 - r},${s / 2}`} />
  }
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} aria-hidden className="block shrink-0">
      <g fill="none" stroke="currentColor" strokeWidth={sw} strokeDasharray={dash} strokeLinejoin="round">
        {shape}
      </g>
      {family === 'FUNC' && !gated && <circle cx={s / 2} cy={s / 2} r={s / 9} fill="currentColor" />}
      {family === 'BOT' && !gated && <rect x={s / 2 - s / 9} y={s / 2 - s / 9} width={(2 * s) / 9} height={(2 * s) / 9} fill="currentColor" />}
      {family === 'SC' && !gated && <circle cx={s / 2} cy={s / 2} r={s / 10} fill="currentColor" />}
      {gated && <rect x={s * 0.3} y={s * 0.46} width={s * 0.4} height={s * 0.1} fill="currentColor" />}
    </svg>
  )
}

/** Policy mark: shape plus code, so it never depends on colour. */
export function PolicyMark({ family, code, gated, size = 16, showCode = true, className }: PolicyMarkProps) {
  const label = `${code ?? family} — ${FAMILY_NAME[family]}${gated ? ' (gated: requires approved disclosure process)' : ''}`
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-ink', gated && 'text-ink-2', className)}
      title={label}
    >
      <PolicyShape family={family} gated={gated} size={size} />
      {showCode ? (
        <span className="t-figure text-[0.9rem] tracking-[0.01em]">
          {code ?? family}
          <span className="sr-only"> {FAMILY_NAME[family]}</span>
          {gated && <span className="sr-only"> (gated)</span>}
        </span>
      ) : (
        <span className="sr-only">{label}</span>
      )}
    </span>
  )
}

export function familyName(f: PolicyFamilyId): string {
  return FAMILY_NAME[f]
}
