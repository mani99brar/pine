'use client'

import { Check, ExternalLink as ExternalIcon, Hand, Loader2, Lock, PenLine, RotateCcw, X, SkipForward } from 'lucide-react'
import { useState } from 'react'
import type { Hex } from '@pine/core'
import type { TxRunner, TxRunnerStep } from '@pine/react'
import { explorerTxUrl, formatAmount, shortHash } from '@pine/core'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { ExternalLink } from '@/components/ui/external-link'

const STATUS_TEXT: Record<string, string> = {
  idle: 'Not started',
  manual: 'Waiting for you to finish this on the DEX',
  awaiting_signature: 'Waiting for your signature in the wallet',
  pending: 'Submitted, waiting for confirmation',
  confirmed: 'Confirmed',
  failed: 'Failed',
  skipped: 'Skipped',
}

function StepMarker({ step, n, awaiting }: { step: TxRunnerStep; n: number; awaiting?: boolean }) {
  const base = 'flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-[800] tabular'
  if (awaiting)
    return (
      <span className={cn(base, 'bg-flag text-ink ring-4 ring-flag-wash')}>
        <Hand aria-hidden className="size-4" strokeWidth={2.5} />
      </span>
    )
  switch (step.status) {
    case 'confirmed':
      return (
        <span className={cn(base, 'bg-ink text-white')}>
          <Check aria-hidden className="size-4" strokeWidth={3} />
        </span>
      )
    case 'pending':
      return (
        <span className={cn(base, 'bg-violet text-white')}>
          <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" strokeWidth={3} />
        </span>
      )
    case 'awaiting_signature':
      return (
        <span className={cn(base, 'bg-flag text-ink ring-4 ring-flag-wash')}>
          <PenLine aria-hidden className="size-4" strokeWidth={2.5} />
        </span>
      )
    case 'failed':
      return (
        <span className={cn(base, 'bg-red text-white')}>
          <X aria-hidden className="size-4" strokeWidth={3} />
        </span>
      )
    case 'skipped':
      return (
        <span className={cn(base, 'border-2 border-dashed border-rule-strong text-graphite')}>
          <SkipForward aria-hidden className="size-3.5" />
        </span>
      )
    default:
      return <span className={cn(base, 'border-2 border-rule-strong bg-sheet text-graphite')}>{n}</span>
  }
}

function ManualConfirm({ onConfirm }: { onConfirm: (hash?: Hex) => void }) {
  const [hash, setHash] = useState('')
  const valid = hash === '' || /^0x[0-9a-fA-F]{64}$/.test(hash.trim())
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="text-sm font-bold">
          Transaction hash <span className="font-normal text-graphite">(optional)</span>
        </span>
        <input
          value={hash}
          onChange={(e) => setHash(e.target.value)}
          placeholder="0x…"
          aria-invalid={!valid}
          className="mt-1 block h-10 w-64 max-w-full rounded-xs border-2 border-ink bg-sheet px-2 font-mono text-[13px] aria-[invalid=true]:border-red"
        />
      </label>
      <Button size="sm" disabled={!valid} onClick={() => onConfirm(hash.trim() ? (hash.trim() as Hex) : undefined)}>
        Mark done and continue
      </Button>
      {!valid ? <p className="w-full text-sm text-red">A transaction hash is 0x followed by 64 hexadecimal characters.</p> : null}
    </div>
  )
}

/**
 * Step descriptions from the planner end manual DEX steps with an internal note and a raw URL
 * ("Completed via Seer liquidity interface — deep link. https://…"). The "Open the DEX" button already
 * carries that link, so the sentence is dropped from what people read.
 */
function readableDescription(text: string): string {
  return text
    .replace(/\s*Completed via [^.]*?deep link\.\s*(https?:\/\/\S+)?/gi, ' ')
    .replace(/\s+(https?:\/\/\S+)\s*$/i, '')
    .trim()
}

/** Wallet errors are written for developers. Say what happened and what it cost. */
function readableError(error: string): string {
  if (/user (rejected|denied)|rejected the request|request rejected|denied transaction/i.test(error)) {
    return 'Your wallet declined to sign this step, so nothing was sent and nothing was spent. Retry when you are ready.'
  }
  return error
}

/**
 * Ordered transaction steps with live status. Steps are numbered because they run in sequence.
 */
export function TxSteps({
  runner,
  startLabel = 'Start',
  doneLabel = 'Done',
  chainId,
  spendingLimit,
  symbol,
  disabled,
  disabledReason,
  className,
}: {
  runner: TxRunner
  startLabel?: string
  doneLabel?: string
  chainId?: number
  spendingLimit?: string
  symbol?: string
  disabled?: boolean
  disabledReason?: string
  className?: string
}) {
  const failed = runner.steps.find((s) => s.status === 'failed')
  return (
    <div className={className}>
      <ol className="space-y-0">
        {runner.steps.map((s, i) => {
          const active = s.status === 'awaiting_signature' || s.status === 'pending' || runner.awaitingManual === s.id
          return (
            <li
              key={s.id}
              className={cn(
                'relative flex gap-4 border-l-4 py-3 pr-3 pl-4',
                active ? 'border-violet bg-violet-wash' : s.status === 'failed' ? 'border-red bg-red-wash' : 'border-transparent',
              )}
              aria-current={active ? 'step' : undefined}
            >
              <StepMarker step={s} n={i + 1} awaiting={runner.awaitingManual === s.id} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-bold">
                  {s.label}
                  {s.optional ? <span className="text-sm font-normal text-graphite">(optional)</span> : null}
                  {s.freezesTerms ? (
                    <span className="inline-flex items-center gap-1 rounded-xs bg-ink px-1.5 py-px text-xs font-bold text-white">
                      <Lock aria-hidden className="size-3" /> Terms freeze here
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-[15px] leading-6 text-graphite [overflow-wrap:anywhere]">{readableDescription(s.description)}</p>
                <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <span className={cn('font-bold', s.status === 'failed' ? 'text-red' : s.status === 'confirmed' ? 'text-ink' : 'text-graphite')}>
                    {runner.awaitingManual === s.id ? STATUS_TEXT.manual : (STATUS_TEXT[s.status] ?? s.status)}
                  </span>
                  {s.manual && s.status === 'idle' ? <span className="text-graphite">Done on the DEX, then marked complete</span> : null}
                  {s.estimatedCost ? (
                    <span className="text-graphite">
                      Estimated cost {formatAmount(s.estimatedCost.amount, { symbol: s.estimatedCost.currency, maxDecimals: 6 })}
                    </span>
                  ) : null}
                  {s.txHash ? (
                    chainId ? (
                      <ExternalLink href={explorerTxUrl(chainId, s.txHash)}>Transaction {shortHash(s.txHash, 4)}</ExternalLink>
                    ) : (
                      <code className="font-mono text-[13px]">{shortHash(s.txHash, 6)}</code>
                    )
                  ) : null}
                </p>
                {s.manual && runner.awaitingManual === s.id ? (
                  <div className="mt-3 border border-violet-line bg-sheet p-3">
                    <p className="text-[15px]">
                      Liquidity is added on the exchange (the DEX), not by Pine, the same way Seer&rsquo;s own interface does it. Open the DEX in a
                      new tab, supply the outcome tokens and collateral there, then come back and mark this step done.
                    </p>
                    <div className="mt-3 flex flex-wrap items-end gap-3">
                      {s.actionUrl ? (
                        <a
                          href={s.actionUrl}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          className="inline-flex h-10 items-center gap-2 rounded-sm border border-rule-strong bg-sheet px-3 text-sm font-bold no-underline shadow-[0_2px_0_var(--color-rule)] hover:bg-bond"
                        >
                          <ExternalIcon aria-hidden className="size-4" /> Open the DEX
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      ) : null}
                      <ManualConfirm onConfirm={(hash) => void runner.confirmManual(s.id, hash)} />
                      {s.optional ? (
                        <Button size="sm" variant="quiet" onClick={() => runner.skip(s.id)}>
                          Skip this optional step
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {s.status === 'failed' && s.error ? (
                  <p className="mt-1 text-sm text-red" role="alert">
                    {readableError(s.error)}
                  </p>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>

      {runner.error ? (
        <p className="mt-3 border-l-4 border-red bg-red-wash px-3 py-2 text-[15px] font-bold text-red" role="alert">
          {readableError(runner.error)}
        </p>
      ) : null}
      {runner.limit && !runner.limit.within ? (
        <p className="mt-3 border-l-4 border-red bg-red-wash px-3 py-2 text-[15px] text-ink" role="alert">
          These steps need {formatAmount(runner.limit.required, { symbol: runner.limit.currency })}, which is more than your{' '}
          {formatAmount(runner.limit.limit, { symbol: runner.limit.currency })} spending limit. Raise the limit or lower the amount first.
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-rule pt-4" aria-live="polite">
        {runner.state === 'idle' ? (
          <Button onClick={() => void runner.start()} disabled={disabled}>
            {startLabel}
          </Button>
        ) : null}
        {runner.state === 'running' ? (
          <Button disabled icon={<Loader2 aria-hidden className="motion-safe:animate-spin" />}>
            Working through the steps
          </Button>
        ) : null}
        {(runner.state === 'failed' || runner.state === 'paused') && !runner.awaitingManual ? (
          <>
            <Button onClick={() => void runner.retry()} icon={<RotateCcw aria-hidden />} disabled={disabled}>
              {failed ? `Retry: ${failed.label}` : 'Resume'}
            </Button>
            {failed?.optional ? (
              <Button variant="secondary" onClick={() => runner.skip(failed.id)}>
                Skip this optional step
              </Button>
            ) : null}
          </>
        ) : null}
        {runner.state === 'done' ? (
          <p className="inline-flex items-center gap-2 font-bold">
            <Check aria-hidden className="size-5" strokeWidth={3} /> {doneLabel}
          </p>
        ) : null}
        {spendingLimit && symbol ? (
          <p className="text-sm text-graphite">
            Spent so far {formatAmount(runner.spent || '0', { symbol, maxDecimals: 4 })} of your{' '}
            {formatAmount(spendingLimit, { symbol })} limit
          </p>
        ) : null}
        {disabled && disabledReason ? <p className="w-full text-sm font-bold text-red">{disabledReason}</p> : null}
      </div>
    </div>
  )
}
