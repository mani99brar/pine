'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { SessionContext, SessionProvider } from 'next-auth/react'
import type { Session } from 'next-auth'
import { WagmiProvider, type Config } from 'wagmi'
import { QueryClient, QueryClientProvider, notifyManager, useQueryClient } from '@tanstack/react-query'
import { RainbowKitProvider, type Theme } from '@rainbow-me/rainbowkit'
import {
  createDataProvider,
  createDraftStore,
  createManifestStorage,
  PineApiClient,
  readPineEnv,
  type PineEnv,
} from '@pine/data'
import { PineContext, isDemoEnv, type PineContextValue } from './context'
import { createPineWagmiConfig } from './wagmi-config'
import { createApiTokenGetter } from '../internal/api-token'

// The claim composer keeps its draft in the TanStack Query cache and binds it to controlled inputs.
// TanStack's default notify scheduler defers cache notifications to a later tick, so React restores the
// previous input value first and the caret jumps to the end while typing mid-text. Notifying synchronously
// keeps edits in place for every app that uses PineProviders.
if (typeof window !== 'undefined') notifyManager.setScheduler((cb) => cb())

export { PineContext, usePine, isDemoEnv, type PineContextValue } from './context'
export { createPineWagmiConfig, pineViemChains, pineWalletList, walletConnectProjectId } from './wagmi-config'

export interface PineProvidersProps {
  children: ReactNode
  /** Pass `await auth()` from the server layout so the first render already knows the user. */
  session?: Session | null
  /** RainbowKit theme, e.g. `darkTheme({ accentColor: '#…' })` */
  rainbowTheme?: Theme | null
  appName: string
  /** Optional overrides (tests, storybooks). Defaults to `readPineEnv()`. */
  env?: Partial<PineEnv>
  /** Optional external QueryClient (tests). */
  queryClient?: QueryClient
  /** Optional externally created wagmi config. */
  wagmiConfig?: Config
  /** Base path prefix for the app's API routes when the app runs under a basePath. */
  apiBase?: string
}

export function createPineQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: (count, error) => {
          const status = (error as { status?: number } | null)?.status
          if (status && status >= 400 && status < 500 && status !== 429) return false
          return count < 2
        },
        refetchOnWindowFocus: false,
      },
    },
  })
}

function createContextValue(appName: string, overrides: Partial<PineEnv> | undefined, apiBase: string): PineContextValue {
  const env: PineEnv = { ...readPineEnv(), ...overrides }
  const base = apiBase.replace(/\/$/, '')
  // REST mode: drafts are per-user, so the store authenticates with a short-lived app-issued token.
  const getToken = env.dataSource === 'rest' ? createApiTokenGetter(base) : undefined
  return {
    env,
    data: createDataProvider(env),
    storage: createManifestStorage(env),
    drafts: createDraftStore(env, getToken ? { getToken } : {}),
    demo: isDemoEnv(env),
    appName,
    apiBase: base,
    // The backend is same-origin in the browser; the session cookie is HttpOnly and never read by script.
    api: env.dataSource === 'api' ? new PineApiClient({ baseUrl: '' }) : null,
  }
}

/**
 * When the data provider can notify about local writes (MockDataProvider.subscribe — demo publishing,
 * evidence, other tabs), refresh every Pine query except drafts.
 */
function DataSync({ data }: { data: PineContextValue['data'] }): null {
  const qc = useQueryClient()
  useEffect(() => {
    const sub = (data as { subscribe?: (fn: () => void) => (() => void) | void }).subscribe
    if (typeof sub !== 'function') return
    const unsub = sub.call(data, () => {
      void qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] === 'pine' && q.queryKey[1] !== 'draft' && q.queryKey[1] !== 'drafts' && q.queryKey[1] !== 'account',
      })
    })
    return typeof unsub === 'function' ? unsub : undefined
  }, [data, qc])
  return null
}

/**
 * Root provider for every Pine app: next-auth session, wagmi, TanStack Query, RainbowKit and the
 * Pine context (env, data provider, manifest storage, draft store, demo flag).
 *
 * SSR-safe: nothing here touches `window` during render.
 */
export function PineProviders(props: PineProvidersProps): React.JSX.Element {
  const { children, session, rainbowTheme, appName } = props
  const [value] = useState(() => createContextValue(appName, props.env, props.apiBase ?? ''))
  const [wagmiConfig] = useState(
    () =>
      props.wagmiConfig ??
      createPineWagmiConfig({ appName, defaultChainId: value.env.defaultChainId, siteUrl: value.env.siteUrl }),
  )
  const [queryClient] = useState(() => props.queryClient ?? createPineQueryClient())

  // `api` mode: identity is the backend's SIWE session (usePineSession), not next-auth. Hooks that read next-auth get a
  // fixed signed-out context, so nothing ever calls /api/auth (which the backend owns), not even after a dev remount.
  const apiMode = value.env.dataSource === 'api'
  const SessionScope = apiMode ? SignedOutSession : SessionProvider
  return (
    <SessionScope session={apiMode ? null : session} basePath={value.apiBase ? `${value.apiBase}/api/auth` : undefined}>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider
            theme={rainbowTheme}
            appInfo={{ appName }}
            initialChain={value.env.defaultChainId}
            modalSize="compact"
          >
            <PineContext.Provider value={value}>
              <DataSync data={value.data} />
              {children}
            </PineContext.Provider>
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </SessionScope>
  )
}

const SIGNED_OUT = { data: null, status: 'unauthenticated' as const, update: async () => null }

/** next-auth's context, permanently signed out (api mode). */
function SignedOutSession({ children }: { children: ReactNode; session?: Session | null; basePath?: string }): React.JSX.Element {
  return <SessionContext.Provider value={SIGNED_OUT}>{children}</SessionContext.Provider>
}

export default PineProviders
