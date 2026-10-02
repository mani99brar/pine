import { cn } from '@/lib/cn'

/** Flush pane with an optional header row. Panes are separated by rules, not shadows. */
export function Pane({
  title,
  actions,
  children,
  className,
  bodyClassName,
  id,
  as: As = 'section',
  description,
}: {
  title?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
  id?: string
  as?: 'section' | 'div' | 'aside'
  description?: React.ReactNode
}) {
  return (
    <As id={id} className={cn('min-w-0 border-line bg-surface', className)} aria-labelledby={title && id ? `${id}-title` : undefined}>
      {title || actions ? (
        <header className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2">
          {title ? (
            <h2 id={id ? `${id}-title` : undefined} className="stretch-cond text-[13px] font-semibold text-bark">
              {title}
            </h2>
          ) : null}
          {description ? <p className="text-xs text-muted">{description}</p> : null}
          {actions ? <div className="ml-auto flex items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn(bodyClassName)}>{children}</div>
    </As>
  )
}

/** Key/value rows. */
export function DataList({ rows, className, labelWidth = '10rem' }: { rows: { label: React.ReactNode; value: React.ReactNode; hint?: React.ReactNode }[]; className?: string; labelWidth?: string }) {
  return (
    <dl className={cn('divide-y divide-line', className)}>
      {rows.map((r, i) => (
        <div
          key={i}
          className="grid grid-cols-1 gap-x-4 gap-y-0.5 px-4 py-2.5 sm:grid-cols-[var(--lw)_1fr]"
          style={{ ['--lw' as string]: labelWidth }}
        >
          <dt className="stretch-cond text-[13px] text-muted">{r.label}</dt>
          <dd className="min-w-0 text-sm">
            {r.value}
            {r.hint ? <div className="mt-0.5 text-xs text-muted">{r.hint}</div> : null}
          </dd>
        </div>
      ))}
    </dl>
  )
}
