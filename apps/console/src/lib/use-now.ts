'use client'

import * as React from 'react'

/** A ticking clock. Starts at mount time; updates every `intervalMs`. */
export function useNowTick(intervalMs = 30_000) {
  const [now, setNow] = React.useState(() => new Date())
  React.useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}
