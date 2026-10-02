import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** A titled section that can fold away. Opens automatically when printing. */
export function Collapsible({
  title,
  summary,
  children,
  defaultOpen = false,
  className,
}: {
  title: ReactNode
  summary?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
}) {
  return (
    <details className={cn('group border-t border-rule', className)} open={defaultOpen}>
      <summary className="flex cursor-pointer items-start justify-between gap-4 py-4 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-xl font-bold">{title}</span>
          {summary ? <span className="mt-0.5 block text-[15px] text-graphite">{summary}</span> : null}
        </span>
        <span className="mt-1 inline-flex shrink-0 items-center gap-1 text-sm font-bold text-violet print:hidden">
          <span className="group-open:hidden">Show</span>
          <span className="hidden group-open:inline">Hide</span>
          <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="pb-6">{children}</div>
    </details>
  )
}
