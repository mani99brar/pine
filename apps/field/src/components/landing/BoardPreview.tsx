'use client'

import { useMemo } from 'react'
import { formatAmount, formatClaimNumber, formatPrice } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { useClaims, useStats } from '@pine/react'
import { FieldMap } from '@/components/board/FieldMap'
import { TensionBar } from '@/components/glyphs/TensionBar'
import { TimeRing } from '@/components/glyphs/TimeRing'
import { DepthBars } from '@/components/glyphs/DepthBars'
import { PolicyShape } from '@/components/glyphs/PolicyMark'
import { useDepthMap } from '@/lib/hooks'
import { ButtonLink } from '@/components/ui/Button'

/** The field map beside a key that reads each glyph off one real claim. */
export function BoardPreview() {
  const q = useClaims({ status: 'open', sort: 'deadline', limit: 50 })
  const stats = useStats()
  const items = useMemo(() => q.data?.items ?? [], [q.data])
  const depth = useDepthMap(items.map((c) => c.id))
  const sample = items.find((c) => c.tags.includes('flagship')) ?? items[0]

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="min-w-0 rounded-[var(--radius-tile)] border border-line bg-sheet p-4 sm:p-6">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="t-h3">The field map</h3>
          {stats.data && (
            <p className="text-[0.84rem] text-ink-3">
              <span className="t-figure text-[1rem] text-ink">{stats.data.openClaims}</span> open,{' '}
              <span className="t-figure text-[1rem] text-ink">{formatAmount(stats.data.totalLiquidity, { compact: true, maxDecimals: 1 })}</span> {stats.data.collateralSymbol} liquidity
            </p>
          )}
        </div>
        {q.isLoading ? <div className="skeleton h-[420px]" /> : <FieldMap claims={items} depths={depth.map} height={420} />}
      </div>

      <div className="min-w-0">
        <h3 className="t-h3">Reading one claim</h3>
        {sample ? (
          <p className="mt-1 text-[0.86rem] text-ink-2">
            {formatClaimNumber(sample.number)}: {sample.title}
          </p>
        ) : (
          <span className="skeleton mt-2 block h-4 w-3/4" />
        )}
        <dl className="mt-5 grid gap-6">
          <div>
            <dt className="flex items-baseline justify-between gap-3">
              <span className="font-[650]">Tension</span>
              {sample?.yesPrice !== undefined && <span className="t-figure text-[1.3rem] text-flare-ink">{formatPrice(sample.yesPrice)}</span>}
            </dt>
            <dd>
              <TensionBar yes={sample?.yesPrice} yes24hAgo={sample?.yesPrice24hAgo} className="mt-2" />
              <p className="mt-4 text-[0.86rem] text-ink-2">
                {COPY.priceLabel}: the knot. Hatched is Yes, solid is No. The dashed post and trail show where it was 24 hours ago.
              </p>
            </dd>
          </div>
          <div className="grid grid-cols-[auto_1fr] items-center gap-4">
            <dt className="sr-only">Time</dt>
            <dd>{sample ? <TimeRing start={sample.createdAt} end={sample.evidenceDeadline} size={52} /> : <span className="skeleton block h-[52px] w-[52px] rounded-full" />}</dd>
            <dd className="text-[0.86rem] text-ink-2">
              <span className="block font-[650] text-ink">Time</span>
              How much of the evidence window is left. It turns yellow in the last 24 hours.
            </dd>
          </div>
          <div className="grid grid-cols-[auto_1fr] items-center gap-4">
            <dt className="sr-only">Depth</dt>
            <dd>{sample ? <DepthBars depth={depth.map[sample.id]} symbol={sample.collateralSymbol} size="lg" caption={false} /> : null}</dd>
            <dd className="text-[0.86rem] text-ink-2">
              <span className="block font-[650] text-ink">Depth</span>
              What you could actually trade before the price moves 1, 2, 5, 10 or 20 points. Hollow bars are thin.
            </dd>
          </div>
          <div className="grid grid-cols-[auto_1fr] items-center gap-4">
            <dt className="sr-only">Policy</dt>
            <dd className="flex gap-1.5 text-ink">
              <PolicyShape family="FUNC" size={20} />
              <PolicyShape family="BOT" size={20} />
              <span className="text-ink-3">
                <PolicyShape family="SC" gated size={20} />
              </span>
            </dd>
            <dd className="text-[0.86rem] text-ink-2">
              <span className="block font-[650] text-ink">Policy</span>
              Functional, automation, smart contract (gated). The shape tells you which rules apply.
            </dd>
          </div>
        </dl>
        <ButtonLink href="/board" variant="secondary" className="mt-7 w-full">
          Browse open claims
        </ButtonLink>
      </div>
    </div>
  )
}
