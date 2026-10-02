'use client'

import Link from 'next/link'
import { formatClaimNumber, formatPrice } from '@pine/core'
import { useClaims } from '@pine/react'
import { StatusPill } from '@/components/glyphs/Status'
import { TensionBar } from '@/components/glyphs/TensionBar'

/** Claims on the board under this policy. */
export function PolicyClaims({ policyId }: { policyId: string }) {
  const q = useClaims({ policyId, limit: 20 })
  const items = q.data?.items ?? []
  return (
    <section aria-labelledby="pc">
      <h2 id="pc" className="t-h3">
        Claims using it
      </h2>
      {q.isLoading ? (
        <span className="skeleton mt-3 block h-20" />
      ) : items.length === 0 ? (
        <p className="mt-2 text-[0.88rem] text-ink-2">None yet.</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {items.map((c) => (
            <li key={c.id}>
              <Link href={`/claims/${c.id}`} className="block rounded-[var(--radius-tile)] border border-line bg-sheet p-3 hover:border-ink">
                <span className="flex items-center justify-between gap-2 text-[0.78rem]">
                  <span className="t-figure text-[0.88rem] text-ink-2">{formatClaimNumber(c.number)}</span>
                  {c.status !== 'open' ? <StatusPill status={c.status} size="sm" /> : <span className="t-figure text-[0.95rem] text-flare-ink">{c.yesPrice !== undefined ? formatPrice(c.yesPrice) : ''}</span>}
                </span>
                <span className="mt-1 line-clamp-2 block text-[0.86rem] font-[600]">{c.title}</span>
                {c.status === 'open' && <TensionBar yes={c.yesPrice} yes24hAgo={c.yesPrice24hAgo} size="sm" className="mt-2.5" />}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
