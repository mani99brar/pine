'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

/**
 * A thin spectrum scan line across the top while a route loads. Starts on same-origin link clicks and
 * stops when the pathname changes (or after a timeout). Static under reduced motion.
 */
export function RouteProgress() {
  const pathname = usePathname()
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as Element | null)?.closest?.('a')
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return
      const href = a.getAttribute('href')
      if (!href || href.startsWith('#') || href.startsWith('mailto:')) return
      try {
        const url = new URL(href, window.location.href)
        if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return
        setPending(url.pathname)
      } catch {
        /* ignore malformed */
      }
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  useEffect(() => {
    if (!pending) return
    if (pathname === pending) {
      const t = setTimeout(() => setPending(null), 120)
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => setPending(null), 8000)
    return () => clearTimeout(t)
  }, [pathname, pending])

  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[96] h-[2px] overflow-hidden">
      {pending && <div className="h-full w-full animate-[scan_1.1s_cubic-bezier(.65,0,.35,1)_infinite]" style={{ background: 'var(--spectrum)', boxShadow: '0 0 12px rgba(255,236,220,0.6)' }} />}
    </div>
  )
}
