import type { HTMLAttributes, ReactNode } from 'react'
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/cn'

/** A flat sheet: the default surface. No shadow, 3px radius, 1px line. */
export function Sheet({ className, as: As = 'div', ...rest }: HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' | 'aside' | 'li' }) {
  return <As className={cn('rounded-[var(--radius-tile)] border border-line bg-sheet', className)} {...rest} />
}

export function SectionHeading({
  title,
  description,
  action,
  as: As = 'h2',
  id,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  as?: 'h1' | 'h2' | 'h3'
  id?: string
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-2', className)}>
      <div className="min-w-0 max-w-[68ch]">
        <As id={id} className={As === 'h1' ? 't-h1' : As === 'h2' ? 't-h2' : 't-h3'}>
          {title}
        </As>
        {description && <p className="mt-1.5 text-ink-2">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  )
}

/** A short caveat or fact. tone: note (neutral), caution (lumen), boundary (ink outline). */
export function Note({
  children,
  tone = 'note',
  title,
  className,
  icon,
}: {
  children: ReactNode
  tone?: 'note' | 'caution' | 'boundary'
  title?: ReactNode
  className?: string
  icon?: ReactNode
}) {
  const Icon = tone === 'caution' ? AlertTriangle : tone === 'boundary' ? ShieldAlert : Info
  return (
    <div
      className={cn(
        'flex gap-2.5 rounded-[var(--radius-tile)] px-3 py-2.5 text-[0.875rem] leading-[1.45]',
        tone === 'note' && 'bg-fog-2 text-ink-2',
        tone === 'caution' && 'border-l-[3px] border-lumen bg-lumen-wash text-ink',
        tone === 'boundary' && 'border border-line-strong bg-sheet text-ink-2',
        className,
      )}
    >
      <span className="mt-[2px] shrink-0 text-ink" aria-hidden>
        {icon ?? <Icon size={15} strokeWidth={2} />}
      </span>
      <div className="min-w-0">
        {title && <p className="font-[650] text-ink">{title}</p>}
        <div className={cn(title && 'mt-0.5')}>{children}</div>
      </div>
    </div>
  )
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span aria-hidden className={cn('skeleton block', className)} style={style} />
}

export function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="t-micro text-ink-3">{label}</dt>
      <dd className="t-figure mt-1 text-[1.45rem] text-ink">{value}</dd>
      {hint && <dd className="mt-1 text-[0.8rem] text-ink-3">{hint}</dd>}
    </div>
  )
}

/** Key/value rows for terms and refs */
export function KV({ rows, className }: { rows: { k: ReactNode; v: ReactNode; key?: string }[]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-1 gap-x-6 sm:grid-cols-[minmax(9rem,auto)_1fr]', className)}>
      {rows.map((r, i) => (
        <div key={r.key ?? i} className="contents">
          <dt className="pt-2.5 text-[0.84rem] text-ink-3 sm:border-t sm:border-line sm:pb-2.5">{r.k}</dt>
          <dd className="min-w-0 pb-2.5 text-[0.92rem] sm:border-t sm:border-line sm:pt-2.5">{r.v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.4em] items-center justify-center rounded-[3px] border border-line-strong bg-sheet px-1 font-sans text-[0.75rem] font-[600] text-ink-2">
      {children}
    </kbd>
  )
}

export function Dot({ className }: { className?: string }) {
  return <span aria-hidden className={cn('inline-block h-1.5 w-1.5 rounded-full bg-current', className)} />
}
