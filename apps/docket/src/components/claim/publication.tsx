'use client'

import Link from 'next/link'
import { toast } from 'sonner'
import { useCallback, useMemo, useState } from 'react'
import type { Address, ClaimDetail, FundingInput, TxStep, TxStepId } from '@pine/core'
import { buildPublishSteps, formatClaimNumber, formatDate, prepareStepWithMarket, shortHash } from '@pine/core'
import { seerMarketUrl } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import {
  DEFAULT_INITIAL_YES_PRICE,
  DEFAULT_PRICE_RANGE,
  isManualStep,
  pineKeys,
  useAccount,
  useDrafts,
  usePine,
  useTxRunner,
  useWallet,
  type StepOutcome,
} from '@pine/react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Lock } from 'lucide-react'
import { Notice } from '@/components/ui/notice'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { TxSteps } from '@/components/tx/tx-steps'

export const STEP_COPY: Record<TxStepId, { label: string; description: string; kind: TxStep['kind']; freezesTerms?: boolean; optional?: boolean }> = {
  upload_manifest: {
    label: 'Pin the manifest',
    description: 'Store the claim manifest so anyone can retrieve and hash-check it.',
    kind: 'offchain',
  },
  create_market: {
    label: 'Create the market',
    description: 'Create the Seer market and its Reality.eth question. From this point the terms cannot change.',
    kind: 'transaction',
    freezesTerms: true,
  },
  approve_collateral: {
    label: 'Approve the exact collateral amount',
    description: COPY.exactApproval,
    kind: 'transaction',
  },
  split_position: {
    label: 'Split collateral into outcome tokens',
    description: 'Turn collateral into equal sets of Yes, No and Invalid result tokens for the pools.',
    kind: 'transaction',
  },
  add_liquidity_yes: {
    label: 'Add Yes liquidity',
    description: 'Supply Yes tokens and collateral to the Yes pool on the DEX.',
    kind: 'transaction',
  },
  add_liquidity_no: {
    label: 'Add No liquidity',
    description: 'Supply No tokens and collateral to the No pool on the DEX.',
    kind: 'transaction',
    optional: true,
  },
  register_claim: {
    label: 'Register the claim',
    description: 'Index the claim so it appears on the docket and in the agent API.',
    kind: 'offchain',
  },
  upload_evidence: {
    label: 'Store the exhibit',
    description: 'Store the exhibit package so jurors and answerers can retrieve and hash-check it.',
    kind: 'offchain',
  },
  submit_evidence: {
    label: 'File the exhibit on Ethereum',
    description: 'Record the exhibit with the Kleros arbitration contract on Ethereum mainnet. The block timestamp proves when it was filed.',
    kind: 'transaction',
  },
  redeem_positions: {
    label: 'Redeem outcome tokens',
    description: 'Burn winning outcome tokens and receive collateral under the market’s native payout rules.',
    kind: 'transaction',
  },
  approve_outcome_tokens: {
    label: 'Approve the exact outcome tokens',
    description: 'Allow the router to move exactly these outcome tokens, never an unlimited amount.',
    kind: 'transaction',
  },
}

const LIMIT_RE = /^\d+(\.\d{1,18})?$/
const validLimit = (v: string | undefined): v is string => !!v && LIMIT_RE.test(v) && Number(v) > 0

/** The market address recorded by a create_market step (demo executors and receipts both carry it). */
function marketFrom(result: unknown): Address | undefined {
  const r = result as { market?: unknown; marketAddress?: unknown } | undefined
  const m = r?.market ?? r?.marketAddress
  return typeof m === 'string' && /^0x[0-9a-fA-F]{40}$/.test(m) ? (m as Address) : undefined
}

type PublicationSteps = NonNullable<ClaimDetail['publication']>['steps']

/** Build the unfinished steps with the core planner. Offchain steps it does not produce fall back to their copy. */
function planRemaining(input: Parameters<typeof buildPublishSteps>[0] | undefined, steps: PublicationSteps): { remaining: TxStep[]; buildError?: string } {
  if (!input) return { remaining: [] }
  let built: TxStep[]
  try {
    built = buildPublishSteps(input)
  } catch (e) {
    return { remaining: [], buildError: e instanceof Error ? e.message : String(e) }
  }
  const remaining: TxStep[] = []
  for (const s of steps) {
    if (s.status === 'confirmed' || s.status === 'skipped') continue
    const step = built.find((b) => b.id === s.id)
    if (step) remaining.push(step)
    else if (STEP_COPY[s.id]?.kind === 'offchain') remaining.push({ id: s.id, ...STEP_COPY[s.id] })
    else return { remaining: [], buildError: `“${STEP_COPY[s.id]?.label ?? s.id}” cannot be prepared from the record, so finishing is disabled.` }
  }
  return { remaining }
}

export function PublicationRecovery({ claim }: { claim: ClaimDetail }) {
  const wallet = useWallet()
  const account = useAccount()
  const { drafts } = useDrafts()
  const { data, storage, demo } = usePine()
  const qc = useQueryClient()
  const pub = claim.publication
  const steps = useMemo(() => pub?.steps ?? [], [pub])
  const done = steps.filter((s) => s.status === 'confirmed' || s.status === 'skipped')
  // A filing started in this browser keeps its full funding plan in the draft.
  const draft = useMemo(() => drafts.find((d) => d.publication?.claimId === claim.id), [drafts, claim.id])

  // Never run without a limit: the claim's own, then the draft's, then the account default, then one typed here.
  const [typedLimit, setTypedLimit] = useState('')
  const recordedLimit = [claim.funding?.spendingLimit, draft?.funding?.spendingLimit, account.account?.preferences.defaultSpendingLimit].find(validLimit)
  const limitSource = recordedLimit
    ? recordedLimit === claim.funding?.spendingLimit
      ? 'the limit recorded when this filing started'
      : recordedLimit === draft?.funding?.spendingLimit
        ? 'the limit in your draft'
        : 'your account’s default spending limit'
    : undefined
  const [confirmedTyped, setConfirmedTyped] = useState<string | undefined>()
  const spendingLimit = recordedLimit ?? confirmedTyped

  const market = claim.market?.address ?? draft?.publication?.marketAddress
  const funding: FundingInput | undefined = useMemo(() => {
    const liquidity = claim.funding?.liquidity ?? draft?.funding?.liquidity
    if (!liquidity || !spendingLimit) return undefined
    const range = (draft?.funding?.priceRange ?? DEFAULT_PRICE_RANGE) as [number, number]
    const start = draft?.funding?.initialYesPrice ?? DEFAULT_INITIAL_YES_PRICE
    return {
      chainId: claim.chainId,
      liquidity,
      spendingLimit,
      initialYesPrice: Math.min(Math.max(start, range[0]), range[1]),
      priceRange: [range[0], range[1]],
    }
  }, [claim.chainId, claim.funding?.liquidity, draft?.funding, spendingLimit])

  const publishInput = useMemo(
    () =>
      funding
        ? {
            chainId: claim.chainId,
            manifestUri: claim.manifestUri,
            manifestHash: claim.manifestHash,
            question: claim.manifest.question,
            oracle: claim.manifest.claim.oracle,
            funding,
            creator: claim.creator,
            market,
            allowPlaceholderAddresses: demo,
          }
        : undefined,
    [claim.chainId, claim.manifestUri, claim.manifestHash, claim.manifest, claim.creator, funding, market, demo],
  )

  // The remaining steps, built by the same planner as a fresh filing: real calldata and exact amounts,
  // so the runner checks them against the limit before the wallet is asked to sign anything.
  const { remaining, buildError } = useMemo(() => planRemaining(publishInput, steps), [publishInput, steps])

  const unsendable = remaining.filter((s) => s.kind === 'transaction' && !s.request && !isManualStep(s) && s.id !== 'split_position')

  const prepare = useCallback(
    (step: TxStep, results: Partial<Record<TxStepId, unknown>>): TxStep => {
      if (!publishInput) throw new Error('Set a spending limit before finishing this filing.')
      const m = marketFrom(results.create_market) ?? publishInput.market
      if (step.id === 'split_position' && !m) {
        throw new Error('The market address is not known yet, so the split cannot be prepared. Reload the page once the market is confirmed.')
      }
      return m ? prepareStepWithMarket(step, { ...publishInput, market: m }) : step
    },
    [publishInput],
  )

  const handlers = useMemo(
    () => ({
      upload_manifest: async (): Promise<StepOutcome> => {
        const r = await storage.putJson(claim.manifest, `${claim.id}.manifest.json`)
        if (r.hash.toLowerCase() !== claim.manifestHash.toLowerCase()) {
          throw new Error(`Storage reported content hash ${r.hash}, but the manifest on record is ${claim.manifestHash}. Stopped so the published terms cannot differ.`)
        }
        return { result: { uri: r.uri, hash: r.hash } }
      },
    }),
    [storage, claim.manifest, claim.id, claim.manifestHash],
  )

  const runner = useTxRunner(`docket:finish:${claim.id}`, remaining, {
    // Without a limit on record the runner is given zero, so nothing can start until one is set below.
    spendingLimit: spendingLimit ?? '0',
    handlers,
    prepare,
    manualUrl: (step, results) => {
      const m = marketFrom(results.create_market) ?? market
      return isManualStep(step) && m ? seerMarketUrl(claim.chainId, m) : undefined
    },
    onDone: async (snap) => {
      // Demo mode: record the finished filing so the claim moves to its evidence window everywhere in this browser.
      const writer = data as unknown as { updateClaim?: (id: string, patch: Partial<ClaimDetail>) => void }
      if (typeof writer.updateClaim === 'function') {
        const now = new Date().toISOString()
        writer.updateClaim(claim.id, {
          status: 'open',
          publication: {
            resumable: false,
            steps: steps.map((s) => {
              const done = snap.steps.find((x) => x.id === s.id)
              return done ? { id: s.id, status: done.status === 'skipped' ? 'skipped' : 'confirmed', txHash: done.txHash, at: now } : s
            }),
          },
        })
      }
      await qc.invalidateQueries({ queryKey: pineKeys.claim(claim.id) })
      await qc.invalidateQueries({ queryKey: ['pine', 'claims'] })
      // This section disappears once the claim is open, so say what happened and show where it now stands.
      toast('Filing finished', { description: `${formatClaimNumber(claim.number)} is open for evidence.` })
      requestAnimationFrame(() => document.getElementById('standing')?.scrollIntoView({ block: 'start' }))
    },
  })
  const started = runner.steps.some((s) => s.status !== 'idle')
  const blockers = [
    ...(buildError ? [buildError] : []),
    ...(!claim.funding?.liquidity && !draft?.funding?.liquidity ? ['The planned liquidity for this filing is not on record, so the remaining amounts cannot be computed.'] : []),
    ...(!demo && unsendable.length > 0
      ? [`Contract addresses for this chain are unverified placeholders, so ${unsendable.map((s) => s.label).join(', ')} cannot be sent.`]
      : []),
  ]
  const marketCreated = steps.some((s) => s.id === 'create_market' && s.status === 'confirmed') || !!claim.market
  const isCreator = !!wallet.address && wallet.address.toLowerCase() === claim.creator.toLowerCase()

  if (claim.status === 'failed') {
    return (
      <div className="space-y-4">
        <Notice tone="critical" title="This filing failed and cannot be resumed">
          {pub?.note ?? 'Check the record below for anything that reached the chain.'}
        </Notice>
        <CompletedSteps steps={steps} />
        <p className="measure">
          To try again, start a new filing. Anything already on-chain stays there. A changed claim always needs a new market.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <p className="measure">
        {done.length} of {steps.length} filing steps are confirmed.{' '}
        {marketCreated ? (
          <>
            <Lock aria-hidden className="inline size-4 -translate-y-px" /> The market exists, so the terms are frozen. Finishing only adds the
            remaining funding.
          </>
        ) : (
          'The market has not been created, so the terms can still change.'
        )}
      </p>
      <CompletedSteps steps={steps.filter((s) => s.status === 'confirmed' || s.status === 'skipped')} />
      {!wallet.isConnected ? (
        <div className="flex flex-wrap items-center justify-between gap-4 border border-dashed border-rule-strong bg-sheet px-5 py-4">
          <p className="text-graphite">Connect the filer&rsquo;s wallet to finish filing.</p>
          <Button variant="secondary" onClick={() => wallet.connect()}>
            Connect wallet
          </Button>
        </div>
      ) : !isCreator ? (
        <Notice tone="neutral" title="Only the filer can finish this filing">
          The connected wallet ({shortHash(wallet.address ?? '', 4)}) did not file this claim. You can still read the terms and the record.
        </Notice>
      ) : (
        <div className="border border-rule bg-sheet p-5">
          <h3 className="text-lg font-bold">Finish filing</h3>
          <p className="mt-1 text-[15px] text-graphite">
            Each step asks your wallet to sign. Every amount is checked against your spending limit first.
          </p>
          {spendingLimit ? (
            <p className="mt-2 text-sm text-graphite">
              Spending limit {spendingLimit} {claim.collateralSymbol}
              {limitSource ? `, from ${limitSource}` : ', as you set it here'}.
            </p>
          ) : (
            <div className="mt-4 border-l-4 border-flag bg-flag-wash px-4 py-3">
              <p className="font-bold">Set a spending limit first</p>
              <p className="mt-1 text-[15px]">
                No limit is on record for this filing, and your account has no default. The remaining steps are checked against it before your
                wallet is asked to sign. You can also set a default on your <Link href="/account" className="link">account page</Link>.
              </p>
              <form
                className="mt-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (validLimit(typedLimit.trim())) setConfirmedTyped(typedLimit.trim())
                }}
              >
                <Field
                  id="finish-limit"
                  label="Spending limit for the remaining steps"
                  hint={`In ${claim.collateralSymbol}.`}
                  error={typedLimit && !validLimit(typedLimit.trim()) ? 'Enter an amount above zero, such as 300, with no currency sign.' : undefined}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id="finish-limit"
                      inputMode="decimal"
                      className="w-40"
                      value={typedLimit}
                      aria-invalid={!!typedLimit && !validLimit(typedLimit.trim())}
                      onChange={(e) => setTypedLimit(e.target.value)}
                    />
                    <Button type="submit" size="sm" disabled={!validLimit(typedLimit.trim())}>
                      Use this limit
                    </Button>
                  </div>
                </Field>
              </form>
            </div>
          )}
          {blockers.length > 0 && !started ? (
            <Notice tone="critical" className="mt-4" title="Finishing cannot start yet">
              <ul className="list-disc space-y-1 pl-5">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {spendingLimit ? (
            <TxSteps
              className="mt-4"
              runner={runner}
              startLabel="Finish filing"
              doneLabel="Filing finished"
              chainId={claim.chainId}
              spendingLimit={spendingLimit}
              symbol={claim.collateralSymbol}
              disabled={blockers.length > 0 && !started}
            />
          ) : null}
        </div>
      )}
    </div>
  )
}

function CompletedSteps({ steps }: { steps: NonNullable<ClaimDetail['publication']>['steps'] }) {
  if (steps.length === 0) return null
  return (
    <ul className="divide-y divide-rule border-y border-rule">
      {steps.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 text-[15px]">
          <span className="flex items-center gap-2">
            {s.status === 'confirmed' ? (
              <Check aria-hidden className="size-4" strokeWidth={3} />
            ) : (
              <span aria-hidden className="inline-block size-4" />
            )}
            <strong>{STEP_COPY[s.id]?.label ?? s.id}</strong>
          </span>
          <span className={s.status === 'failed' ? 'font-bold text-red' : 'text-graphite'}>
            {s.status === 'confirmed'
              ? 'Confirmed'
              : s.status === 'failed'
                ? `Failed${s.error ? `: ${s.error.replace(/\.+$/, '')}` : ''}`
                : s.status === 'skipped'
                  ? 'Skipped'
                  : 'Not started'}
            {s.at ? `, ${formatDate(s.at, 'long')}` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}
