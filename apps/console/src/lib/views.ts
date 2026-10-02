import type { ClaimStatus, ClaimSummary } from '@pine/core'

export interface ExploreFilters {
  view: string
  q: string
  policy: string
  repo: string
  sort: SortKey
  dir: 'asc' | 'desc'
}

export type SortKey = 'deadline' | 'yes' | 'liquidity' | 'evidence' | 'newest' | 'volume'

export interface BuiltInView {
  id: string
  label: string
  description: string
  match: (c: ClaimSummary, ctx: { now: number; me?: string; login?: string }) => boolean
}

const has = (s: ClaimStatus, list: ClaimStatus[]) => list.includes(s)

export const BUILT_IN_VIEWS: BuiltInView[] = [
  { id: 'all', label: 'All', description: 'Every published claim', match: () => true },
  { id: 'open', label: 'Open', description: 'Evidence window open', match: (c) => c.status === 'open' },
  {
    id: 'closing',
    label: 'Closing soon',
    description: 'Open claims whose evidence deadline is within 48 hours',
    match: (c, { now }) => c.status === 'open' && Date.parse(c.evidenceDeadline) - now < 48 * 3600_000,
  },
  {
    id: 'oracle',
    label: 'Awaiting oracle',
    description: 'Deadline passed; answer pending or proposed',
    match: (c) => has(c.status, ['awaiting_answer', 'answer_proposed']),
  },
  { id: 'disputed', label: 'Disputed', description: 'Challenged answers and arbitration', match: (c) => has(c.status, ['disputed', 'arbitration']) },
  { id: 'resolved', label: 'Resolved', description: 'Final outcomes', match: (c) => has(c.status, ['resolved', 'settled']) },
  { id: 'recovery', label: 'Recovery', description: 'Partially published or failed', match: (c) => has(c.status, ['publishing', 'failed']) },
  {
    id: 'mine',
    label: 'Mine',
    description: 'Claims created by your wallet or GitHub account',
    match: (c, { me, login }) =>
      (!!me && c.creator.toLowerCase() === me.toLowerCase()) || (!!login && c.creatorGithub === login),
  },
]

export function sortClaims(items: ClaimSummary[], key: SortKey, dir: 'asc' | 'desc', now = Date.now()) {
  if (key === 'deadline') {
    // "What closes next" first, then "what closed most recently".
    const future = items.filter((c) => Date.parse(c.evidenceDeadline) >= now)
    const past = items.filter((c) => Date.parse(c.evidenceDeadline) < now)
    future.sort((a, b) => Date.parse(a.evidenceDeadline) - Date.parse(b.evidenceDeadline))
    past.sort((a, b) => Date.parse(b.evidenceDeadline) - Date.parse(a.evidenceDeadline))
    const out = [...future, ...past]
    return dir === 'desc' ? out.reverse() : out
  }
  const val = (c: ClaimSummary): number => {
    switch (key) {
      case 'yes':
        return c.yesPrice ?? -1
      case 'liquidity':
        return Number(c.liquidity) || 0
      case 'volume':
        return Number(c.volume) || 0
      case 'evidence':
        return c.evidenceCount
      case 'newest':
        return Date.parse(c.createdAt)
    }
  }
  const out = [...items].sort((a, b) => val(a) - val(b))
  return dir === 'desc' ? out.reverse() : out
}
