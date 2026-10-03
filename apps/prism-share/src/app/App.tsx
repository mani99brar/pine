/**
 * The app shell: Prism's root layout (header, demo banner, footer, providers, route progress), its route
 * template (the blur-in transition), loading/error/not-found boundaries, and the matched page.
 */
import { Suspense, use, useEffect, useLayoutEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import RootLayout, { metadata as rootMetadata } from '@/app/layout'
import Template from '@/app/template'
import DefaultLoading from '@/app/loading'
import NotFound from '@/app/not-found'
import { RouteParamsContext, useRouteLocation } from '../router/hooks'
import { savedScroll, type RouteLocation } from '../router/router'
import { GlobalBoundary, RouteBoundary } from './boundaries'
import { scrollToFragmentSoon } from './anchors'
import { EndpointView } from './EndpointView'
import { matchRoute, type PageModule, type PageProps, type RouteMatch } from './routes'

// ---------------------------------------------------------------------------
// Page rendering (server components run in the browser)
// ---------------------------------------------------------------------------

/** Page results per `pathname@epoch`: an async page's promise must survive re-renders while it suspends. */
const pageResults = new Map<string, ReactNode | Promise<ReactNode>>()

function isThenable(v: unknown): v is Promise<ReactNode> {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function'
}

function searchObject(search: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  new URLSearchParams(search).forEach((v, k) => {
    const prev = out[k]
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v]
  })
  return out
}

function pageProps(params: Record<string, string>, search: string): PageProps {
  return { params: Promise.resolve(params), searchParams: Promise.resolve(searchObject(search)) }
}

function PageHost({ page, params, search, cacheKey }: { page: PageModule; params: Record<string, string>; search: string; cacheKey: string }) {
  let out = pageResults.get(cacheKey)
  if (!pageResults.has(cacheKey)) {
    out = page.default(pageProps(params, search))
    pageResults.set(cacheKey, out)
    if (pageResults.size > 24) pageResults.delete(pageResults.keys().next().value as string)
  }
  return <>{isThenable(out) ? use(out) : out}</>
}

// ---------------------------------------------------------------------------
// Document title (from Prism's metadata exports and the root title template)
// ---------------------------------------------------------------------------

type Title = string | { default?: string; template?: string; absolute?: string } | null | undefined
const rootTitle = rootMetadata.title as { default: string; template: string }

function formatTitle(t: Title): string {
  if (!t) return rootTitle.default
  if (typeof t === 'string') return rootTitle.template.replace('%s', t)
  if (t.absolute) return t.absolute
  if (t.default) return t.default
  return rootTitle.default
}

async function resolveTitle(match: RouteMatch, loc: RouteLocation): Promise<string> {
  if (match.kind === 'none') return formatTitle('Nothing here')
  if (match.kind === 'endpoint') return formatTitle(loc.pathname)
  const { page } = match.route
  try {
    if (page.generateMetadata) return formatTitle((await page.generateMetadata(pageProps(match.params, loc.search))).title)
    return formatTitle(page.metadata?.title)
  } catch {
    return rootTitle.default
  }
}

// ---------------------------------------------------------------------------
// Route view
// ---------------------------------------------------------------------------

function useScrollManagement(loc: RouteLocation) {
  useLayoutEffect(() => {
    if (loc.fragment) return scrollToFragmentSoon(loc.fragment)
    if (loc.scroll === 'top') window.scrollTo(0, 0)
    else if (loc.scroll === 'restore') {
      const y = savedScroll(loc.entry) ?? 0
      window.scrollTo(0, y)
      // Content may still be loading: try again once it has height.
      const t = window.setTimeout(() => window.scrollTo(0, y), 400)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [loc.navId, loc.fragment, loc.scroll, loc.entry])
}

/** Like Next's route announcer: screen readers hear the new page title after client navigation. */
function RouteAnnouncer({ title }: { title: string }) {
  return (
    <p aria-live="assertive" role="alert" className="sr-only">
      {title}
    </p>
  )
}

const NO_PARAMS: Record<string, string> = {}

function RouteView() {
  const loc = useRouteLocation()
  const match = useMemo(() => matchRoute(loc.pathname), [loc.pathname])
  const [announce, setAnnounce] = useState('')
  useScrollManagement(loc)

  useEffect(() => {
    let alive = true
    void resolveTitle(match, loc).then((t) => {
      if (!alive) return
      document.title = t
      if (loc.navId > 0) setAnnounce(t)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- titles change with the page, not with query edits
  }, [match, loc.epoch])

  const params = match.kind === 'page' ? match.params : NO_PARAMS
  const Loading = match.kind === 'page' && match.route.loading ? match.route.loading : DefaultLoading
  let content: ReactNode
  if (match.kind === 'page') content = <PageHost page={match.route.page} params={params} search={loc.search} cacheKey={`${loc.pathname}@${loc.epoch}`} />
  else if (match.kind === 'endpoint') content = <EndpointView path={loc.pathname + loc.search} />
  else content = <NotFound />

  return (
    <RouteParamsContext.Provider value={params}>
      <Template key={loc.pathname}>
        <RouteBoundary key={`${loc.pathname}@${loc.epoch}`}>
          <Suspense fallback={<Loading />}>{content}</Suspense>
        </RouteBoundary>
      </Template>
      <RouteAnnouncer title={announce} />
    </RouteParamsContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Root layout, unwrapped from <html>/<body>
// ---------------------------------------------------------------------------

type HtmlElementProps = { lang?: string; className?: string; children: ReactElement<{ children: ReactNode }> }

/** Prism's RootLayout returns <html><body>…</body></html>; the static app mounts inside <body>, so only the body content is rendered. */
const layout = RootLayout({ children: <RouteView /> }) as ReactElement<HtmlElementProps>

/** Classes and lang the root layout puts on <html> (the next/font variables). */
export const htmlAttributes = { lang: layout.props.lang ?? 'en', className: layout.props.className ?? '' }

export function App() {
  return <GlobalBoundary>{layout.props.children.props.children}</GlobalBoundary>
}
