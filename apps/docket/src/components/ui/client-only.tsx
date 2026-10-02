'use client'

import type { ReactNode } from 'react'
import { useMounted } from '@/lib/use-mounted'

/**
 * Renders children only in the browser. For views that depend on browser-only state (session mirror,
 * simulated wallet, local drafts), so the server HTML never disagrees with the first client render.
 */
export function ClientOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const mounted = useMounted()
  return <>{mounted ? children : fallback}</>
}
