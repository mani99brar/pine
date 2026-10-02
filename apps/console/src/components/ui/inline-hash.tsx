'use client'

import { cn } from '@/lib/cn'
import { useClipboard } from './copy-button'

/** A long hex value shown shortened inline; click copies the full value. */
export function InlineHash({ value, className }: { value: string; className?: string }) {
  const { copy, copied } = useClipboard()
  const short = `${value.slice(0, value.startsWith('0x') ? 6 : 7)}…${value.slice(-4)}`
  return (
    <button
      type="button"
      onClick={() => void copy(value, 'hash')}
      title={`${value} (click to copy)`}
      aria-label={`Copy ${value}`}
      className={cn('rounded-[2px] underline decoration-dotted underline-offset-2 hover:text-needle', copied && 'text-needle', className)}
    >
      {short}
    </button>
  )
}
