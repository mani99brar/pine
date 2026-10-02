import type { ClaimStatus, Outcome } from '@pine/core'
import { Ban, CircleDot, Gavel, Hourglass, Minus, Scale, TriangleAlert, X, FileWarning, Archive, FilePen } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { stageView, TONE_CLASSES, type StageTone } from '@/lib/stage'

const ICONS = { TriangleAlert, Minus, Ban, CircleDot, Hourglass, Scale, Gavel, FileWarning, X, Archive, FilePen } as const
type IconName = keyof typeof ICONS

function iconName(status: ClaimStatus, outcome?: Outcome): IconName {
  if (status === 'resolved' && outcome === 'yes') return 'TriangleAlert'
  if (status === 'resolved' && outcome === 'no') return 'Minus'
  if (status === 'resolved' && outcome === 'invalid') return 'Ban'
  switch (status) {
    case 'awaiting_answer':
    case 'answer_proposed':
      return 'Hourglass'
    case 'disputed':
      return 'Scale'
    case 'arbitration':
      return 'Gavel'
    case 'publishing':
      return 'FileWarning'
    case 'failed':
      return 'X'
    case 'settled':
      return 'Archive'
    case 'draft':
      return 'FilePen'
    default:
      return 'CircleDot'
  }
}

/** The icon for a stage, chosen from a fixed set. */
export function StageIcon({ name, className }: { name: IconName; className?: string }) {
  const Icon = ICONS[name]
  return <Icon aria-hidden className={className} strokeWidth={2.5} />
}

/** Compact stage tag for lists. Sentence case, colored left edge. */
export function StageTag({
  status,
  outcome,
  short = true,
  className,
}: {
  status: ClaimStatus
  outcome?: Outcome
  short?: boolean
  className?: string
}) {
  const v = stageView(status, outcome)
  const t = TONE_CLASSES[v.tone]
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-xs border py-0.5 pr-2 pl-1.5 text-sm leading-5 font-bold',
        t.wash,
        t.border,
        t.text,
        className,
      )}
    >
      <StageIcon name={iconName(status, outcome)} className="size-3.5 shrink-0" />
      <span className="truncate">{short ? v.short : v.label}</span>
    </span>
  )
}

/** Full-width status band: thick colored bar on the left, label and optional detail. */
export function StageBand({
  status,
  outcome,
  children,
  className,
  size = 'md',
}: {
  status: ClaimStatus
  outcome?: Outcome
  children?: ReactNode
  className?: string
  size?: 'md' | 'lg'
}) {
  const v = stageView(status, outcome)
  return (
    <ToneBand tone={v.tone} className={className} size={size} label={v.label} iconName={iconName(status, outcome)}>
      {children}
    </ToneBand>
  )
}

export function ToneBand({
  tone,
  label,
  iconName: icon,
  children,
  className,
  size = 'md',
}: {
  tone: StageTone
  label: ReactNode
  iconName?: IconName
  children?: ReactNode
  className?: string
  size?: 'md' | 'lg'
}) {
  const t = TONE_CLASSES[tone]
  return (
    <div className={cn('relative flex border', t.wash, t.border, className)}>
      <span aria-hidden className={cn('w-2 shrink-0', t.bar)} />
      <div className={cn('min-w-0 flex-1', size === 'lg' ? 'px-5 py-4' : 'px-4 py-3')}>
        <p className={cn('flex items-center gap-2 font-bold', t.text, size === 'lg' ? 'text-lg' : 'text-base')}>
          {icon ? <StageIcon name={icon} className={size === 'lg' ? 'size-5 shrink-0' : 'size-4 shrink-0'} /> : null}
          {label}
        </p>
        {children ? <div className="mt-1 text-ink">{children}</div> : null}
      </div>
    </div>
  )
}

/** Small dot used in timelines and legends. */
export function ToneDot({ tone, className }: { tone: StageTone; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2.5 rounded-full', TONE_CLASSES[tone].dot, className)} />
}
