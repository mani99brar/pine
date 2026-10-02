import type { ClaimStatus, Outcome } from '@pine/core'
import { OUTCOME_META, STATUS_META } from '@pine/core'
import {
  Archive,
  CircleSlash,
  Flag,
  Hourglass,
  Loader,
  MessageSquareQuote,
  PencilLine,
  Scale,
  Swords,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/cn'

const ICON: Record<ClaimStatus, LucideIcon | null> = {
  draft: PencilLine,
  publishing: Loader,
  open: null,
  awaiting_answer: Hourglass,
  answer_proposed: MessageSquareQuote,
  disputed: Swords,
  arbitration: Scale,
  resolved: Flag,
  settled: Archive,
  failed: CircleSlash,
}

const TONE: Record<string, string> = {
  active: 'bg-ink text-on-ink',
  neutral: 'bg-fog-2 text-ink',
  warning: 'bg-lumen-wash text-ink shadow-[inset_0_0_0_1.5px_var(--lumen)]',
  critical: 'bg-sheet text-ink shadow-[inset_0_0_0_2px_var(--ink)]',
  muted: 'bg-transparent text-ink-2 shadow-[inset_0_0_0_1px_var(--line-strong)]',
}

/** Lifecycle status pill. Icons carry meaning alongside the label. */
export function StatusPill({ status, outcome, className, size = 'md' }: { status: ClaimStatus; outcome?: Outcome; className?: string; size?: 'sm' | 'md' }) {
  const meta = STATUS_META[status]
  const Icon = ICON[status]
  const label = status === 'resolved' && outcome ? `Resolved` : meta.label
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-[620]',
        size === 'sm' ? 'h-6 px-2 text-[0.75rem]' : 'h-7 px-2.5 text-[0.8rem]',
        TONE[meta.tone],
        className,
      )}
      title={meta.description}
    >
      {status === 'open' ? (
        <span aria-hidden className="relative inline-flex h-2 w-2">
          <span className="absolute inset-0 animate-ping rounded-full bg-lumen opacity-70 motion-reduce:hidden" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-lumen" />
        </span>
      ) : (
        Icon && <Icon size={size === 'sm' ? 12 : 13} strokeWidth={2.2} aria-hidden className={status === 'publishing' ? 'motion-safe:animate-[spin_2.4s_linear_infinite]' : undefined} />
      )}
      {label}
    </span>
  )
}

/** Swatch that matches the tension-bar treatment for an outcome. */
export function OutcomeSwatch({ outcome, className }: { outcome: Outcome | 'yes' | 'no'; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block h-3 w-3 shrink-0 rounded-[2px]',
        outcome === 'yes' && 'hatch-yes',
        outcome === 'no' && 'bg-cobalt',
        outcome === 'invalid' && 'hatch-invalid',
        className,
      )}
    />
  )
}

/** Outcome label with swatch: "Counterexample demonstrated" / "No qualifying counterexample submitted" / "Resolved invalid". */
export function OutcomeLabel({ outcome, className, long }: { outcome: Outcome; className?: string; long?: boolean }) {
  const meta = OUTCOME_META[outcome]
  return (
    <span className={cn('inline-flex items-start gap-2', className)}>
      <OutcomeSwatch outcome={outcome} className="mt-[0.3em]" />
      <span>
        <span
          className={cn(
            'font-[650]',
            outcome === 'yes' && 'text-flare-ink',
            outcome === 'no' && 'text-cobalt-ink',
            outcome === 'invalid' && 'text-ink-2',
          )}
        >
          {meta.label}
        </span>
        {long && <span className="mt-0.5 block text-[0.88rem] text-ink-2">{meta.long}</span>}
      </span>
    </span>
  )
}
