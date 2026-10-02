'use client'

import { useEffect, useRef, useState } from 'react'

/** Observe an element's content width. */
export function useWidth<T extends HTMLElement>(initial = 640) {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(initial)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && Math.abs(w - width) > 0.5) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [width])
  return [ref, width] as const
}
