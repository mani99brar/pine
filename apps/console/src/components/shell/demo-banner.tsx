'use client'

import * as React from 'react'
import { FlaskConical, X, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { COPY } from '@pine/core/copy'
import { useDemoWallet, usePine } from '@pine/react'
import { readLocal, writeLocal } from '@/lib/storage'

const KEY = 'pine-console:demo-banner-dismissed'

export function DemoBanner() {
  const { demo } = usePine()
  const wallet = useDemoWallet()
  const [dismissed, setDismissed] = React.useState(true)
  React.useEffect(() => setDismissed(readLocal(KEY, false)), [])
  if (!demo || dismissed) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-resin/40 bg-resin-soft px-3 py-1.5 text-[12.5px] sm:px-4" role="region" aria-label="Demo mode">
      <FlaskConical size={14} aria-hidden className="shrink-0 text-resin" />
      <p className="min-w-0 flex-1 text-bark">{COPY.demoMode}</p>
      <button
        type="button"
        onClick={() => {
          wallet.failNext()
          toast('The next simulated transaction will fail', { description: 'Publish or submit evidence to exercise retry and recovery.' })
        }}
        className="flex h-6 items-center gap-1 rounded-ctl border border-resin/50 bg-surface px-2 text-xs font-medium text-bark hover:border-resin"
        aria-pressed={!!wallet.pendingFailure}
      >
        <Zap size={12} aria-hidden className="text-resin" />
        {wallet.pendingFailure ? 'Next transaction will fail' : 'Simulate failure on next transaction'}
      </button>
      <button
        type="button"
        onClick={() => {
          writeLocal(KEY, true)
          setDismissed(true)
        }}
        className="rounded-chip p-1 text-muted hover:bg-surface hover:text-bark"
        aria-label="Dismiss demo banner"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  )
}
