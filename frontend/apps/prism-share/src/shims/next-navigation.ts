/**
 * `next/navigation` for the static build, backed by the in-memory router (src/router).
 * Covers what Prism uses: useRouter, usePathname, useSearchParams, useParams, notFound and redirect.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { back, forward, navigate, refresh, routerStore } from '../router/router'
import { useRouteParams } from '../router/hooks'

export interface NavigateOptions {
  scroll?: boolean
}

export interface AppRouterInstance {
  push(href: string, options?: NavigateOptions): void
  replace(href: string, options?: NavigateOptions): void
  back(): void
  forward(): void
  refresh(): void
  prefetch(href: string): void
}

const router: AppRouterInstance = {
  push: (href, o) => navigate(href, { scroll: o?.scroll }),
  replace: (href, o) => navigate(href, { replace: true, scroll: o?.scroll }),
  back,
  forward,
  refresh,
  prefetch: () => undefined,
}

export function useRouter(): AppRouterInstance {
  return router
}

const getPathname = () => routerStore.get().pathname
const getSearch = () => routerStore.get().search

export function usePathname(): string {
  return useSyncExternalStore(routerStore.subscribe, getPathname, getPathname)
}

/** Read-only URLSearchParams, like Next's ReadonlyURLSearchParams. */
export class ReadonlyURLSearchParams extends URLSearchParams {
  private ro = false
  constructor(init?: string) {
    super(init)
    this.ro = true
  }
  private guard(): never {
    throw new Error('ReadonlyURLSearchParams cannot be modified. Copy it with new URLSearchParams(params.toString()).')
  }
  override append(name: string, value: string): void {
    if (this.ro) this.guard()
    super.append(name, value)
  }
  override delete(name: string, value?: string): void {
    if (this.ro) this.guard()
    super.delete(name, value)
  }
  override set(name: string, value: string): void {
    if (this.ro) this.guard()
    super.set(name, value)
  }
  override sort(): void {
    if (this.ro) this.guard()
    super.sort()
  }
}

export function useSearchParams(): ReadonlyURLSearchParams {
  const search = useSyncExternalStore(routerStore.subscribe, getSearch, getSearch)
  return useMemo(() => new ReadonlyURLSearchParams(search), [search])
}

export function useParams<T extends Record<string, string | string[]> = Record<string, string>>(): T {
  return useRouteParams() as T
}

export function useSelectedLayoutSegment(): string | null {
  const pathname = usePathname()
  return pathname.split('/').filter(Boolean)[0] ?? null
}

export function useSelectedLayoutSegments(): string[] {
  return usePathname().split('/').filter(Boolean)
}

// ---------------------------------------------------------------------------
// notFound / redirect: thrown, then handled by the route boundary (src/app/boundaries.tsx)
// ---------------------------------------------------------------------------

export class NotFoundSignal extends Error {
  readonly digest = 'NEXT_NOT_FOUND'
  constructor() {
    super('NEXT_NOT_FOUND')
    this.name = 'NotFoundSignal'
  }
}

export class RedirectSignal extends Error {
  readonly digest = 'NEXT_REDIRECT'
  constructor(readonly href: string) {
    super(`NEXT_REDIRECT ${href}`)
    this.name = 'RedirectSignal'
  }
}

export function notFound(): never {
  throw new NotFoundSignal()
}

export function redirect(href: string): never {
  throw new RedirectSignal(href)
}

export const permanentRedirect = redirect

export function isNotFoundSignal(e: unknown): e is NotFoundSignal {
  return e instanceof NotFoundSignal || (typeof e === 'object' && e !== null && (e as { digest?: string }).digest === 'NEXT_NOT_FOUND')
}

export function isRedirectSignal(e: unknown): e is RedirectSignal {
  return e instanceof RedirectSignal
}
