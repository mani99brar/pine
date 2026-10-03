/**
 * Document-level link handling for anchors that are not `next/link`:
 * - `#fragment` links scroll in place without touching the URL (the hash holds the route);
 * - root-relative links (`<a href="/llms.txt">` on the agents page) go to the in-memory router instead
 *   of navigating the frame to a path that does not exist on the artifact's origin;
 * - `<a download>` is inert (the artifact frame cannot download).
 */
import { navigate } from '../router/router'

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function isFocusable(el: HTMLElement): boolean {
  return el.hasAttribute('tabindex') || /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName)
}

/** Scrolls to the element with this id (or name), like the browser does for `#fragment`. Returns false when absent. */
export function scrollToFragment(fragment: string): boolean {
  if (!fragment) return false
  const el = (document.getElementById(fragment) ?? document.getElementsByName(fragment)[0]) as HTMLElement | undefined
  if (!el) return false
  el.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : undefined })
  if (isFocusable(el)) el.focus({ preventScroll: true })
  return true
}

/** Retries until the element exists (route content and mock data arrive asynchronously). */
export function scrollToFragmentSoon(fragment: string, timeoutMs = 6000): () => void {
  let stopped = false
  const started = Date.now()
  const tick = () => {
    if (stopped) return
    if (scrollToFragment(fragment)) {
      // Layout can still shift while data and fonts settle: align once more.
      window.setTimeout(() => !stopped && scrollToFragment(fragment), 450)
      return
    }
    if (Date.now() - started < timeoutMs) window.setTimeout(tick, 120)
  }
  window.requestAnimationFrame(tick)
  return () => {
    stopped = true
  }
}

export function installAnchors(): void {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = (e.target as Element | null)?.closest?.('a')
    if (!a) return
    const href = a.getAttribute('href')
    if (!href) return
    if (a.target && a.target !== '_self') return
    if (a.hasAttribute('download')) {
      e.preventDefault()
      return
    }
    if (href.startsWith('#/')) {
      e.preventDefault()
      navigate(href.slice(1))
      return
    }
    if (href.startsWith('#')) {
      e.preventDefault()
      let id = href.slice(1)
      try {
        id = decodeURIComponent(id)
      } catch {
        /* keep raw */
      }
      scrollToFragment(id)
      return
    }
    if (href.startsWith('/') && !href.startsWith('//')) {
      e.preventDefault()
      navigate(href)
    }
  })
}
