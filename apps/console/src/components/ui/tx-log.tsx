'use client'

import * as React from 'react'
import { ExternalLink as ExtIcon, RotateCcw, Snowflake } from 'lucide-react'
import type { TxStepStatus } from '@pine/core'
import { explorerTxUrl, formatAmount, shortHash } from '@pine/core'
import type { TxRunner, TxRunnerStep } from '@pine/react'
import { cn } from '@/lib/cn'
import { Button } from './button'
import { Input } from './field'

const GLYPH: Record<TxStepStatus, { g: string; cls: string; word: string }> = {
  idle: { g: '·', cls: 'text-faint', word: 'queued' },
  awaiting_signature: { g: '◐', cls: 'text-resin animate-pulse-dot', word: 'waiting for wallet' },
  pending: { g: '◌', cls: 'text-resin animate-pulse-dot', word: 'pending' },
  confirmed: { g: '✓', cls: 'text-needle', word: 'confirmed' },
  failed: { g: '✕', cls: 'text-flare', word: 'failed' },
  skipped: { g: '–', cls: 'text-faint', word: 'skipped' },
}

function chainOf(step: TxRunnerStep) {
  return step.request?.chainId
}

function ManualStep({ step, runner }: { step: TxRunnerStep; runner: TxRunner }) {
  const [hash, setHash] = React.useState('')
  const validHash = /^0x[0-9a-fA-F]{64}$/.test(hash.trim())
  return (
    <div className="mt-2 space-y-2 rounded-ctl border border-resin/40 bg-resin-soft/50 p-2.5 font-sans">
      <p className="text-[12.5px] text-bark">
        This step happens on the DEX, not in your wallet prompt here. Add liquidity there, then come back and mark it done.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {step.actionUrl ? (
          <Button asChild variant="secondary" size="sm">
            <a href={step.actionUrl} target="_blank" rel="noopener noreferrer nofollow">
              Open DEX <ExtIcon size={12} aria-hidden />
            </a>
          </Button>
        ) : null}
        <Input
          value={hash}
          onChange={(e) => setHash(e.target.value)}
          placeholder="Tx hash (optional)"
          aria-label="Liquidity transaction hash (optional)"
          mono
          className="h-7 w-[min(320px,100%)] flex-1"
        />
        <Button
          variant="primary"
          size="sm"
          disabled={hash.trim() !== '' && !validHash}
          onClick={() => void runner.confirmManual(step.id, validHash ? (hash.trim() as `0x${string}`) : undefined)}
        >
          Mark done
        </Button>
      </div>
    </div>
  )
}

/** Two-step reset: the first click asks, the second forgets local progress. */
function ResetButton({ onReset }: { onReset: () => void }) {
  const [asking, setAsking] = React.useState(false)
  if (!asking)
    return (
      <Button variant="quiet" size="sm" onClick={() => setAsking(true)} title="Forget local progress. Confirmed transactions stay on-chain.">
        Reset log
      </Button>
    )
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-muted">
      Forget local progress? Confirmed transactions stay on-chain.
      <Button variant="danger" size="xs" onClick={onReset}>
        Reset
      </Button>
      <Button variant="quiet" size="xs" onClick={() => setAsking(false)}>
        Keep
      </Button>
    </span>
  )
}

/**
 * Terminal-like transaction log. One line per step with status glyph, cost estimate, tx hash and
 * inline retry. Shows a frozen-terms marker once a `freezesTerms` step confirms.
 */
export function TxLog({
  runner,
  title = 'Transaction log',
  startLabel = 'Start',
  className,
  compact,
  controls = true,
}: {
  runner: TxRunner
  title?: string
  startLabel?: string
  className?: string
  compact?: boolean
  controls?: boolean
}) {
  const frozenAt = runner.steps.find((s) => s.freezesTerms && s.status === 'confirmed')
  const started = runner.steps.some((s) => s.status !== 'idle')
  return (
    <div className={cn('min-w-0 overflow-hidden rounded-ctl border border-line bg-sunken', className)} aria-live="polite">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
        <span className="stretch-cond text-[12.5px] font-semibold">{title}</span>
        <span
          className={cn(
            'rounded-chip px-1.5 text-[11px] font-medium',
            runner.state === 'done' && 'bg-needle-soft text-needle',
            runner.state === 'failed' && 'bg-flare-soft text-flare',
            (runner.state === 'running' || runner.state === 'paused') && 'bg-resin-soft text-resin',
            runner.state === 'idle' && 'bg-sunken text-muted',
          )}
        >
          {runner.state === 'paused' && runner.awaitingManual ? 'waiting for you' : runner.state}
        </span>
        {frozenAt ? (
          <span className="ml-auto flex items-center gap-1 text-[11.5px] text-slate" title="The question, policy, commit and environment can no longer change">
            <Snowflake size={12} aria-hidden /> terms frozen
          </span>
        ) : null}
      </div>
      <ol className="mono-cond divide-y divide-line/60 text-[12px] leading-[1.5]">
        {runner.steps.map((s, i) => {
          const g = s.manual && s.status === 'awaiting_signature' ? { ...GLYPH.awaiting_signature, word: 'waiting for you on the DEX' } : GLYPH[s.status]
          const chain = chainOf(s)
          return (
            <li key={s.id} className={cn('px-3 py-2', s.status === 'idle' && 'text-muted')}>
              <div className="flex items-start gap-2.5">
                <span className="tnum w-5 shrink-0 text-right text-faint">{String(i + 1).padStart(2, '0')}</span>
                <span className={cn('w-3 shrink-0 text-center', g.cls)} aria-hidden>
                  {g.g}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className={cn('font-medium', s.status !== 'idle' && 'text-bark')}>{s.label}</span>
                    <span className={cn('text-[11px]', g.cls.replace('animate-pulse-dot', ''))}>{g.word}</span>
                    {s.manual ? <span className="text-[11px] text-muted">manual</span> : null}
                    {s.optional ? <span className="text-[11px] text-faint">optional</span> : null}
                    {s.freezesTerms ? <span className="text-[11px] text-slate">freezes terms</span> : null}
                    {s.estimatedCost ? (
                      <span className="tnum ml-auto text-[11px] text-muted">
                        ~{formatAmount(s.estimatedCost.amount, { symbol: s.estimatedCost.currency, maxDecimals: 5 })}
                      </span>
                    ) : null}
                  </div>
                  {!compact ? <p className="wrap-anywhere font-sans text-[12px] text-muted">{s.description}</p> : null}
                  {s.txHash && chain ? (
                    <a
                      href={explorerTxUrl(chain, s.txHash)}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-needle hover:underline"
                    >
                      tx {shortHash(s.txHash, 6)} <ExtIcon size={10} aria-hidden />
                    </a>
                  ) : s.txHash ? (
                    <span className="mt-0.5 block text-[11px] text-muted">ref {shortHash(s.txHash, 6)}</span>
                  ) : null}
                  {s.status === 'failed' && s.error ? <p className="wrap-anywhere mt-1 text-[11.5px] text-flare">{s.error}</p> : null}
                  {s.manual && runner.awaitingManual === s.id ? <ManualStep step={s} runner={runner} /> : null}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      {runner.error ? <p className="border-t border-line bg-flare-soft px-3 py-2 text-[12.5px] text-flare">{runner.error}</p> : null}
      {runner.state === 'failed' && frozenAt ? (
        <p className="border-t border-line bg-surface px-3 py-2 font-sans text-[12px] text-muted">
          The market already exists on-chain, so this run cannot start over. Retry the failed step now, or come back later: Drafts and publications keeps this run and resumes it from the same step.
        </p>
      ) : null}
      {controls ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-3 py-2">
          {runner.limit ? (
            <span className="tnum text-[11.5px] text-muted">
              spent {formatAmount(runner.spent, { symbol: runner.limit.currency, maxDecimals: 4 })} of limit{' '}
              {formatAmount(runner.limit.limit, { symbol: runner.limit.currency })}
            </span>
          ) : null}
          <span className="ml-auto" />
          {runner.state === 'failed' ? (
            <>
              {/* Once a terms-freezing step (create_market) has confirmed, forgetting progress would let the
                  same claim publish a second market, so only retry is offered from then on. */}
              {frozenAt ? null : <ResetButton onReset={() => runner.reset()} />}
              <Button variant="primary" size="sm" onClick={() => void runner.retry()}>
                <RotateCcw size={13} aria-hidden /> Retry step
              </Button>
            </>
          ) : runner.state === 'idle' ? (
            <Button variant="primary" size="sm" onClick={() => void runner.start()} disabled={!runner.hydrated}>
              {started ? 'Resume' : startLabel}
            </Button>
          ) : runner.state === 'done' ? (
            <span className="text-[12px] font-medium text-needle">All steps confirmed</span>
          ) : runner.state === 'paused' && !runner.awaitingManual ? (
            <Button variant="primary" size="sm" onClick={() => void runner.start()}>
              Resume
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
