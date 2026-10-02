import type { ClaimStatus, Outcome } from '@pine/core'
import { OUTCOME_META, STATUS_META } from '@pine/core'
import { cn } from '@/lib/cn'

/**
 * Status glyphs: every state has a distinct shape, color and label, so state never relies on color alone.
 * YES (counterexample) is flare, NO (held) is slate, invalid is violet. NO never uses a check mark.
 */
export function statusColor(status: ClaimStatus, outcome?: Outcome) {
  if (status === 'resolved' || (status === 'settled' && outcome)) {
    if (outcome === 'yes') return 'text-flare'
    if (outcome === 'no') return 'text-slate'
    if (outcome === 'invalid') return 'text-violet'
  }
  switch (status) {
    case 'open':
      return 'text-needle'
    case 'publishing':
    case 'answer_proposed':
    case 'awaiting_answer':
      return 'text-resin'
    case 'disputed':
    case 'arbitration':
    case 'failed':
      return 'text-flare'
    default:
      return 'text-faint'
  }
}

export function StatusDot({ status, outcome, size = 10, className }: { status: ClaimStatus; outcome?: Outcome; size?: number; className?: string }) {
  const s = size
  const c = cn('shrink-0', statusColor(status, outcome), className)
  const common = { width: s, height: s, viewBox: '0 0 10 10', className: c, 'aria-hidden': true as const }
  if (status === 'resolved' || status === 'settled') {
    if (outcome === 'yes')
      return (
        <svg {...common}>
          <rect x={1} y={1} width={8} height={8} rx={1} fill="currentColor" />
        </svg>
      )
    if (outcome === 'no')
      return (
        <svg {...common}>
          <rect x={1.5} y={1.5} width={7} height={7} rx={1} fill="none" stroke="currentColor" strokeWidth={1.6} />
          <line x1={3.5} x2={6.5} y1={5} y2={5} stroke="currentColor" strokeWidth={1.6} />
        </svg>
      )
    if (outcome === 'invalid')
      return (
        <svg {...common}>
          <rect x={1.5} y={1.5} width={7} height={7} rx={1} fill="none" stroke="currentColor" strokeWidth={1.6} />
          <line x1={2} x2={8} y1={8} y2={2} stroke="currentColor" strokeWidth={1.4} />
        </svg>
      )
    return (
      <svg {...common}>
        <circle cx={5} cy={5} r={3.6} fill="none" stroke="currentColor" strokeWidth={1.5} />
      </svg>
    )
  }
  switch (status) {
    case 'open':
      return (
        <svg {...common}>
          <circle cx={5} cy={5} r={4} fill="currentColor" />
        </svg>
      )
    case 'awaiting_answer':
    case 'answer_proposed':
      return (
        <svg {...common}>
          <circle cx={5} cy={5} r={3.6} fill="none" stroke="currentColor" strokeWidth={1.5} />
          <path d="M5 1.4 A3.6 3.6 0 0 1 5 8.6 Z" fill="currentColor" />
        </svg>
      )
    case 'disputed':
    case 'arbitration':
      return (
        <svg {...common}>
          <path d="M5 1 L9.2 8.8 H0.8 Z" fill={status === 'arbitration' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" />
        </svg>
      )
    case 'publishing':
      return (
        <svg {...common}>
          <circle cx={5} cy={5} r={3.6} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="2 1.6" />
        </svg>
      )
    case 'failed':
      return (
        <svg {...common}>
          <path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <circle cx={5} cy={5} r={3.6} fill="none" stroke="currentColor" strokeWidth={1.2} strokeDasharray="1 1.4" />
        </svg>
      )
  }
}

export function statusLabel(status: ClaimStatus, outcome?: Outcome) {
  if (status === 'resolved' && outcome) return OUTCOME_META[outcome].label
  return STATUS_META[status].label
}

export function StatusBadge({
  status,
  outcome,
  className,
  size = 'sm',
}: {
  status: ClaimStatus
  outcome?: Outcome
  className?: string
  size?: 'sm' | 'md'
}) {
  const showOutcome = (status === 'resolved' || status === 'settled') && outcome
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-chip border bg-surface font-medium',
        size === 'sm' ? 'h-6 px-1.5 text-xs' : 'h-7 px-2 text-[13px]',
        showOutcome && outcome === 'yes' && 'border-flare/40 bg-flare-soft',
        showOutcome && outcome === 'no' && 'border-slate/40 bg-slate-soft',
        showOutcome && outcome === 'invalid' && 'border-violet/40 bg-violet-soft',
        !showOutcome && 'border-line-strong',
        className,
      )}
      title={STATUS_META[status].description}
    >
      <StatusDot status={status} outcome={outcome} />
      <span className="truncate">
        {status === 'settled' ? 'Settled' : null}
        {status === 'settled' && showOutcome ? ': ' : null}
        {showOutcome ? OUTCOME_META[outcome].label : status === 'settled' ? null : STATUS_META[status].label}
      </span>
    </span>
  )
}
