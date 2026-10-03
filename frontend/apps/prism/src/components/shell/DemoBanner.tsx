'use client'

import { useSyncExternalStore } from 'react'
import { usePine } from '@pine/react'
import { COPY } from '@pine/core/copy'
import { X } from 'lucide-react'
import { DemoFailToggle } from '@/components/tx/DemoFailToggle'

const KEY = 'pine-prism:demo-banner-hidden'
const listeners = new Set<() => void>()
function readHidden(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}
function setHidden(v: boolean) {
  try {
    localStorage.setItem(KEY, v ? '1' : '0')
  } catch {
    /* storage unavailable: hidden for this view only */
  }
  memory = v
  listeners.forEach((l) => l())
}
let memory: boolean | null = null
const store = {
  subscribe(cb: () => void) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  get: () => memory ?? readHidden(),
}

/** Persistent, dismissible demo-mode strip with the "fail the next transaction" reviewer control. Never in `api` mode. */
export function DemoBanner() {
  const { demo, env } = usePine()
  const hidden = useSyncExternalStore(store.subscribe, store.get, () => false)
  if (!demo || env.dataSource === 'api' || hidden) return null
  return (
    <div className="relative z-[61] border-b border-edge bg-[#1c1512]">
      <span aria-hidden className="absolute inset-y-0 left-0 w-24 bg-[linear-gradient(90deg,rgba(255,182,72,0.22),transparent)]" />
      <div className="relative mx-auto flex max-w-[1440px] items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6 lg:px-8">
        <p className="min-w-0 flex-1 text-[0.8125rem] leading-[1.4] text-lumen-2 sm:text-[0.84375rem]">
          <span className="tag mr-2 border-[rgba(255,182,72,0.45)] text-na">Demo</span>
          <span className="hidden sm:inline">{COPY.demoMode}</span>
          <span className="sm:hidden">Sample data and a simulated wallet. No real funds move.</span>
        </p>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <DemoFailToggle compact />
          <button
            type="button"
            onClick={() => setHidden(true)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] text-lumen-3 hover:bg-smoke-3 hover:text-lumen"
            aria-label="Hide the demo notice"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  )
}
