import { cn } from '@/lib/cn'

/** Empty and error states say what happened and what to do next. */
export function EmptyState({
  title,
  children,
  action,
  icon,
  className,
  tone = 'neutral',
}: {
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
  icon?: React.ReactNode
  className?: string
  tone?: 'neutral' | 'error'
}) {
  return (
    <div className={cn('flex flex-col items-start gap-3 px-6 py-10 sm:px-10', className)} role={tone === 'error' ? 'alert' : undefined}>
      {icon ? <div className={cn('text-faint', tone === 'error' && 'text-flare')}>{icon}</div> : null}
      <div className="max-w-[56ch]">
        <h3 className="text-base font-semibold">{title}</h3>
        {children ? <div className="mt-1 text-sm text-muted">{children}</div> : null}
      </div>
      {action ? <div className="flex flex-wrap gap-2">{action}</div> : null}
    </div>
  )
}
