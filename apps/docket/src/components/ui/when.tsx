'use client'

import { useEffect, useState } from 'react'
import { formatDate, formatRelative } from '@pine/core'
import { cn } from '@/lib/cn'

/** A ticking clock that only starts after mount, so server and client HTML agree. */
export function useClientNow(intervalMs = 30_000): Date | null {
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/**
 * Absolute UTC time first (it is what binds), relative time second (it is what helps).
 */
export function When({
  at,
  style = 'long',
  relative = true,
  className,
  relClassName,
  stacked = false,
}: {
  at: string | undefined
  style?: 'short' | 'long' | 'utc'
  relative?: boolean
  className?: string
  relClassName?: string
  stacked?: boolean
}) {
  const now = useClientNow()
  if (!at) return <span className={className}>Not scheduled</span>
  return (
    <span className={cn(stacked ? 'inline-flex flex-col' : 'inline', className)}>
      <time dateTime={at} className="tabular">
        {formatDate(at, style)}
      </time>
      {relative && now ? (
        <span className={cn('text-graphite', stacked ? 'text-sm' : 'ml-1.5', relClassName)}>
          {stacked ? '' : '('}
          {formatRelative(at, now)}
          {stacked ? '' : ')'}
        </span>
      ) : null}
    </span>
  )
}

export function Relative({ at, className }: { at: string; className?: string }) {
  const now = useClientNow()
  return (
    <time dateTime={at} className={className} suppressHydrationWarning>
      {now ? formatRelative(at, now) : formatDate(at, 'short')}
    </time>
  )
}
