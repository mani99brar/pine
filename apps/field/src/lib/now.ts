'use client'

import { useSyncExternalStore } from 'react'

/**
 * One shared ticking clock for every countdown on the page. Hydration-safe: the server snapshot is
 * `null`, so time-dependent text renders only on the client and never mismatches.
 */
const TICK_MS = 10_000
let current = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  if (!timer) {
    current = Date.now()
    timer = setInterval(() => {
      current = Date.now()
      listeners.forEach((l) => l())
    }, TICK_MS)
  }
  return () => {
    listeners.delete(callback)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

const getSnapshot = () => current
const getServerSnapshot = () => null

/** Current time in ms (ticks every 10s), or null during SSR/hydration. */
export function useNowMs(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
