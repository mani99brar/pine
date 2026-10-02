'use client'

import { Check, Copy } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'

export function useClipboard(timeout = 1600) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
      }
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), timeout)
    },
    [timeout],
  )
  return { copy, copied }
}

export function CopyButton({
  value,
  label = 'Copy',
  className,
  showLabel = false,
}: {
  value: string
  label?: string
  className?: string
  showLabel?: boolean
}) {
  const { copy, copied } = useClipboard()
  return (
    <button
      type="button"
      onClick={() => void copy(value)}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-xs px-1.5 py-1 text-sm font-bold text-violet hover:bg-violet-wash print:hidden',
        className,
      )}
      aria-label={showLabel ? undefined : `${label}${copied ? ' (copied)' : ''}`}
    >
      {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
      {showLabel ? <span>{copied ? 'Copied' : label}</span> : null}
      <span aria-live="polite" className="sr-only">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </button>
  )
}

/** A value compared character by character: monospaced, wraps, with a copy action. */
export function HashValue({
  value,
  display,
  label,
  className,
  wrap = false,
}: {
  value: string
  display?: string
  label?: string
  className?: string
  wrap?: boolean
}) {
  return (
    <span className={cn('inline-flex max-w-full items-center gap-0.5 align-middle', className)}>
      <code
        title={value}
        className={cn(
          'min-w-0 font-mono text-[0.92em] text-ink',
          wrap ? 'break-all' : 'truncate',
        )}
      >
        {display ?? value}
      </code>
      <CopyButton value={value} label={label ? `Copy ${label}` : 'Copy value'} className="-my-1" />
    </span>
  )
}
