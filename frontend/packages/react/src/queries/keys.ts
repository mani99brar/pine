import type { ActivityQuery, Address, ClaimQuery, PriceRange } from '@pine/core'

/** Query keys. Everything lives under ['pine', …] so `invalidateQueries({ queryKey: ['pine'] })` refreshes all. */
export const pineKeys = {
  all: ['pine'] as const,
  claims: (q?: ClaimQuery) => ['pine', 'claims', q ?? {}] as const,
  claimsInfinite: (q?: ClaimQuery) => ['pine', 'claims-infinite', q ?? {}] as const,
  claim: (id: string | undefined) => ['pine', 'claim', id] as const,
  priceHistory: (id: string | undefined, range: PriceRange) => ['pine', 'price-history', id, range] as const,
  depth: (id: string | undefined, outcome: 'yes' | 'no') => ['pine', 'depth', id, outcome] as const,
  evidence: (id: string | undefined) => ['pine', 'evidence', id] as const,
  activity: (q?: ActivityQuery) => ['pine', 'activity', q ?? {}] as const,
  portfolio: (address: Address | undefined) => ['pine', 'portfolio', address?.toLowerCase()] as const,
  policies: () => ['pine', 'policies'] as const,
  policy: (id: string | undefined, version?: string) => ['pine', 'policy', id, version ?? 'latest'] as const,
  stats: () => ['pine', 'stats'] as const,
  drafts: (owner: string) => ['pine', 'drafts', owner] as const,
  draft: (id: string | undefined) => ['pine', 'draft', id] as const,
  account: () => ['pine', 'account'] as const,
  github: (...parts: (string | number | undefined)[]) => ['pine', 'github', ...parts] as const,
}
