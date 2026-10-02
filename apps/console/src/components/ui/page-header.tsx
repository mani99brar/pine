import { cn } from '@/lib/cn'

/** Page title band shared by every secondary page. */
export function PageHeader({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  return (
    <header className={cn('border-b border-line bg-surface px-4 pb-5 pt-6 sm:px-8', className)}>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <h1 className="stretch-display text-[28px] font-[750] leading-[1.05] tracking-[-0.01em] sm:text-[32px]">{title}</h1>
          {description ? <p className="mt-2 max-w-[72ch] text-[14px] leading-[1.55] text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  )
}

/** A small figure: label above, value below (sentence case, proportional figures). */
export function Figure({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'default' | 'good' | 'alert' }) {
  return (
    <div className="min-w-0 bg-surface px-4 py-3">
      <dt className="text-[12.5px] text-muted">{label}</dt>
      <dd className={cn('mt-0.5 truncate text-[22px] font-semibold leading-tight', tone === 'good' && 'text-needle', tone === 'alert' && 'text-resin')}>{value}</dd>
      {hint ? <dd className="mt-0.5 text-[11.5px] text-muted">{hint}</dd> : null}
    </div>
  )
}
