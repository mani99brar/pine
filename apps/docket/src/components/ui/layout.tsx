import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** Standard page frame: generous gutter, max width for the sheet + margin layout. */
export function Page({ children, className, width = 'wide' }: { children: ReactNode; className?: string; width?: 'wide' | 'narrow' }) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className={cn(
        'mx-auto w-full px-4 pt-8 pb-20 outline-none sm:px-6 lg:px-10 lg:pt-10',
        width === 'wide' ? 'max-w-[86rem]' : 'max-w-[60rem]',
        className,
      )}
    >
      {children}
    </main>
  )
}

export interface Crumb {
  href?: string
  label: string
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4 print:hidden">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-graphite">
        {items.map((c, i) => (
          <li key={`${c.label}-${i}`} className="flex min-w-0 items-center gap-1">
            {i > 0 ? <ChevronRight aria-hidden className="size-3.5" /> : null}
            {c.href ? (
              <Link href={c.href} className="link text-graphite!">
                {c.label}
              </Link>
            ) : (
              <span aria-current="page" className="block max-w-[15rem] truncate font-bold text-ink sm:max-w-[40rem]">
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

export function PageHeader({
  title,
  lead,
  crumbs,
  actions,
  meta,
  className,
}: {
  title: ReactNode
  lead?: ReactNode
  crumbs?: Crumb[]
  actions?: ReactNode
  meta?: ReactNode
  className?: string
}) {
  return (
    <header className={cn('mb-8 lg:mb-10', className)}>
      {crumbs ? <Breadcrumbs items={crumbs} /> : null}
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 max-w-[48rem]">
          <h1 className="text-[2rem] leading-[2.4rem] tracking-[var(--tracking-display)] sm:text-3xl">{title}</h1>
          {lead ? <div className="mt-3 text-lg text-graphite measure">{lead}</div> : null}
          {meta ? <div className="mt-3">{meta}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-3 print:hidden">{actions}</div> : null}
      </div>
    </header>
  )
}

/** A white sheet resting on the bond canvas. Square corners, ruled border, no shadow. */
export function Sheet({
  children,
  className,
  as: As = 'section',
  ...rest
}: {
  children: ReactNode
  className?: string
  as?: 'section' | 'div' | 'article' | 'aside'
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <As className={cn('border border-rule bg-sheet', className)} data-print="flat" {...rest}>
      {children}
    </As>
  )
}

/** Section heading with an optional supporting line and right-hand action. */
export function SectionHeading({
  id,
  title,
  description,
  action,
  level = 2,
  className,
}: {
  id?: string
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  level?: 2 | 3
  className?: string
}) {
  const H = level === 2 ? 'h2' : 'h3'
  return (
    <div className={cn('mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-2', className)}>
      <div className="min-w-0 max-w-[44rem]">
        <H id={id} className={level === 2 ? 'text-2xl' : 'text-xl'}>
          {title}
        </H>
        {description ? <p className="mt-1 text-graphite">{description}</p> : null}
      </div>
      {action ? <div className="print:hidden">{action}</div> : null}
    </div>
  )
}

/** Definition list in two columns: term | value. Used for "terms on record". */
export function DefinitionList({
  items,
  className,
}: {
  items: { term: ReactNode; value: ReactNode; note?: ReactNode }[]
  className?: string
}) {
  return (
    <dl className={cn('divide-y divide-rule border-y border-rule', className)}>
      {items.map((it, i) => (
        <div key={i} className="grid gap-x-6 gap-y-1 py-3 sm:grid-cols-[13rem_minmax(0,1fr)]">
          <dt className="text-sm font-bold text-graphite">{it.term}</dt>
          <dd className="min-w-0">
            <div className="min-w-0">{it.value}</div>
            {it.note ? <p className="mt-1 text-sm text-graphite">{it.note}</p> : null}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn('skeleton block h-4', className)} />
}

export function EmptyState({
  title,
  children,
  action,
  className,
  icon,
}: {
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
  className?: string
  icon?: ReactNode
}) {
  return (
    <div className={cn('border border-dashed border-rule-strong bg-sheet px-6 py-10 text-center', className)}>
      {icon ? <div className="mx-auto mb-3 flex justify-center text-graphite">{icon}</div> : null}
      <p className="text-lg font-bold">{title}</p>
      {children ? <div className="mx-auto mt-2 max-w-[42ch] text-graphite">{children}</div> : null}
      {action ? <div className="mt-5 flex flex-wrap justify-center gap-3">{action}</div> : null}
    </div>
  )
}
