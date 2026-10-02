'use client'

import { useCallback, useSyncExternalStore } from 'react'

const EVENT = 'docket:ack'
const key = (draftId: string) => `docket:ack:${draftId}`

interface Stored {
  signature: string
  items: string[]
}

function read(draftId: string): Stored | null {
  try {
    const raw = window.localStorage.getItem(key(draftId))
    return raw ? (JSON.parse(raw) as Stored) : null
  } catch {
    return null
  }
}

const cache = new Map<string, { raw: string | null; value: Stored | null }>()
function snapshot(draftId: string): Stored | null {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(key(draftId))
  } catch {
    raw = null
  }
  const c = cache.get(draftId)
  if (c && c.raw === raw) return c.value
  const value = read(draftId)
  cache.set(draftId, { raw, value })
  return value
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}

/**
 * Risk acknowledgements for a draft. They are tied to a signature of the plan's numbers, so changing
 * the amounts clears them: the person must re-acknowledge what they are actually about to spend.
 */
export function useAcknowledgements(draftId: string, signature: string) {
  const stored = useSyncExternalStore(
    subscribe,
    () => snapshot(draftId),
    () => null,
  )
  const items = stored && stored.signature === signature ? stored.items : []
  const toggle = useCallback(
    (id: string, on: boolean) => {
      const current = read(draftId)
      const base = current && current.signature === signature ? current.items : []
      const next: Stored = { signature, items: on ? [...new Set([...base, id])] : base.filter((x) => x !== id) }
      try {
        window.localStorage.setItem(key(draftId), JSON.stringify(next))
      } catch {
        /* ignore */
      }
      window.dispatchEvent(new Event(EVENT))
    },
    [draftId, signature],
  )
  return { items, toggle, has: (id: string) => items.includes(id) }
}

export function acknowledgementsComplete(draftId: string, signature: string, required: string[]): boolean {
  if (typeof window === 'undefined') return false
  const s = read(draftId)
  return !!s && s.signature === signature && required.every((r) => s.items.includes(r))
}
