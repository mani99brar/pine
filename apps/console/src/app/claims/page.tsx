import type { Metadata } from 'next'
import { BUILT_IN_VIEWS, type ExploreFilters, type SortKey } from '@/lib/views'
import { ExploreWorkbench } from '@/components/explore/explore-workbench'

export const metadata: Metadata = {
  title: 'Claims',
  description: 'Every published Pine claim: status, pinned commit, policy, YES price, liquidity, evidence and deadline.',
  openGraph: { title: 'Claims | Pine Console', description: 'Browse open, disputed and resolved claims about pinned commits.' },
}

const SORTS: SortKey[] = ['deadline', 'yes', 'liquidity', 'evidence', 'newest', 'volume']

export default async function ClaimsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const str = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '')
  const view = str('view')
  const sort = str('sort') as SortKey
  const initial: ExploreFilters = {
    view: BUILT_IN_VIEWS.some((v) => v.id === view) || view.startsWith('saved-') ? view : 'all',
    q: str('q'),
    policy: str('policy'),
    repo: str('repo'),
    sort: SORTS.includes(sort) ? sort : 'deadline',
    dir: str('dir') === 'desc' ? 'desc' : 'asc',
  }
  return (
    <>
      <h1 className="sr-only">Claims</h1>
      <ExploreWorkbench initial={initial} />
    </>
  )
}
