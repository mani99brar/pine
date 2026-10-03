import type { ClaimStatus, Outcome } from '@pine/core'
import { OutcomeIcon } from '@/components/icons'
import { statusColor, statusLabel, isResolved } from '@/lib/claims'
import { cn } from '@/lib/cn'

/** Status with a light glyph. The label always carries the meaning; color only reinforces it. */
export function StatusBadge({ status, outcome, className, size = 'md' }: { status: ClaimStatus; outcome?: Outcome; className?: string; size?: 'sm' | 'md' }) {
  const color = statusColor(status, outcome)
  const resolved = isResolved(status) && outcome
  return (
    <span
      className={cn('tag gap-1.5', size === 'md' ? 'px-2 py-0.5 text-[0.8125rem]' : 'text-[0.75rem]', className)}
      style={{ borderColor: `color-mix(in oklab, ${color} 45%, transparent)`, color: status === 'settled' || status === 'failed' ? 'var(--lumen-2)' : 'var(--lumen)' }}
    >
      {resolved ? (
        <OutcomeIcon outcome={outcome} size={size === 'md' ? 14 : 12} style={{ color }} />
      ) : (
        <span aria-hidden className="relative inline-flex h-2 w-2">
          {/* Live: a soft breathing halo (the light-table pulse), not a generic radar ping. */}
          {status === 'open' && <span className="absolute -inset-[3px] animate-[glow-pulse_2.4s_ease-in-out_infinite] rounded-full opacity-60 blur-[3px]" style={{ background: color }} />}
          <span className="relative h-2 w-2 rounded-full" style={{ background: color, boxShadow: status === 'failed' ? undefined : `0 0 8px ${color}` }} />
        </span>
      )}
      {statusLabel(status, outcome)}
      {status === 'settled' && <span className="text-lumen-3">settled</span>}
    </span>
  )
}
