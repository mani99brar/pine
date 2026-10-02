'use client'

import { cn } from '@/lib/cn'
import { useComposerCtx, sectionForPath, type SectionId } from './context'

export function Section({
  id,
  index,
  title,
  description,
  children,
  aside,
}: {
  id: SectionId
  index: number
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  aside?: React.ReactNode
}) {
  const { c, showAll, touched } = useComposerCtx()
  const issues = c.validation.issues.filter((i) => sectionForPath(i.path) === id)
  const engaged = showAll || [...touched].some((p) => sectionForPath(p) === id)
  return (
    <section id={`sec-${id}`} data-section={id} aria-labelledby={`sec-${id}-h`} className="scroll-mt-16 border-b border-line px-4 py-7 sm:px-8">
      <header className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="mono-cond tnum text-[12px] text-faint" aria-hidden>
          {String(index).padStart(2, '0')}
        </span>
        <h2 id={`sec-${id}-h`} className="stretch-wide text-[19px] font-[650] leading-tight">
          {title}
        </h2>
        <span
          className={cn(
            'text-[12px]',
            issues.length === 0 ? 'text-needle' : engaged ? 'text-flare' : 'text-muted',
          )}
        >
          {issues.length === 0 ? 'complete' : `${issues.length} to resolve`}
        </span>
        {aside ? <span className="ml-auto">{aside}</span> : null}
        {description ? <p className="basis-full text-[13.5px] leading-[1.5] text-muted">{description}</p> : null}
      </header>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  )
}
