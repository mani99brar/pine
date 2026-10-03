'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

const noopSubscribe = () => () => {}

/** True after hydration on the client; false during SSR and the hydrating render. */
export function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  )
}

// ---------------------------------------------------------------------------
// Shared ticking clock (hydration-safe: null on the server)
// ---------------------------------------------------------------------------

const TICK_MS = 1_000
let current = Date.now()
const clockListeners = new Set<() => void>()
let clockTimer: ReturnType<typeof setInterval> | undefined

function subscribeClock(cb: () => void): () => void {
  clockListeners.add(cb)
  if (!clockTimer) {
    current = Date.now()
    clockTimer = setInterval(() => {
      current = Date.now()
      clockListeners.forEach((l) => l())
    }, TICK_MS)
  }
  return () => {
    clockListeners.delete(cb)
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer)
      clockTimer = undefined
    }
  }
}

/** Current time in ms, ticking each second; null during SSR/hydration so countdowns never mismatch. */
export function useNowMs(): number | null {
  return useSyncExternalStore(
    subscribeClock,
    () => current,
    () => null,
  )
}

// ---------------------------------------------------------------------------
// Media preferences
// ---------------------------------------------------------------------------

function mediaStore(query: string) {
  return {
    subscribe(cb: () => void) {
      if (typeof window === 'undefined') return () => {}
      const mq = window.matchMedia(query)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    get() {
      return typeof window !== 'undefined' && window.matchMedia(query).matches
    },
  }
}

const reduceStore = mediaStore('(prefers-reduced-motion: reduce)')

/** Reduced-motion preference. Defaults to true on the server so SSR never assumes motion. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(reduceStore.subscribe, reduceStore.get, () => true)
}

export function useMediaQuery(query: string, serverValue = false): boolean {
  const [store] = useState(() => mediaStore(query))
  return useSyncExternalStore(store.subscribe, store.get, () => serverValue)
}

// ---------------------------------------------------------------------------
// WebGL capability
// ---------------------------------------------------------------------------

let webglCache: boolean | undefined

export function hasWebGL(): boolean {
  if (webglCache !== undefined) return webglCache
  if (typeof window === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    const ctx =
      (canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true }) as WebGL2RenderingContext | null) ??
      (canvas.getContext('webgl', { failIfMajorPerformanceCaveat: true }) as WebGLRenderingContext | null)
    webglCache = Boolean(ctx)
    ;(ctx as WebGLRenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    webglCache = false
  }
  return webglCache
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/** True while the element intersects the viewport (with a margin). */
export function useInViewport<T extends Element>(rootMargin = '120px'): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin })
    io.observe(el)
    return () => io.disconnect()
  }, [rootMargin])
  return [ref, visible]
}

const visibilityStore = {
  subscribe(cb: () => void) {
    document.addEventListener('visibilitychange', cb)
    return () => document.removeEventListener('visibilitychange', cb)
  },
  get() {
    return document.visibilityState === 'visible'
  },
}

/** True while the tab is visible. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(visibilityStore.subscribe, visibilityStore.get, () => true)
}

/** Runs once after the browser is idle (or after a timeout), returning true from then on. */
export function useIdle(timeout = 1200): boolean {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setIdle(true), { timeout })
      return () => w.cancelIdleCallback?.(id)
    }
    const t = setTimeout(() => setIdle(true), 300)
    return () => clearTimeout(t)
  }, [timeout])
  return idle
}

/** Persisted per-viewer convenience state (wrapped in try/catch; falls back to memory). */
export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read persisted preference after mount
      if (raw !== null) setValue(JSON.parse(raw) as T)
    } catch {
      /* storage unavailable */
    }
  }, [key])
  const set = (v: T) => {
    setValue(v)
    try {
      localStorage.setItem(key, JSON.stringify(v))
    } catch {
      /* storage unavailable */
    }
  }
  return [value, set]
}

/**
 * True when motion should be skipped: during SSR and hydration (so markup always matches), and
 * whenever the visitor prefers reduced motion. Elements that mount later animate normally.
 */
export function useReduceMotion(): boolean {
  const mounted = useMounted()
  const prefers = usePrefersReducedMotion()
  return !mounted || prefers
}

/** Observed content-box width of an element (0 before measurement). */
export function useElementWidth<T extends Element>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}
