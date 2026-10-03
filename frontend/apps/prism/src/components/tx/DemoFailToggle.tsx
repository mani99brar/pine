'use client'

import { useDemoWallet } from '@pine/react'
import { Zap } from 'lucide-react'
import { useMounted } from '@/lib/hooks'
import { cn } from '@/lib/cn'

/** Reviewer control (demo mode only): the next simulated wallet prompt is rejected, to exercise recovery. */
export function DemoFailToggle({ className, compact }: { className?: string; compact?: boolean }) {
  const dw = useDemoWallet()
  const mounted = useMounted()
  if (!dw.enabled || !mounted) return null
  const armed = dw.pendingFailure !== null
  return (
    <button
      type="button"
      onClick={() => dw.failNext()}
      disabled={armed}
      aria-pressed={armed}
      title="Demo only: the next simulated transaction is rejected so you can try recovery"
      className={cn(
        'chip h-8 border-dashed',
        armed && 'border-solid border-[rgba(255,107,131,0.6)] bg-[rgba(255,107,131,0.12)] text-ha',
        className,
      )}
    >
      <Zap size={13} aria-hidden className={armed ? 'text-ha' : 'text-na'} />
      {armed ? (
        <span>
          Next <span className={compact ? 'hidden sm:inline' : ''}>transaction</span> will fail
        </span>
      ) : compact ? (
        <span>
          Fail next<span className="hidden sm:inline"> transaction</span>
        </span>
      ) : (
        'Demo: fail the next transaction'
      )}
    </button>
  )
}
