/**
 * Every Prism route (apps/prism/src/app/**\/page.tsx), matched by the in-memory router. Pages are
 * Prism's own modules: server components (including the async ones) are called in the browser with the
 * same `{ params, searchParams }` props Next passes, and their `metadata`/`generateMetadata` exports
 * give the document title.
 */
import type { ComponentType, ReactNode } from 'react'
import * as Home from '@/app/page'
import * as Claims from '@/app/claims/page'
import * as Claim from '@/app/claims/[id]/page'
import * as Evidence from '@/app/claims/[id]/evidence/page'
import * as Compose from '@/app/compose/page'
import * as Dashboard from '@/app/dashboard/page'
import * as Drafts from '@/app/drafts/page'
import * as Activity from '@/app/activity/page'
import * as Account from '@/app/account/page'
import * as Repos from '@/app/repos/page'
import * as Repo from '@/app/repos/[owner]/[repo]/page'
import * as Policies from '@/app/policies/page'
import * as Policy from '@/app/policies/[id]/page'
import * as Agents from '@/app/agents/page'
import * as Risks from '@/app/risks/page'
import ClaimLoading from '@/app/claims/[id]/loading'
import { isLocalEndpoint } from '../api/install'

export interface PageProps {
  params: Promise<Record<string, string>>
  searchParams: Promise<Record<string, string | string[]>>
}

type MetadataTitle = string | { default?: string; template?: string; absolute?: string } | null | undefined
export interface PageModule {
  default: (props: PageProps) => ReactNode | Promise<ReactNode>
  metadata?: { title?: MetadataTitle }
  generateMetadata?: (props: PageProps) => Promise<{ title?: MetadataTitle }>
}

export interface RouteDef {
  pattern: string
  page: PageModule
  loading?: ComponentType
}

// Server components typed with Next's props; the shapes are compatible at runtime.
const m = (mod: unknown) => mod as PageModule

export const ROUTES: RouteDef[] = [
  { pattern: '/', page: m(Home) },
  { pattern: '/claims', page: m(Claims) },
  { pattern: '/claims/:id', page: m(Claim), loading: ClaimLoading },
  { pattern: '/claims/:id/evidence', page: m(Evidence), loading: ClaimLoading },
  { pattern: '/compose', page: m(Compose) },
  { pattern: '/dashboard', page: m(Dashboard) },
  { pattern: '/drafts', page: m(Drafts) },
  { pattern: '/activity', page: m(Activity) },
  { pattern: '/account', page: m(Account) },
  { pattern: '/repos', page: m(Repos) },
  { pattern: '/repos/:owner/:repo', page: m(Repo) },
  { pattern: '/policies', page: m(Policies) },
  { pattern: '/policies/:id', page: m(Policy) },
  { pattern: '/agents', page: m(Agents) },
  { pattern: '/risks', page: m(Risks) },
]

export type RouteMatch = { kind: 'page'; route: RouteDef; params: Record<string, string> } | { kind: 'endpoint' } | { kind: 'none' }

export function matchRoute(pathname: string): RouteMatch {
  const segs = pathname.split('/').filter(Boolean)
  for (const route of ROUTES) {
    const parts = route.pattern.split('/').filter(Boolean)
    if (parts.length !== segs.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!
      const s = segs[i]!
      if (p.startsWith(':')) params[p.slice(1)] = s
      else if (p !== s) {
        ok = false
        break
      }
    }
    if (ok) return { kind: 'page', route, params }
  }
  if (isLocalEndpoint(pathname)) return { kind: 'endpoint' }
  return { kind: 'none' }
}
