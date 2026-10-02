'use client'

import { useDemoWallet } from '@pine/react'
import { cn } from '@/lib/cn'

/** Reviewer control next to every transaction run in demo mode: make the next simulated tx fail. */
export function DemoFailToggle({ className }: { className?: string }) {
  const dw = useDemoWallet()
  if (!dw.enabled) return null
  const armed = dw.pendingFailure !== null
  return (
    <button
      type="button"
      onClick={() => dw.failNext()}
      disabled={armed}
      aria-pressed={armed}
      className={cn(
        'inline-flex h-8 items-center gap-2 rounded-full border-[1.5px] border-dashed border-ink/50 px-3 text-[0.8rem] font-[620] text-ink-2 hover:border-ink hover:text-ink disabled:border-solid disabled:border-ink disabled:bg-lumen-wash disabled:text-ink',
        className,
      )}
      title="Demo only: the next simulated transaction will be rejected so you can try recovery"
    >
      <span aria-hidden className={armed ? 'h-2 w-2 rounded-full bg-lumen shadow-[0_0_0_1.5px_var(--ink)]' : 'h-2 w-2 rounded-full border-[1.5px] border-current'} />
      {armed ? 'Next transaction will fail' : 'Demo: fail the next transaction'}
    </button>
  )
}

