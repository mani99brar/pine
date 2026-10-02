'use client'

import { setDemoTxDelays } from '@pine/react'

let applied = false

/**
 * Screenshot QA: `?qa=1` makes simulated (demo) transactions near-instant for this page load.
 * Runs once, synchronously, before any transaction runner is created. Has no effect outside demo mode.
 */
export function QaHooks() {
  if (!applied && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('qa') === '1') {
    applied = true
    setDemoTxDelays({ signatureMs: 60, pendingMs: [80, 160], offchainMs: 60, switchMs: 40, resumeAfterMs: 200 })
  }
  return null
}
