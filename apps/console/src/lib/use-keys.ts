'use client'

import * as React from 'react'

export function isTypingTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function dialogOpen() {
  return typeof document !== 'undefined' && !!document.querySelector('[role="dialog"][data-state="open"], [cmdk-dialog]')
}

/**
 * Page-scoped single-key shortcuts. Keys: "j", "Enter", " ", "1", "mod+Enter", "Escape".
 * Ignored while typing or while a dialog is open (except Escape and mod+ combos).
 */
export function useKeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true) {
  const ref = React.useRef(map)
  React.useEffect(() => {
    ref.current = map
  })
  React.useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const key = mod ? `mod+${e.key}` : e.key
      const handler = ref.current[key]
      if (!handler) return
      if (!mod && e.key !== 'Escape' && (isTypingTarget(e.target) || dialogOpen())) return
      if (e.altKey) return
      handler(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
