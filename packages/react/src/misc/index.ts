'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/** A ticking clock for countdowns. Re-renders every `intervalMs` (default 1s). */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), Math.max(250, intervalMs))
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/** Copy to clipboard with a transient `copied` flag (1.5s). Falls back to execCommand. */
export function useCopy(resetMs = 1500): { copy(text: string): Promise<void>; copied: boolean; error?: string } {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = useCallback(
    async (text: string) => {
      setError(undefined)
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
        } else {
          legacyCopy(text)
        }
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), resetMs)
      } catch {
        try {
          legacyCopy(text)
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), resetMs)
        } catch {
          setError('Copy failed. Select the text and copy it manually.')
        }
      }
    },
    [resetMs],
  )
  return { copy, copied, error }
}

function legacyCopy(text: string): void {
  if (typeof document === 'undefined') throw new Error('no document')
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(ta)
  if (!ok) throw new Error('execCommand failed')
}

// ---------------------------------------------------------------------------
// Hotkeys
// ---------------------------------------------------------------------------

interface ParsedCombo {
  key: string
  mod: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

const SEQUENCE_TIMEOUT_MS = 1000

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  space: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  slash: '/',
  question: '?',
}

function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split('+')
  // "shift++" or "+" edge cases
  let key = parts.pop() ?? ''
  if (key === '' && combo.endsWith('+')) key = '+'
  key = KEY_ALIASES[key] ?? key
  const set = new Set(parts)
  return {
    key,
    mod: set.has('mod'),
    ctrl: set.has('ctrl') || set.has('control'),
    alt: set.has('alt') || set.has('option'),
    shift: set.has('shift'),
    meta: set.has('meta') || set.has('cmd') || set.has('command'),
  }
}

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? ''
  return /mac|iphone|ipad|ipod/i.test(p)
}

function matches(c: ParsedCombo, e: KeyboardEvent): boolean {
  const key = e.key.toLowerCase()
  if (key !== c.key) return false
  const mac = isMac()
  const wantMeta = c.meta || (c.mod && mac)
  const wantCtrl = c.ctrl || (c.mod && !mac)
  if (e.metaKey !== wantMeta) return false
  if (e.ctrlKey !== wantCtrl) return false
  if (e.altKey !== c.alt) return false
  // Shift is implied for symbols like "?"; only enforce it when the combo names it.
  if (c.shift && !e.shiftKey) return false
  return true
}

function isEditable(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false
  const el = target as HTMLElement
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (el.isContentEditable) return true
  return el.closest?.('[contenteditable="true"],[role="textbox"]') != null
}

/**
 * Keyboard shortcuts. Keys: "mod+k" (⌘ on macOS, Ctrl elsewhere), "shift+/", "?", "j", "escape",
 * and two-key sequences such as "g d" (press g, then d within 1s).
 * Plain keys and sequences are ignored while typing in inputs, textareas, selects and
 * contenteditable regions; combos with mod/ctrl/meta/alt still fire there (so ⌘K works in a field).
 */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, deps: unknown[] = []): void {
  const mapRef = useRef(map)
  useEffect(() => {
    mapRef.current = map
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    let pending: { first: ParsedCombo; at: number } | null = null

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat) return
      const editable = isEditable(e.target)
      const entries = Object.entries(mapRef.current)
      const now = Date.now()

      // Second key of a sequence
      if (pending && now - pending.at <= SEQUENCE_TIMEOUT_MS && !editable) {
        for (const [spec, fn] of entries) {
          const seq = spec.trim().split(/\s+/)
          if (seq.length !== 2) continue
          const first = parseCombo(seq[0] as string)
          const second = parseCombo(seq[1] as string)
          if (first.key === pending.first.key && matches(second, e)) {
            pending = null
            e.preventDefault()
            fn(e)
            return
          }
        }
      }
      pending = null

      for (const [spec, fn] of entries) {
        const seq = spec.trim().split(/\s+/)
        if (seq.length === 2) {
          if (editable) continue
          const first = parseCombo(seq[0] as string)
          if (matches(first, e)) {
            pending = { first, at: now }
            // Don't return: a single-key binding for the same key may also exist; sequences win if matched next.
          }
          continue
        }
        const c = parseCombo(spec)
        const hasModifier = c.mod || c.ctrl || c.meta || c.alt
        if (editable && !hasModifier) continue
        if (matches(c, e)) {
          e.preventDefault()
          fn(e)
          return
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
