'use client'

import { usePine } from '@pine/react'
import { setDemoBannerDismissed, useDemoBannerDismissed } from './demo-banner'

export function DemoBannerRestore() {
  const { demo } = usePine()
  const dismissed = useDemoBannerDismissed()
  if (!demo || !dismissed) return null
  return (
    <button type="button" className="link" onClick={() => setDemoBannerDismissed(false)}>
      Show the demo banner and reviewer controls
    </button>
  )
}
