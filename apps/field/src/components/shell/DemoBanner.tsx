'use client'

import { useSyncExternalStore } from 'react'
import { FlaskConical, X } from 'lucide-react'
import { COPY } from '@pine/core/copy'
import { useDemoWallet, usePine } from '@pine/react'

const KEY = 'pine-field:demo-banner-dismissed'
const listeners = new Set<() => void>()

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function dismiss() {
  try {
    sessionStorage.setItem(KEY, '1')
  } catch {
    /* storage unavailable: dismiss for this render only */
  }
  listeners.forEach((l) => l())
}

/**
 * Demo strip: says plainly that data is sample data and the wallet is simulated, and offers the
 * reviewer control to make the next simulated transaction fail (to exercise recovery).
 */
export function DemoBanner() {
  const { demo } = usePine()
  const dw = useDemoWallet()
  const dismissed = useSyncExternalStore(subscribe, readDismissed, () => false)
  if (!demo || dismissed) return null

  const armed = dw.pendingFailure !== null
  return (
    <div role="region" aria-label="Demo mode" className="border-b border-ink/20 bg-lumen text-[#161a33]">
      <div className="mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 text-[0.8rem] sm:gap-x-4 sm:px-6 sm:text-[0.84rem]">
        <FlaskConical size={15} aria-hidden className="shrink-0" />
        <p className="min-w-0 flex-1 basis-[12rem] font-[550]">
          <span className="sm:hidden">Demo mode: sample data, simulated wallet, no real funds.</span>
          <span className="hidden sm:inline">{COPY.demoMode}</span>
        </p>
        <button
          type="button"
          onClick={() => dw.failNext()}
          disabled={armed}
          aria-pressed={armed}
          className="inline-flex h-7 items-center gap-1.5 rounded-full border-[1.5px] border-[#161a33] px-2.5 font-[650] hover:bg-[#161a33]/10 disabled:bg-[#161a33] disabled:text-[#ffc21a]"
        >
          <span aria-hidden className={armed ? 'h-2 w-2 rounded-full bg-[#ffc21a]' : 'h-2 w-2 rounded-full border-[1.5px] border-[#161a33]'} />
          {armed ? 'Next transaction will fail' : (
            <>
              <span className="sm:hidden">Fail next transaction</span>
              <span className="hidden sm:inline">Simulate a failure on the next transaction</span>
            </>
          )}
        </button>
        <button type="button" onClick={dismiss} className="-mr-1.5 inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-[#161a33]/10" aria-label="Dismiss demo notice">
          <X size={15} aria-hidden />
        </button>
      </div>
    </div>
  )
}
