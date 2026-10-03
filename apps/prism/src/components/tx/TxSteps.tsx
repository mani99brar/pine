'use client'

import { useState } from 'react'
import type { Hex } from '@pine/core'
import { explorerTxUrl, shortHash } from '@pine/core'
import type { TxRunner, TxRunnerStep } from '@pine/react'
import { motion } from 'motion/react'
import { ExternalLink as ExtIcon, Lock, PenLine } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useReduceMotion } from '@/lib/hooks'
import { cn } from '@/lib/cn'

const STATUS_TEXT: Record<string, string> = {
  idle: 'Waiting',
  awaiting_signature: 'Confirm in your wallet',
  pending: 'Waiting for confirmation',
  confirmed: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
}

/** A facet-shaped node: outline when waiting, lit when done, cracked red when failed. */
function Node({ s, active }: { s: TxRunnerStep; active: boolean }) {
  const reduce = useReduceMotion()
  const lit = s.status === 'confirmed'
  const failed = s.status === 'failed'
  const busy = s.status === 'pending' || s.status === 'awaiting_signature'
  return (
    <span className="relative z-[1] flex h-8 w-8 shrink-0 items-center justify-center">
      <svg viewBox="0 0 32 32" width={32} height={32} aria-hidden>
        <polygon
          points="16,2 28,10 28,22 16,30 4,22 4,10"
          fill={lit ? '#F5EDE4' : failed ? 'rgba(255,107,131,0.12)' : '#0e0a09'}
          stroke={failed ? '#FF6B83' : lit ? '#F5EDE4' : active || busy ? '#5AD8FF' : 'rgba(255,228,206,0.3)'}
          strokeWidth="1.5"
          strokeDasharray={s.status === 'skipped' ? '3 3' : undefined}
        />
        {lit && <path d="M10.5 16.5 L14.5 20 L21.5 12.5" fill="none" stroke="#16110f" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />}
        {failed && <path d="M9 13 L14 17 L17 13 L23 19" fill="none" stroke="#FF6B83" strokeWidth="1.8" strokeLinecap="round" />}
      </svg>
      {busy && !reduce && (
        <motion.span
          aria-hidden
          className="absolute inset-0 rounded-full"
          style={{ boxShadow: '0 0 0 2px rgba(90,216,255,0.5)' }}
          animate={{ scale: [1, 1.35], opacity: [0.8, 0] }}
          transition={{ duration: 1.2, repeat: Infinity }}
        />
      )}
      {s.status === 'awaiting_signature' && <PenLine size={12} aria-hidden className="absolute -right-1 -top-1 text-hb" />}
    </span>
  )
}

/** Deep links can be long; show them as short, inert links. */
function Description({ text }: { text: string }) {
  const parts = text.split(/(https:\/\/[^\s]+)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (!/^https:\/\//.test(part)) return <span key={i}>{part}</span>
        const url = part.replace(/[.,;)]+$/, '')
        let label = url
        try {
          const u = new URL(url)
          label = u.host
        } catch {
          /* keep raw */
        }
        return (
          <a key={i} href={url} target="_blank" rel="noopener noreferrer nofollow" className="link inline-flex items-center gap-0.5" title={url}>
            {label}
            <ExtIcon size={11} aria-hidden />
          </a>
        )
      })}
    </>
  )
}

function ManualStep({ runner, step }: { runner: TxRunner; step: TxRunnerStep }) {
  const [hash, setHash] = useState('')
  const valid = hash === '' || /^0x[0-9a-fA-F]{64}$/.test(hash.trim())
  return (
    <div className="cut-md mt-3 border border-[rgba(255,182,72,0.4)] bg-[rgba(255,182,72,0.06)] p-3.5 text-[0.875rem]">
      <p className="text-lumen-2">This step happens on the DEX, the same way Seer adds liquidity. Add the position there, then come back and mark it done.</p>
      <label className="mt-3 block text-[0.8125rem] font-semibold text-lumen" htmlFor={`manual-${step.id}`}>
        Transaction hash <span className="font-normal text-lumen-3">optional, lets Pine link and reconcile it</span>
      </label>
      <input
        id={`manual-${step.id}`}
        value={hash}
        onChange={(e) => setHash(e.target.value)}
        placeholder="0x…"
        spellCheck={false}
        aria-invalid={!valid}
        className="field t-code mt-1.5 min-h-[2.5rem]"
      />
      {!valid && <p className="mt-1 text-[0.78rem] text-ha">A transaction hash is 0x followed by 64 hex characters.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {step.actionUrl && (
          <a href={step.actionUrl} target="_blank" rel="noopener noreferrer nofollow" className="btn btn-glass btn-sm">
            Open the DEX <ExtIcon size={13} aria-hidden />
          </a>
        )}
        <Button size="sm" disabled={!valid} onClick={() => void runner.confirmManual(step.id, hash.trim() ? (hash.trim() as Hex) : undefined)}>
          Mark done
        </Button>
        {step.optional && (
          <Button size="sm" variant="ghost" onClick={() => runner.skip(step.id)}>
            Skip for now
          </Button>
        )}
      </div>
    </div>
  )
}

/** Steps of any resumable run (publish, finish funding, evidence, redeem), lit one facet at a time. */
export function TxSteps({ runner, chainId, className }: { runner: TxRunner; chainId?: number; className?: string }) {
  const currentId = runner.current?.id
  return (
    <ol className={cn('relative', className)} aria-label="Transaction steps">
      {runner.steps.map((s, i) => {
        const last = i === runner.steps.length - 1
        const active = s.id === currentId
        const awaitingManual = runner.awaitingManual === s.id
        return (
          <li key={s.id} className="relative grid grid-cols-[2rem_1fr] gap-x-3.5 pb-6 last:pb-0" aria-current={active ? 'step' : undefined}>
            {!last && (
              <span
                aria-hidden
                className="absolute bottom-0 left-[15px] top-8 w-[2px]"
                style={{ background: s.status === 'confirmed' ? 'linear-gradient(180deg,#f5ede4,rgba(245,237,228,0.4))' : 'rgba(255,228,206,0.14)' }}
              />
            )}
            <Node s={s} active={active} />
            <div className="min-w-0 pt-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <p className="font-semibold text-lumen">
                  {s.label}
                  {s.optional && <span className="ml-1.5 text-[0.78rem] font-normal text-lumen-3">optional</span>}
                </p>
                <p className={cn('text-[0.8125rem] font-medium', s.status === 'failed' ? 'text-ha' : s.status === 'confirmed' ? 'text-lumen-2' : awaitingManual ? 'text-na' : 'text-lumen-3')} aria-live={active ? 'polite' : undefined}>
                  {awaitingManual ? 'Waiting for you' : STATUS_TEXT[s.status]}
                </p>
              </div>
              <p className="mt-1 text-[0.875rem] leading-[1.5] text-lumen-2 [overflow-wrap:anywhere]">
                <Description text={s.description} />
              </p>
              {((s.collateralCost && Number(s.collateralCost.amount) > 0) || (s.estimatedCost && Number(s.estimatedCost.amount) > 0)) && (
                <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-lumen-3">
                  {s.collateralCost && Number(s.collateralCost.amount) > 0 && (
                    <span>
                      Moves <span className="tnum font-semibold text-lumen">{s.collateralCost.amount}</span> {s.collateralCost.currency} into the market
                    </span>
                  )}
                  {s.estimatedCost && Number(s.estimatedCost.amount) > 0 && (
                    <span>
                      Estimated gas <span className="tnum text-lumen-2">{s.estimatedCost.amount}</span> {s.estimatedCost.currency}
                    </span>
                  )}
                </p>
              )}
              {s.txHash && (
                <a
                  href={explorerTxUrl(s.request?.chainId ?? chainId ?? 100, s.txHash)}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="link mt-1.5 inline-flex items-center gap-1 text-[0.8125rem] text-lumen-2"
                >
                  Transaction {shortHash(s.txHash)} <ExtIcon size={11} aria-hidden />
                </a>
              )}
              {s.error && (
                <p role="alert" className="untrusted cut-sm mt-2 border border-[rgba(255,107,131,0.4)] bg-[rgba(255,107,131,0.08)] px-3 py-2 text-[0.84375rem] text-ha [white-space:normal]">
                  {s.error}
                </p>
              )}
              {awaitingManual && <ManualStep runner={runner} step={s} />}
              {s.freezesTerms && (
                <p className="tag mt-2.5 gap-1.5">
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
