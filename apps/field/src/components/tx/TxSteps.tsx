'use client'

import type { TxRunner, TxRunnerStep } from '@pine/react'
import { explorerTxUrl, shortHash } from '@pine/core'
import { Check, ExternalLink as ExtIcon, Lock, PenLine, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'

function StatusNode({ s, active }: { s: TxRunnerStep; active: boolean }) {
  const base = 'relative z-[1] flex h-7 w-7 shrink-0 items-center justify-center rounded-full'
  if (s.status === 'confirmed') return <span className={cn(base, 'bg-ink text-on-ink')}><Check size={15} strokeWidth={3} aria-hidden /></span>
  if (s.status === 'failed') return <span className={cn(base, 'border-2 border-flare-ink bg-sheet text-flare-ink')}><X size={15} strokeWidth={3} aria-hidden /></span>
  if (s.status === 'skipped') return <span className={cn(base, 'border-2 border-dashed border-line-strong bg-sheet text-ink-3')}>–</span>
  if (s.status === 'awaiting_signature') return <span className={cn(base, 'bg-lumen text-[#161a33] shadow-[0_0_0_2px_var(--ink)]')}><PenLine size={14} aria-hidden /></span>
  if (s.status === 'pending')
    return (
      <span className={cn(base, 'border-2 border-ink bg-sheet')}>
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink border-r-transparent" aria-hidden />
      </span>
    )
  return <span className={cn(base, 'border-2 bg-sheet', active ? 'border-ink' : 'border-line-strong')} />
}

const STATUS_TEXT: Record<string, string> = {
  idle: 'Waiting',
  awaiting_signature: 'Confirm in your wallet',
  pending: 'Waiting for confirmation',
  confirmed: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
}

/**
 * The step tracker for any multi-step transaction run (publish, finish funding, evidence, redeem). It
 * is a vertical rope: done steps are filled knots; the terms-freeze point is marked; manual DEX steps
 * offer the link and a confirmation button.
 */
export function TxSteps({ runner, className, chainId }: { runner: TxRunner; className?: string; chainId?: number }) {
  const currentId = runner.current?.id
  return (
    <ol className={cn('relative', className)} aria-label="Transaction steps">
      {runner.steps.map((s, i) => {
        const last = i === runner.steps.length - 1
        const active = s.id === currentId
        const awaitingManual = runner.awaitingManual === s.id
        return (
          <li key={s.id} className="relative grid grid-cols-[1.75rem_1fr] gap-x-3 pb-5 last:pb-0" aria-current={active ? 'step' : undefined}>
            {!last && <span aria-hidden className={cn('absolute left-[13px] top-7 bottom-0 w-[2px]', s.status === 'confirmed' ? 'bg-ink' : 'bg-line-strong')} />}
            <StatusNode s={s} active={active} />
            <div className="min-w-0 pt-0.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <p className="font-[650]">
                  {s.label}
                  {s.optional && <span className="ml-1.5 text-[0.75rem] font-[500] text-ink-3">optional</span>}
                </p>
                <p className={cn('text-[0.78rem] font-[600]', s.status === 'failed' ? 'text-flare-ink' : s.status === 'confirmed' ? 'text-ink-2' : 'text-ink-3')} aria-live={active ? 'polite' : undefined}>
                  {awaitingManual ? 'Waiting for you' : STATUS_TEXT[s.status]}
                </p>
              </div>
              <p className="mt-0.5 text-[0.84rem] text-ink-2">{s.description}</p>
              {s.estimatedCost && (
                <p className="mt-1 text-[0.78rem] text-ink-3">
                  Estimated cost <span className="t-figure text-[0.9rem] text-ink-2">{s.estimatedCost.amount}</span> {s.estimatedCost.currency}
                </p>
              )}
              {s.txHash && (
                <a
                  href={explorerTxUrl(s.request?.chainId ?? chainId ?? 100, s.txHash)}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="mt-1 inline-flex items-center gap-1 text-[0.78rem] underline underline-offset-2"
                >
                  tx {shortHash(s.txHash)} <ExtIcon size={11} aria-hidden />
                </a>
              )}
              {s.error && (
                <p role="alert" className="untrusted mt-1.5 rounded-[3px] bg-flare-wash px-2.5 py-1.5 text-[0.82rem] text-flare-ink [white-space:normal]">
                  {s.error}
                </p>
              )}
              {awaitingManual && (
                <div className="mt-3 rounded-[3px] border-l-[3px] border-lumen bg-lumen-wash px-3 py-2.5 text-[0.84rem]">
                  <p>This step happens on the DEX, the same way Seer adds liquidity. Add the position there, then come back and mark it done.</p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {s.actionUrl && (
                      <a
                        href={s.actionUrl}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-btn)] border-[1.5px] border-ink px-3 font-[620] hover:bg-ink/[0.06]"
                      >
                        Open the DEX <ExtIcon size={13} aria-hidden />
                      </a>
                    )}
                    <Button size="sm" onClick={() => void runner.confirmManual(s.id)}>
                      I added the liquidity
                    </Button>
                    {s.optional && (
                      <Button size="sm" variant="ghost" onClick={() => runner.skip(s.id)}>
                        Skip for now
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {s.freezesTerms && (
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-fog-2 px-2 py-0.5 text-[0.75rem] font-[650] text-ink-2">
                  <Lock size={11} aria-hidden /> {s.status === 'confirmed' ? 'Terms are frozen from here on' : 'Terms freeze when this confirms'}
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
