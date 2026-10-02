'use client'

import * as React from 'react'
import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { ClaimDetail, FundingInput, TxStep } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { OUTCOME_META, buildPublishSteps, formatAmount, formatDate, nextStep, timeRemaining } from '@pine/core'
import { prepareStepWithMarket } from '@pine/core'
import { pineKeys, usePine, usePortfolio, useRedeem, useTxRunner, useWallet } from '@pine/react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { TxLog } from '@/components/ui/tx-log'
import { StatusDot } from './status'

/** The outcome, reported plainly. YES is alarm (flare), NO is held (slate), invalid is violet. */
export function OutcomePanel({ claim }: { claim: ClaimDetail }) {
  if (!claim.outcome || (claim.status !== 'resolved' && claim.status !== 'settled')) return null
  const meta = OUTCOME_META[claim.outcome]
  const tone = claim.outcome
  return (
    <section
      aria-label="Outcome"
      className={cn(
        'border-b px-4 py-4 sm:px-6',
        tone === 'yes' && 'border-flare/30 bg-flare-soft',
        tone === 'no' && 'border-slate/30 bg-slate-soft',
        tone === 'invalid' && 'border-violet/30 bg-violet-soft',
      )}
    >
      <div className="flex items-start gap-3">
        <StatusDot status="resolved" outcome={claim.outcome} size={18} className="mt-1" />
        <div className="min-w-0">
          <p className="text-[13px] text-muted">Final outcome</p>
          <p className="stretch-wide text-xl font-[650] leading-tight">{meta.label}</p>
          <p className="mt-1 max-w-[80ch] text-[13.5px] text-bark">{meta.long}</p>
          {tone === 'no' ? <p className="mt-1 max-w-[80ch] text-[13px] text-muted">{COPY.noIsNotSafety}</p> : null}
          {tone === 'invalid' ? (
            <p className="mt-1 max-w-[80ch] text-[13px] text-muted">
              Only the Invalid result token redeems; Yes and No tokens pay nothing. {COPY.invalidIsNotRefund}
            </p>
          ) : null}
          {tone === 'yes' ? (
            <p className="mt-1 max-w-[80ch] text-[13px] text-muted">
              Read the accepted evidence before deciding what to change. {COPY.noMergeAuthority}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}

export function NextStepCard({ claim, now }: { claim: ClaimDetail; now: Date }) {
  const s = nextStep(claim, now)
  const rem = s.at ? timeRemaining(s.at, now) : undefined
  const ACTOR: Record<typeof s.actor, string> = {
    anyone: 'Anyone',
    investigators: 'Investigators',
    answerers: 'Oracle answerers',
    creator: 'You (creator)',
    arbitrator: 'Kleros jurors',
    holders: 'Token holders',
  }
  return (
    <div className="px-4 py-4">
      <p className="stretch-cond text-[12.5px] text-muted">Next step</p>
      <p className="mt-1 text-[14.5px] font-semibold leading-snug">{s.title}</p>
      <p className="mt-1 text-[13px] text-muted">{s.detail}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <span className="rounded-chip border border-line px-1.5 text-muted">{ACTOR[s.actor]}</span>
        {s.at && rem ? (
          <span className={cn('tnum', !rem.past && rem.ms < 48 * 3600_000 ? 'font-medium text-resin' : 'text-muted')}>
            {rem.past ? `${rem.label} ago` : `in ${rem.label}`} ({formatDate(s.at, 'utc')})
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** The viewer's outcome tokens and LP positions on this claim, with redeem when it pays out. */
export function PositionPanel({ claim }: { claim: ClaimDetail }) {
  const wallet = useWallet()
  const portfolio = usePortfolio(wallet.address)
  const positions = (portfolio.data?.positions ?? []).filter((p) => p.claimId === claim.id)
  const lps = (portfolio.data?.liquidity ?? []).filter((p) => p.claimId === claim.id)
  const redeemable = positions.some((p) => p.redeemable)
  const sym = claim.collateralSymbol
  if (!wallet.isConnected) {
    return (
      <div className="px-4 py-4">
        <p className="stretch-cond text-[12.5px] text-muted">My position</p>
        <p className="mt-1 text-[13px] text-muted">Connect a wallet to see your outcome tokens and liquidity on this claim.</p>
        <Button variant="secondary" size="sm" className="mt-2" onClick={() => wallet.connect()}>
          Connect wallet
        </Button>
      </div>
    )
  }
  return (
    <div className="px-4 py-4">
      <p className="stretch-cond text-[12.5px] text-muted">My position</p>
      {portfolio.isLoading ? (
        <p className="mt-1 text-[13px] text-muted">Loading…</p>
      ) : positions.length === 0 && lps.length === 0 ? (
        <p className="mt-1 text-[13px] text-muted">No tokens or liquidity on this claim from this wallet.</p>
      ) : (
        <ul className="mt-1.5 space-y-1.5 text-[13px]">
          {positions.map((p) => (
            <li key={p.outcome} className="flex items-baseline justify-between gap-2">
              <span>
                {p.outcome === 'yes' ? 'Yes' : p.outcome === 'no' ? 'No' : 'Invalid result'}{' '}
                <span className="tnum text-muted">{formatAmount(p.balance, { maxDecimals: 2 })} tokens</span>
              </span>
              <span className="tnum">
                {p.redeemable ? (
                  <span className="font-medium text-needle">{formatAmount(p.redeemableAmount ?? p.value, { symbol: sym })} redeemable</span>
                ) : (
                  formatAmount(p.value, { symbol: sym })
                )}
              </span>
            </li>
          ))}
          {lps.map((l) => (
            <li key={l.tokenId} className="flex items-baseline justify-between gap-2">
              <span>
                LP {l.outcome.toUpperCase()} <span className="text-muted">{l.inRange ? 'in range' : 'out of range'}</span>
              </span>
              <span className="tnum">{formatAmount(l.currentValue, { symbol: sym })}</span>
            </li>
          ))}
        </ul>
      )}
      {redeemable ? <RedeemControl claim={claim} /> : null}
      {lps.length ? <p className="mt-2 text-[11.5px] text-muted">LP positions stay withdrawable on the DEX. Withdrawing returns their current value, which can be below what was deposited.</p> : null}
    </div>
  )
}

function RedeemControl({ claim }: { claim: ClaimDetail }) {
  const { runner, redeemable } = useRedeem(claim.id)
  const [open, setOpen] = React.useState(false)
  return (
    <div className="mt-3">
      {!open ? (
        <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
          Redeem {formatAmount(redeemable, { symbol: claim.collateralSymbol })}
        </Button>
      ) : (
        <TxLog runner={runner} title="Redeem" startLabel="Redeem" compact />
      )}
    </div>
  )
}

/** Builds the remaining publication steps for a partially published claim. */
function useRecoverySteps(claim: ClaimDetail): TxStep[] {
  return React.useMemo(() => {
    if (!claim.publication) return []
    const chainId = claim.chainId
    const funding: FundingInput = {
      chainId,
      liquidity: claim.funding?.liquidity ?? claim.liquidity,
      spendingLimit: claim.funding?.spendingLimit ?? claim.liquidity,
      initialYesPrice: claim.yesPrice ?? 0.15,
      priceRange: [0.02, 0.8],
    }
    const input = {
      chainId,
      manifestUri: claim.manifestUri,
      manifestHash: claim.manifestHash,
      question: claim.manifest.question,
      oracle: claim.manifest.claim.oracle,
      funding,
      creator: claim.creator,
    }
    let all: TxStep[]
    try {
      all = buildPublishSteps(input)
    } catch {
      return []
    }
    const done = new Set(claim.publication.steps.filter((s) => s.status === 'confirmed' || s.status === 'skipped').map((s) => s.id))
    return all
      .filter((s) => !done.has(s.id))
      .map((s) => (claim.marketAddress ? prepareStepWithMarket(s, { ...input, market: claim.marketAddress }) : s))
  }, [claim])
}

/** "Finish publishing": resumes a partially published claim from the first incomplete step. */
export function RecoveryPanel({ claim }: { claim: ClaimDetail }) {
  const { data } = usePine()
  const qc = useQueryClient()
  const wallet = useWallet()
  const steps = useRecoverySteps(claim)
  const runner = useTxRunner(`recover:${claim.id}`, steps, {
    spendingLimit: claim.funding?.spendingLimit,
    onDone: async () => {
      const writer = data as unknown as { updateClaim?: (id: string, patch: Partial<ClaimDetail>) => void }
      writer.updateClaim?.(claim.id, { status: 'open', publication: undefined })
      await qc.invalidateQueries({ queryKey: pineKeys.all })
      toast.success('Publishing finished', { description: 'The claim is open for evidence.' })
    },
  })
  if (claim.status !== 'publishing' || !claim.publication) return null
  const prior = claim.publication.steps
  return (
    <section aria-labelledby="recover-h" className="border-b border-resin/40 bg-resin-soft/60 px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-[320px]">
          <h2 id="recover-h" className="text-[15px] font-semibold">
            Finish publishing
          </h2>
          <p className="mt-1 text-[13.5px] text-bark">
            {claim.publication.note ??
              'Publishing stopped part-way. Steps already confirmed stay on-chain; the rest can be resumed from here.'}
          </p>
          <ul className="mt-2 space-y-0.5 text-[12.5px]">
            {prior.map((s) => (
              <li key={s.id} className="flex items-center gap-2">
                <span className={cn('mono-cond w-3 text-center', s.status === 'confirmed' ? 'text-needle' : s.status === 'failed' ? 'text-flare' : 'text-faint')} aria-hidden>
                  {s.status === 'confirmed' ? '✓' : s.status === 'failed' ? '✕' : '·'}
                </span>
                <span className="mono-cond text-[11.5px]">{s.id}</span>
                <span className="text-muted">{s.status}</span>
                {s.error ? <span className="wrap-anywhere text-flare">{s.error}</span> : null}
              </li>
            ))}
          </ul>
          <Callout tone="frozen" className="mt-3">
            {COPY.frozenTerms}
          </Callout>
        </div>
        <div className="min-w-0 flex-1 basis-[340px]">
          {!wallet.isConnected ? (
            <div className="rounded-ctl border border-line bg-surface p-3 text-[13px]">
              <p>Connect the creator wallet to resume.</p>
              <Button variant="primary" size="sm" className="mt-2" onClick={() => wallet.connect()}>
                Connect wallet
              </Button>
            </div>
          ) : steps.length ? (
            <TxLog runner={runner} title="Remaining steps" startLabel="Resume publishing" compact />
          ) : (
            <p className="text-[13px] text-muted">No remaining steps could be rebuilt for this claim.</p>
          )}
          <p className="mt-2 text-[12px] text-muted">
            Prefer to stop here? The market exists; you can leave it unfunded. See <Link href="/drafts" className="text-needle hover:underline">drafts and publications</Link>.
          </p>
        </div>
      </div>
    </section>
  )
}

export function FailedPanel({ claim }: { claim: ClaimDetail }) {
  if (claim.status !== 'failed') return null
  const confirmed = claim.publication?.steps.filter((s) => s.status === 'confirmed') ?? []
  return (
    <section aria-labelledby="failed-h" className="border-b border-flare/30 bg-flare-soft px-4 py-4 sm:px-6">
      <h2 id="failed-h" className="text-[15px] font-semibold">
        Publication failed and cannot be resumed
      </h2>
      <p className="mt-1 max-w-[80ch] text-[13.5px]">
        {claim.publication?.note ?? 'A required step failed in a way that cannot be retried.'}{' '}
        {confirmed.length
          ? `Already on-chain: ${confirmed.map((s) => s.id).join(', ')}. Nothing else was spent.`
          : 'Nothing reached the chain, so nothing was spent beyond any failed transaction gas.'}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button asChild variant="primary" size="sm">
          <Link href={`/new?source=${encodeURIComponent(`${claim.source.owner}/${claim.source.repo}@${claim.source.commitSha}`)}`}>
            Start a new verification for this commit
          </Link>
        </Button>
      </div>
    </section>
  )
}
