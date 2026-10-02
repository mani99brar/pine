'use client'

import { useSyncExternalStore } from 'react'
import { formatDate, formatRelative } from '@pine/core'
import { cn } from '@/lib/cn'

// One shared clock for the whole page, ticking every 30 seconds while anything listens.
let current: Date | null = null
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function subscribe(cb: () => void) {
  listeners.add(cb)
  if (!timer) {
    current = new Date()
    timer = setInterval(() => {
      current = new Date()
      listeners.forEach((l) => l())
    }, 30_000)
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}
function getSnapshot(): Date {
  if (!current) current = new Date()
  return current
}
function getServerSnapshot(): Date | null {
  return null
}

/**
 * The current time, or null during server rendering and hydration so server and client HTML agree.
 * Updates every 30 seconds. (The argument is kept for call-site readability.)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useClientNow(_intervalMs = 30_000): Date | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
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
