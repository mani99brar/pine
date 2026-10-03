/**
 * `next/link` for the static build: a plain anchor whose clicks go to the in-memory router.
 *
 * Internal links keep a real `href` for accessibility and "open in new tab", written as a hash route
 * (`#/claims/pine-0009`) because the artifact's own path is unknown. Plain clicks are intercepted.
 * Fragment-only links (`#evidence`) are left to the global in-page anchor handler (src/app/anchors.ts).
 */
import { forwardRef, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import { hashHref, navigate } from '../router/router'

type UrlObject = { pathname?: string | null; query?: Record<string, string | number | boolean | readonly string[] | null | undefined> | string | null; hash?: string | null; search?: string | null }

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string | UrlObject
  replace?: boolean
  scroll?: boolean
  prefetch?: boolean | null | 'auto'
  shallow?: boolean
  passHref?: boolean
  legacyBehavior?: boolean
  locale?: string | false
  onNavigate?: (e: { preventDefault(): void }) => void
  children?: ReactNode
}

function formatUrl(href: string | UrlObject): string {
  if (typeof href === 'string') return href
  let out = href.pathname ?? ''
  if (href.search) out += href.search.startsWith('?') ? href.search : `?${href.search}`
  else if (href.query && typeof href.query === 'object') {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(href.query)) {
      if (v === null || v === undefined) continue
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)))
      else qs.append(k, String(v))
    }
    const s = qs.toString()
    if (s) out += `?${s}`
  } else if (typeof href.query === 'string' && href.query) out += `?${href.query}`
  if (href.hash) out += href.hash.startsWith('#') ? href.hash : `#${href.hash}`
  return out
}

/** Root-relative app paths and query-only hrefs are routed in memory; everything else is a normal link. */
export function isInternalHref(url: string): boolean {
  if (url.startsWith('//')) return false
  return url.startsWith('/') || url.startsWith('?')
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, replace, scroll, prefetch: _prefetch, shallow: _shallow, passHref: _passHref, legacyBehavior: _legacy, locale: _locale, onNavigate, onClick, target, children, ...rest },
  ref,
) {
  const url = formatUrl(href)
  const internal = isInternalHref(url)
  const shown = internal ? hashHref(url) : url

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    if (e.defaultPrevented || !internal) return
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if (target && target !== '_self') return
    e.preventDefault()
    let cancelled = false
    onNavigate?.({ preventDefault: () => (cancelled = true) })
    if (cancelled) return
    navigate(url, { replace, scroll })
  }

  return (
    <a ref={ref} href={shown} target={target} onClick={handleClick} {...rest}>
      {children}
    </a>
  )
})

export default Link
