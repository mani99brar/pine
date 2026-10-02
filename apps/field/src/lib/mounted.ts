'use client'

import { useSyncExternalStore } from 'react'

const noop = () => () => {}

/** True after hydration on the client; false during SSR. */
export function useMounted(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  )
}
