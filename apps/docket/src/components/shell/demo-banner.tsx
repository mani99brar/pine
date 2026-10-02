'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Popover } from 'radix-ui'
import { FlaskConical, X } from 'lucide-react'
import { toast } from 'sonner'
import { useDemoWallet, usePine } from '@pine/react'
import { COPY } from '@pine/core/copy'

const KEY = 'docket:demo-banner-dismissed'
const EVENT = 'docket:demo-banner'

function readDismissed() {
  try {
    return window.localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}

export function setDemoBannerDismissed(v: boolean) {
  try {
    if (v) window.localStorage.setItem(KEY, '1')
    else window.localStorage.removeItem(KEY)
  } catch {
    /* storage unavailable: banner just stays visible */
  }
  window.dispatchEvent(new Event(EVENT))
}

export function useDemoBannerDismissed() {
  return useSyncExternalStore(subscribe, readDismissed, () => false)
}

export function DemoBanner() {
  const { demo } = usePine()
  const dismissed = useDemoBannerDismissed()
  if (!demo || dismissed) return null
  return (
    <div className="border-b border-wheat-line bg-flag-wash print:hidden" role="region" aria-label="Demo mode">
      <div className="mx-auto flex max-w-[86rem] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6 lg:px-10">
        <span className="inline-flex items-center gap-1.5 rounded-xs bg-flag px-2 py-0.5 text-sm font-[800] text-ink">
          <FlaskConical aria-hidden className="size-4" /> Demo
        </span>
        <p className="min-w-0 flex-1 text-sm leading-5 text-ink">
          <span className="hidden sm:inline">{COPY.demoMode} </span>
          <span className="sm:hidden">Sample data and a simulated wallet. No real funds move.</span>
        </p>
        <div className="flex items-center gap-2">
          <ReviewerControls />
          <button
            type="button"
            onClick={() => setDemoBannerDismissed(true)}
            className="inline-flex h-8 items-center gap-1 rounded-xs px-2 text-sm font-bold hover:bg-flag"
            aria-label="Hide demo banner"
          >
            <X aria-hidden className="size-4" />
            <span className="hidden md:inline">Hide</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export function ReviewerControls({ label = 'Reviewer controls' }: { label?: string }) {
  const demoWallet = useDemoWallet()
  const { data } = usePine()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted || !demoWallet.enabled) return null
  const resettable = data as unknown as { reset?: () => void }
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="inline-flex h-8 items-center rounded-xs border border-ochre/40 bg-sheet px-2.5 text-sm font-bold text-ink hover:bg-wheat"
        >
          {label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[min(22rem,calc(100vw-2rem))] border border-rule bg-sheet p-4 shadow-[0_8px_24px_rgba(26,29,43,0.16)]"
        >
          <p className="font-bold">Reviewer controls</p>
          <p className="mt-1 text-sm text-graphite">
            These exist only in demo mode, so reviewers can exercise failure and recovery paths.
          </p>
          <div className="mt-4 space-y-3">
            <div>
              <button
                type="button"
                className="inline-flex h-9 w-full items-center justify-center rounded-sm bg-ink px-3 text-sm font-bold text-white hover:bg-[#2c3044]"
                onClick={() => {
                  demoWallet.failNext()
                  toast('The next simulated transaction will fail', {
                    description: 'Use it to see how a filing or exhibit recovers from a rejected step.',
                  })
                }}
              >
                Simulate failure on next transaction
              </button>
              <p className="mt-1 text-xs text-graphite">
                The wallet rejects the next transaction it is asked to sign. The step can then be retried.
              </p>
            </div>
            <div className="text-sm">
              <p>
                Simulated wallet:{' '}
                {demoWallet.address ? <code className="font-mono text-[13px]">{demoWallet.address}</code> : 'not connected'}
              </p>
              {demoWallet.address ? (
                <button type="button" className="link mt-1" onClick={() => demoWallet.disconnect()}>
                  Disconnect simulated wallet
                </button>
              ) : (
                <button type="button" className="link mt-1" onClick={() => demoWallet.connect()}>
                  Connect simulated wallet
                </button>
              )}
            </div>
            {typeof resettable.reset === 'function' ? (
              <button
                type="button"
                className="link text-sm"
                onClick={() => {
                  resettable.reset?.()
                  toast('Demo data reset', { description: 'Claims you filed in this browser were removed.' })
                }}
              >
                Reset demo data in this browser
              </button>
            ) : null}
          </div>
          <Popover.Arrow className="fill-sheet" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
