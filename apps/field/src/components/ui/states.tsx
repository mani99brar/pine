'use client'

import type { ReactNode } from 'react'
import { RotateCw } from 'lucide-react'
import { Button } from './Button'
import { cn } from '@/lib/cn'

/** Empty state: always gives a direction. The "empty field" mark is a dashed tension bar with no knot. */
export function EmptyState({
  title,
  body,
  action,
  className,
}: {
  title: ReactNode
  body?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('rounded-[var(--radius-tile)] border border-dashed border-line-strong px-6 py-10 sm:px-10', className)}>
      <div aria-hidden className="mb-5 flex h-3 max-w-[14rem] items-center">
        <span className="h-5 w-[2px] bg-ink-3" />
        <span className="h-2.5 flex-1 border border-dashed border-line-strong" />
        <span className="h-5 w-[2px] bg-ink-3" />
      </div>
      <p className="t-h3">{title}</p>
      {body && <div className="mt-1.5 max-w-[60ch] text-ink-2">{body}</div>}
      {action && <div className="mt-5 flex flex-wrap gap-2">{action}</div>}
    </div>
  )
}

/** Error state: says what failed and how to fix it. */
export function ErrorState({
  title = 'This could not be loaded',
  error,
  onRetry,
  className,
  children,
}: {
  title?: ReactNode
  error?: unknown
  onRetry?: () => void
  className?: string
  children?: ReactNode
}) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined
  return (
    <div role="alert" className={cn('rounded-[var(--radius-tile)] border-l-[3px] border-flare-ink bg-sheet px-5 py-5', className)}>
      <p className="t-h3">{title}</p>
      {message && <p className="untrusted mt-1 text-[0.9rem] text-ink-2">{message}</p>}
      {children}
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry} icon={<RotateCw size={14} aria-hidden />}>
          Try again
        </Button>
      )}
    </div>
  )
}
