'use client'

import { createContext, useContext } from 'react'
import type { DraftStore, ManifestStorage, PineDataProvider, PineEnv } from '@pine/data'

export interface PineContextValue {
  env: PineEnv
  data: PineDataProvider
  storage: ManifestStorage
  drafts: DraftStore
  /** Demo mode: simulated wallet and transactions (NEXT_PUBLIC_PINE_DEMO_WALLET=1 or data source "mock") */
  demo: boolean
  appName: string
  /** Base path for the app's API routes (default ""). */
  apiBase: string
}

export const PineContext = createContext<PineContextValue | null>(null)

export function usePine(): PineContextValue {
  const ctx = useContext(PineContext)
  if (!ctx) {
    throw new Error('usePine() must be used inside <PineProviders>. Wrap your root layout with PineProviders from @pine/react.')
  }
  return ctx
}

export function isDemoEnv(env: PineEnv): boolean {
  return env.demoWallet || env.dataSource === 'mock'
}
