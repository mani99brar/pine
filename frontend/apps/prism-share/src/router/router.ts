/**
 * In-memory client router for the static build.
 *
 * The artifact is served from an unknown path on another origin and only a plain `#fragment` of the
 * initial URL reaches the page, so the router never reads `location.pathname` or the query string.
 * The current route lives in memory. When the browser allows it, each navigation is mirrored into the
 * hash (`#/claims/pine-0009?view=list`) with the History API, so reload, back and forward work and a
 * `#/route` in the initial URL opens that route. Hashes that do not start with `#/` are in-page anchors.
 */

export interface RouteLocation {
  /** Path without query or fragment, e.g. `/claims/pine-0009`. Never has a trailing slash (except `/`). */
  pathname: string
  /** Query string including `?`, or ''. */
  search: string
  /** In-page fragment to scroll to after navigating (without `#`), or ''. */
  fragment: string
  /** Increments on every navigation (push, replace, pop, refresh). */
  navId: number
  /** Increments only when the pathname changes or on refresh(): server-page results are cached per epoch. */
  epoch: number
  /** Scroll behaviour requested for this navigation. */
  scroll: 'top' | 'keep' | 'restore'
  /** Identifies the history entry (for scroll restoration). */
  entry: number
}

export interface NavigateOptions {
  replace?: boolean
  scroll?: boolean
}

type Listener = () => void

const BASE = 'http://prism.local'

/** Next.js redirects from apps/prism/next.config.ts. */
const REDIRECTS: Record<string, string> = {
  '/launch-gates': '/risks#gates',
  '/table': '/claims',
  '/new': '/compose',
}

function normalizePath(p: string): string {
  if (!p) return '/'
  const out = p.replace(/\/{2,}/g, '/')
  return out.length > 1 && out.endsWith('/') ? out.slice(0, -1) : out
}

function parse(href: string, from: { pathname: string; search: string }): { pathname: string; search: string; fragment: string } {
  let url: URL
  try {
    url = new URL(href, BASE + from.pathname + from.search)
  } catch {
    url = new URL('/', BASE)
  }
  let pathname = normalizePath(url.pathname)
  let search = url.search === '?' ? '' : url.search
  let fragment = url.hash ? decodeSafe(url.hash.slice(1)) : ''
  const redirect = REDIRECTS[pathname]
  if (redirect) {
    const r = new URL(redirect, BASE)
    pathname = normalizePath(r.pathname)
    search = r.search || search
    fragment = r.hash ? r.hash.slice(1) : fragment
  }
  return { pathname, search, fragment }
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** `#/claims?x=1` → `/claims?x=1`; anything else → null. */
function routeFromHash(hash: string): string | null {
  if (!hash.startsWith('#/')) return null
  return hash.slice(1)
}

/** Top-level pages reachable from a plain `#token` in the initial URL (`#claims`, `#compose`, `#agents`…). */
const TOKEN_PAGES = new Set(['claims', 'compose', 'repos', 'policies', 'agents', 'dashboard', 'drafts', 'activity', 'account', 'risks'])

/**
 * Hosts may forward only a plain `#token`, so the first route can also come from one: a top-level page
 * name, or a claim id (`#pine-0009` → `/claims/pine-0009`). Other tokens (`#main`, `#gates`) are ignored.
 */
function routeFromToken(hash: string): string | null {
  const t = hash.replace(/^#/, '')
  if (TOKEN_PAGES.has(t)) return `/${t}`
  if (/^pine-\d{1,6}$/i.test(t)) return `/claims/${t.toLowerCase()}`
  return null
}

export function hashHref(href: string): string {
  return `#${href}`
}

let entrySeq = 0
let historyWorks = true
const listeners = new Set<Listener>()
const scrollByEntry = new Map<number, number>()

function initial(): RouteLocation {
  let start = '/'
  try {
    start = routeFromHash(window.location.hash) ?? routeFromToken(window.location.hash) ?? '/'
  } catch {
    start = '/'
  }
  const p = parse(start, { pathname: '/', search: '' })
  return { ...p, navId: 0, epoch: 0, scroll: 'top', entry: 0 }
}

let state: RouteLocation = typeof window === 'undefined' ? { pathname: '/', search: '', fragment: '', navId: 0, epoch: 0, scroll: 'top', entry: 0 } : initial()

// In-memory fallback stack when the History API is unavailable.
const memoryStack: { href: string; entry: number }[] = [{ href: state.pathname + state.search, entry: 0 }]
let memoryIndex = 0

function emit() {
  listeners.forEach((l) => l())
}

function saveScroll() {
  try {
    scrollByEntry.set(state.entry, window.scrollY)
  } catch {
    /* ignore */
  }
}

function writeHistory(kind: 'push' | 'replace', href: string, entry: number) {
  if (!historyWorks) return
  try {
    const data = { prismShare: true, entry }
    const url = hashHref(href)
    if (kind === 'push') window.history.pushState(data, '', url)
    else window.history.replaceState(data, '', url)
  } catch {
    historyWorks = false
  }
}

export const routerStore = {
  subscribe(cb: Listener): () => void {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  get(): RouteLocation {
    return state
  },
}

export function navigate(href: string, opts: NavigateOptions = {}): void {
  const next = parse(href, state)
  const sameDoc = next.pathname === state.pathname && next.search === state.search
  // A pure fragment link (or the same URL with a fragment) only scrolls.
  if (sameDoc && next.fragment && !opts.replace) {
    state = { ...state, fragment: next.fragment, navId: state.navId + 1, scroll: 'keep' }
    emit()
    return
  }
  saveScroll()
  const replace = Boolean(opts.replace) || sameDoc
  const entry = replace ? state.entry : ++entrySeq
  const pathChanged = next.pathname !== state.pathname
  state = {
    ...next,
    navId: state.navId + 1,
    epoch: pathChanged ? state.epoch + 1 : state.epoch,
    scroll: opts.scroll === false ? 'keep' : 'top',
    entry,
  }
  const full = next.pathname + next.search
  if (replace) {
    memoryStack[memoryIndex] = { href: full, entry }
    writeHistory('replace', full, entry)
  } else {
    memoryStack.splice(memoryIndex + 1)
    memoryStack.push({ href: full, entry })
    memoryIndex = memoryStack.length - 1
    writeHistory('push', full, entry)
  }
  emit()
}

function applyPop(href: string, entry: number) {
  saveScroll()
  const next = parse(href, { pathname: '/', search: '' })
  const pathChanged = next.pathname !== state.pathname
  state = { ...next, navId: state.navId + 1, epoch: pathChanged ? state.epoch + 1 : state.epoch, scroll: 'restore', entry }
  emit()
}

export function back(): void {
  if (historyWorks) {
    try {
      window.history.back()
      return
    } catch {
      historyWorks = false
    }
  }
  if (memoryIndex > 0) {
    memoryIndex -= 1
    const e = memoryStack[memoryIndex]!
    applyPop(e.href, e.entry)
  }
}

export function forward(): void {
  if (historyWorks) {
    try {
      window.history.forward()
      return
    } catch {
      historyWorks = false
    }
  }
  if (memoryIndex < memoryStack.length - 1) {
    memoryIndex += 1
    const e = memoryStack[memoryIndex]!
    applyPop(e.href, e.entry)
  }
}

/** Re-runs the current route's page (like Next's router.refresh()). */
export function refresh(): void {
  state = { ...state, navId: state.navId + 1, epoch: state.epoch + 1, scroll: 'keep' }
  emit()
}

export function savedScroll(entry: number): number | undefined {
  return scrollByEntry.get(entry)
}

/** Installs history listeners and syncs the first entry. Call once before rendering. */
export function installRouter(): void {
  if (typeof window === 'undefined') return
  try {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
  } catch {
    /* ignore */
  }
  // Mirror the first route into the hash only when it came from the hash: never rewrite a host's own token.
  if (routeFromHash(window.location.hash) || routeFromToken(window.location.hash)) writeHistory('replace', state.pathname + state.search, state.entry)
  const onPop = (e: PopStateEvent) => {
    const route = routeFromHash(window.location.hash)
    if (route === null) return // in-page anchor
    const data = e.state as { prismShare?: boolean; entry?: number } | null
    const entry = data?.prismShare && typeof data.entry === 'number' ? data.entry : ++entrySeq
    applyPop(route, entry)
  }
  window.addEventListener('popstate', onPop)
}
