'use client'

import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'

export function useClipboard(timeout = 1400) {
  const [copied, setCopied] = React.useState(false)
  const copy = React.useCallback(
    async (text: string, label?: string) => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        if (label) toast.success(`Copied ${label}`)
        window.setTimeout(() => setCopied(false), timeout)
      } catch {
        toast.error('Clipboard is unavailable in this browser context')
      }
    },
    [timeout],
  )
  return { copy, copied }
}

export function CopyButton({
  value,
  label,
  className,
  size = 14,
  children,
}: {
  value: string
  /** Used in the toast and the accessible name: "Copy {label}" */
  label: string
  className?: string
  size?: number
  children?: React.ReactNode
}) {
  const { copy, copied } = useClipboard()
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        void copy(value, label)
      }}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-chip p-1 text-muted transition-colors hover:bg-sunken hover:text-bark',
        copied && 'text-needle',
        className,
      )}
    >
      {copied ? <Check size={size} aria-hidden /> : <Copy size={size} aria-hidden />}
      {children}
    </button>
  )
}
