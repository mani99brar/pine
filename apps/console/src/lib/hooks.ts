'use client'

import * as React from 'react'
import { useAccount } from '@pine/react'

const noopSubscribe = () => () => {}

/** True on the client after hydration, false during SSR. No effect, no extra render pass. */
export function useIsClient() {
  return React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  )
}

/** The page origin on the client; `fallback` on the server. */
export function useOrigin(fallback: string) {
  return React.useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => fallback,
  )
}

// --- localStorage-backed state ------------------------------------------------

const listeners = new Set<() => void>()
function subscribeStorage(cb: () => void) {
  listeners.add(cb)
  window.addEventListener('storage', cb)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', cb)
  }
}
function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * Per-viewer convenience state persisted in localStorage. Renders `fallback` on the server and
 * hydrates without a mismatch; every component using the same key stays in sync.
 */
export function useLocalStorageState<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  const raw = React.useSyncExternalStore(
    subscribeStorage,
    () => readRaw(key),
    () => null,
  )
  const value = React.useMemo<T>(() => {
    if (raw === null) return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
    // fallback is treated as a constant per key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw])
  const valueRef = React.useRef(value)
  React.useEffect(() => {
    valueRef.current = value
  })
  const set = React.useCallback(
    (v: T | ((prev: T) => T)) => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(valueRef.current) : v
      try {
        window.localStorage.setItem(key, JSON.stringify(next))
      } catch {
        /* storage unavailable: change applies until reload */
      }
      valueRef.current = next
      listeners.forEach((l) => l())
    },
    [key],
  )
  return [value, set]
}

// --- ticking clock -----------------------------------------------------------

const clockListeners = new Set<() => void>()
let clockTimer: number | undefined
function subscribeClock(cb: () => void) {
  clockListeners.add(cb)
  if (clockTimer === undefined) clockTimer = window.setInterval(() => clockListeners.forEach((l) => l()), 1000)
  return () => {
    clockListeners.delete(cb)
    if (!clockListeners.size && clockTimer !== undefined) {
      window.clearInterval(clockTimer)
      clockTimer = undefined
    }
  }
}

/** Current time in whole seconds (ms value), or null during SSR. */
export function useSecondClock(): number | null {
  return React.useSyncExternalStore(
    subscribeClock,
    () => Math.floor(Date.now() / 1000) * 1000,
    () => null,
  )
}

// --- account ---------------------------------------------------------------

/**
 * `useAccount` from @pine/react, made hydration-safe. The package seeds the account query with a
 * localStorage mirror as placeholder data, so the first client render can say "signed in" while the
 * server rendered "loading". Until hydration completes this reports loading, exactly like the server.
 */
export function useAccountSafe(): ReturnType<typeof useAccount> {
  const acc = useAccount()
  const isClient = useIsClient()
  return isClient ? acc : { ...acc, status: 'loading', account: null }
}
