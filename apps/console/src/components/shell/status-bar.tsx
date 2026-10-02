'use client'

import * as React from 'react'
import { Keyboard } from 'lucide-react'
import { getChainOrDefault } from '@pine/core/chains'
import { usePine, useWallet, useDemoWallet } from '@pine/react'
import { cn } from '@/lib/cn'
import { useWorkbench } from './workbench'

const SOURCE_LABEL = { mock: 'Mock data', rest: 'REST indexer', envio: 'Envio indexer' } as const

export function useUtcClock() {
  const [now, setNow] = React.useState<Date | null>(null)
  React.useEffect(() => {
    setNow(new Date())
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

export function UtcClock({ className }: { className?: string }) {
  const now = useUtcClock()
  return (
    <span className={cn('mono-cond tnum text-[11px]', className)} aria-label="Current UTC time" suppressHydrationWarning>
      {now ? `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 19)} UTC` : '---------- --:--:-- UTC'}
    </span>
  )
}

export function StatusBar() {
  const { env } = usePine()
  const w = useWallet()
  const demo = useDemoWallet()
  const { setShortcutsOpen } = useWorkbench()
  const chain = getChainOrDefault(w.chainId ?? env.defaultChainId)
  return (
    <footer
      className="sticky bottom-0 z-20 hidden h-7 items-center gap-4 border-t border-line bg-sunken px-3 text-[11.5px] text-muted lg:flex"
      aria-label="Workbench status"
    >
      <span className="flex items-center gap-1.5">
        <span className={cn('size-1.5 rounded-full', env.dataSource === 'mock' ? 'bg-resin-fill' : 'bg-needle')} aria-hidden />
        {SOURCE_LABEL[env.dataSource]}
      </span>
      <span>
        {chain.name} <span className="mono-cond text-[10.5px] text-faint">{chain.id}</span>
        {!chain.verified ? <span className="ml-1.5 text-resin">unverified addresses</span> : null}
      </span>
      <span className="flex items-center gap-1.5">
        {w.isConnected && w.address ? (
          <>
            {w.isDemo ? 'Simulated wallet' : 'Wallet'} <span className="mono-cond text-[10.5px]">{w.address.slice(0, 6)}…{w.address.slice(-4)}</span>
          </>
        ) : (
          'No wallet connected'
        )}
        {demo.pendingFailure ? <span className="ml-1 rounded-chip bg-resin-soft px-1 text-resin">next transaction fails</span> : null}
      </span>
      <span className="ml-auto" />
      <UtcClock className="text-bark" />
      <button
        type="button"
        onClick={() => setShortcutsOpen(true)}
        className="flex items-center gap-1 rounded-chip px-1 hover:bg-surface hover:text-bark"
        aria-label="Keyboard shortcuts"
      >
        <Keyboard size={13} aria-hidden /> ?
      </button>
    </footer>
  )
}
