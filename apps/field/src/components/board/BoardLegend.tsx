'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { DepthSnapshot } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { TensionBar } from '@/components/glyphs/TensionBar'
import { PolicyShape } from '@/components/glyphs/PolicyMark'
import { DepthBars } from '@/components/glyphs/DepthBars'
import { cn } from '@/lib/cn'

const SAMPLE_DEPTH: DepthSnapshot = {
  outcome: 'yes',
  mid: 0.2,
  at: '2026-01-01T00:00:00Z',
  levels: [
    { price: 0.21, size: 60, side: 'ask' },
    { price: 0.22, size: 160, side: 'ask' },
    { price: 0.25, size: 700, side: 'ask' },
    { price: 0.3, size: 1800, side: 'ask' },
    { price: 0.19, size: 50, side: 'bid' },
    { price: 0.18, size: 150, side: 'bid' },
    { price: 0.15, size: 650, side: 'bid' },
    { price: 0.1, size: 1500, side: 'bid' },
  ],
}

/** "How to read the board": a compact legend for the glyphs, expandable for detail. */
export function BoardLegend({ className, defaultOpen = false }: { className?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section aria-label="How to read the board" className={cn('rounded-[var(--radius-tile)] bg-fog-2/70', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 text-left text-[0.84rem] text-ink-2"
      >
        <span className="font-[650] text-ink">How to read the board</span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="hatch-yes inline-block h-2.5 w-5" />
          Yes: counterexample demonstrated
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="inline-block h-2.5 w-5 bg-cobalt" />
          No: none submitted
        </span>
        <span className="hidden items-center gap-2 md:inline-flex">
          <span aria-hidden className="hatch-invalid inline-block h-2.5 w-2" />
          Invalid result token
        </span>
        <span className="ml-auto inline-flex items-center gap-1 font-[600] text-ink">
          {open ? 'Hide' : 'Explain'}
          <ChevronDown size={14} aria-hidden className={cn('transition-transform', open && 'rotate-180')} />
        </span>
      </button>
      {open && (
        <div className="grid gap-6 border-t border-line px-4 pb-5 pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="font-[650] text-ink">Tension bar</p>
            <TensionBar yes={0.23} yes24hAgo={0.18} invalid={0.02} className="mt-4 max-w-[14rem]" />
            <p className="mt-3 text-[0.84rem] text-ink-2">
              The knot sits at the {COPY.priceLabel.toLowerCase()}. The dashed post is where it was 24 hours ago; the arrow shows the move in percentage points.
            </p>
          </div>
          <div>
            <p className="font-[650] text-ink">Time ring</p>
            <div className="mt-2 flex items-center gap-3">
              <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden>
                <circle cx="17" cy="17" r="13.5" fill="none" stroke="var(--line)" strokeWidth="4" />
                <circle cx="17" cy="17" r="13.5" fill="none" stroke="var(--ink)" strokeWidth="4" strokeDasharray={`${0.62 * 84.8} 84.8`} transform="rotate(-90 17 17)" />
              </svg>
              <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden>
                <circle cx="17" cy="17" r="13.5" fill="none" stroke="var(--line)" strokeWidth="4" />
                <circle cx="17" cy="17" r="13.5" fill="none" stroke="var(--lumen)" strokeWidth="4" strokeDasharray={`${0.12 * 84.8} 84.8`} transform="rotate(-90 17 17)" />
              </svg>
            </div>
            <p className="mt-2 text-[0.84rem] text-ink-2">
              How much of the evidence window is left. It turns yellow inside the last 24 hours. {COPY.deadlineIsNotTradingCutoff}
            </p>
          </div>
          <div>
            <p className="font-[650] text-ink">Depth bars</p>
            <DepthBars depth={SAMPLE_DEPTH} symbol="sDAI" className="mt-3" />
            <p className="mt-2 text-[0.84rem] text-ink-2">
              Collateral you could actually trade within 1, 2, 5, 10 and 20 points of the mid price. Hollow bars mean thin depth, where a small trade moves the price a lot.
            </p>
          </div>
          <div>
            <p className="font-[650] text-ink">Policy marks</p>
            <ul className="mt-2.5 space-y-1.5 text-[0.84rem] text-ink-2">
              <li className="flex items-center gap-2">
                <PolicyShape family="FUNC" size={15} /> FUNC: functional correctness
              </li>
              <li className="flex items-center gap-2">
                <PolicyShape family="BOT" size={15} /> BOT: automation and keeper reliability
              </li>
              <li className="flex items-center gap-2">
                <PolicyShape family="SC" gated size={15} /> SC: smart-contract invariant, gated
              </li>
            </ul>
          </div>
        </div>
      )}
    </section>
  )
}
