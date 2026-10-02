'use client'

import { useSyncExternalStore } from 'react'
import { SITE_URL } from './site'

const noop = () => () => {}

/** The browser's origin after hydration; the configured site URL during SSR. */
export function useOrigin(): string {
  return useSyncExternalStore(
    noop,
    () => window.location.origin,
    () => SITE_URL,
  )
}
