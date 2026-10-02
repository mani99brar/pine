import type { ClaimStatus } from '@pine/core'
import { cn } from '@/lib/cn'

export const PHASES = [
  {
    key: 'pin',
    title: 'Pin',
    body: 'The exact commit, policy version and environment are hashed into a manifest.',
    statuses: ['draft'] as ClaimStatus[],
  },
  {
    key: 'publish',
    title: 'Publish and fund',
    body: 'A Seer market is created and terms freeze. Liquidity goes in under your spending limit.',
    statuses: ['publishing', 'failed'] as ClaimStatus[],
  },
  {
    key: 'evidence',
    title: 'Evidence window',
    body: 'Anyone investigates and submits a reproducible counterexample before the UTC deadline.',
    statuses: ['open'] as ClaimStatus[],
  },
  {
    key: 'answer',
    title: 'Answer',
    body: 'Someone posts the answer on Reality.eth with a bond. It stands unless challenged within 3.5 days.',
    statuses: ['awaiting_answer', 'answer_proposed'] as ClaimStatus[],
  },
  {
    key: 'dispute',
    title: 'Dispute',
    body: 'If challenged, bonds double. Anyone can escalate to Kleros jurors, paying the arbitration fee in ETH.',
    statuses: ['disputed', 'arbitration'] as ClaimStatus[],
  },
  {
    key: 'resolve',
    title: 'Resolve and redeem',
    body: 'The final answer settles the market. Winning outcome tokens redeem for collateral.',
    statuses: ['resolved', 'settled'] as ClaimStatus[],
  },
] as const

/**
 * The lifecycle as a rope: six segments in sequence. With `current`, phases before it are filled,
 * the current one is marked with the knot.
 */
export function LifecycleRope({ current, className, compact }: { current?: ClaimStatus; className?: string; compact?: boolean }) {
  const idx = current ? PHASES.findIndex((p) => p.statuses.includes(current)) : -1
  return (
    <ol className={cn('grid gap-x-1 gap-y-6', compact ? 'grid-cols-6' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-6', className)}>
      {PHASES.map((p, i) => {
        const done = idx >= 0 && i < idx
        const here = i === idx
        return (
          <li key={p.key} className="relative min-w-0" aria-current={here ? 'step' : undefined}>
            <div className="relative flex h-4 items-center">
              <span
                aria-hidden
                className={cn(
                  'h-[6px] w-full',
                  here ? 'bg-ink' : done ? 'bg-ink/70' : idx === -1 ? 'bg-ink' : 'border-y border-dashed border-line-strong',
                  i === 0 && 'rounded-l-[2px]',
                  i === PHASES.length - 1 && 'rounded-r-[2px]',
                )}
              />
              {here && <span aria-hidden className="absolute left-0 h-4 w-[4px] bg-ink shadow-[0_0_0_2px_var(--lumen)]" />}
            </div>
            {!compact && (
              <div className="pr-4 pt-3">
                <p className="flex items-baseline gap-2">
                  <span className="t-figure text-[1.1rem] text-ink-3">{i + 1}</span>
                  <span className={cn('font-[680]', here ? 'text-ink' : 'text-ink')}>{p.title}</span>
                  {here && <span className="rounded-full bg-lumen px-1.5 text-[0.72rem] font-[700] text-[#161a33]">now</span>}
                </p>
                <p className="mt-1 text-[0.86rem] leading-[1.45] text-ink-2">{p.body}</p>
              </div>
            )}
            {compact && (
              <p className={cn('mt-1.5 truncate text-[0.75rem]', here ? 'font-[700] text-ink' : 'text-ink-3')}>{p.title}</p>
            )}
          </li>
        )
      })}
    </ol>
  )
}
