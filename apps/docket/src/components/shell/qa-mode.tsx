'use client'

import { useEffect } from 'react'
import { setDemoTxDelays } from '@pine/react'

/**
 * `?qa=1` makes simulated transactions near-instant for screenshot runs. It only affects the demo
 * wallet and is remembered for the browser session.
 */
export function QaMode() {
  useEffect(() => {
    try {
      const on = new URLSearchParams(window.location.search).get('qa') === '1' || window.sessionStorage.getItem('docket:qa') === '1'
      if (!on) return
      window.sessionStorage.setItem('docket:qa', '1')
      setDemoTxDelays({ signatureMs: 60, pendingMs: [80, 120], offchainMs: 40, switchMs: 40 })
    } catch {
      /* storage unavailable */
    }
  }, [])
  return null
}
