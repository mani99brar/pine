'use client'

import { useState } from 'react'
import { formatAmount, formatDate, getEvidenceMechanism, shortSha } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { useWallet, type ClaimComposer } from '@pine/react'
import { ArrowRight, ChevronDown, Wallet } from 'lucide-react'
import { HashChip } from '@/components/ui/interactive'
import { KV, Note } from '@/components/ui/primitives'
import { Button } from '@/components/ui/Button'
import { QuestionText } from '@/components/claim/ClaimHeader'
import { STAGES, StageHeader, StageNav } from './shared'
import { cn } from '@/lib/cn'

export const ACK_KEY = (draftId: string) => `pine-field:ack:${draftId}`

export function StageReview({ c, acknowledged, setAcknowledged }: { c: ClaimComposer; acknowledged: boolean; setAcknowledged: (v: boolean) => void }) {
  const wallet = useWallet()
  const [openId, setOpenId] = useState<string | null>(null)
  const issues = c.validation.issues
  const plan = c.funding
  const chain = getChainOrDefault(c.fundingInput.chainId)
  const symbol = chain.collateral.symbol
  const src = c.draft.source
  const mech = getEvidenceMechanism(c.spec.evidence.mechanism)

  return (
    <div>
      <StageHeader stage="review">
        This is exactly what gets pinned and published. Once the market exists, none of it can change; a new commit or new wording needs a new claim.
      </StageHeader>

      {/* Blockers */}
      {issues.length > 0 ? (
        <section className="mb-8 rounded-[var(--radius-tile)] border-l-[3px] border-lumen bg-lumen-wash p-4" aria-labelledby="fix-title">
          <h3 id="fix-title" className="font-[700]">
            {issues.length === 1 ? 'One thing to fix before publishing' : `${issues.length} things to fix before publishing`}
          </h3>
          <ul className="mt-2 grid gap-1.5">
            {issues.map((i) => {
              const stage = STAGES.find((s) => s.id === i.stage)
              return (
                <li key={i.path + i.message} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[0.88rem]">
                  <span className="text-ink-2">{i.message}</span>
                  {stage && stage.id !== 'review' && (
                    <button type="button" onClick={() => c.setStage(stage.id)} className="inline-flex shrink-0 items-center gap-1 font-[650] underline underline-offset-2">
                      Fix in {stage.label.toLowerCase()} <ArrowRight size={13} aria-hidden />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ) : (
        <Note className="mb-8" title="Ready to publish">
          Every check passes. Read the question once more, then acknowledge the risks below.
        </Note>
      )}

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <section aria-labelledby="rq">
            <h3 id="rq" className="t-h3">
              The question
            </h3>
            {c.question ? (
              <QuestionText text={c.question.text} sha={src?.commit.sha} className="mt-3" />
            ) : (
              <p className="mt-2 text-ink-3">Pin a commit and choose a policy to generate it.</p>
            )}
          </section>

          <section aria-labelledby="rr">
            <h3 id="rr" className="t-h3">
              Immutable references
            </h3>
            <KV
              className="mt-2"
              rows={[
                { k: 'Title', v: c.spec.title || '—' },
                { k: 'Commit', v: src ? <HashChip value={src.commit.sha} display={`${src.owner}/${src.repo}@${shortSha(src.commit.sha)}`} label="commit" /> : '—' },
                { k: 'Policy', v: c.policy ? <HashChip value={c.policy.contentHash} display={`${c.policy.id}@${c.policy.version}`} label="policy" /> : '—' },
                { k: 'Environment', v: <HashChip value={c.spec.environment.envHash} label="env" /> },
                { k: 'Question hash', v: c.question ? <HashChip value={c.question.hash} label="hash" /> : '—' },
                {
                  k: 'Manifest hash',
                  v: c.manifestHash ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <HashChip value={c.manifestHash} label="keccak256" />
                      {!wallet.isConnected && <span className="text-[0.78rem] text-ink-3">Includes the creator address; connect your wallet so this is the final hash.</span>}
                    </span>
                  ) : (
                    '—'
                  ),
                },
                { k: 'Evidence', v: `${mech?.label ?? c.spec.evidence.mechanism}, before ${formatDate(c.spec.evidence.deadline, 'long')}` },
                { k: 'Oracle', v: `Opens ${formatDate(c.spec.oracle.openingTime, 'long')}; ${c.spec.oracle.minBond} ${c.spec.oracle.bondToken} minimum bond; fixed 3.5-day challenge window` },
                { k: 'Scope', v: `${c.spec.scope.inScope.length} in, ${c.spec.scope.outOfScope.length} out` },
              ]}
            />
          </section>

          {c.manifest && (
            <details className="rounded-[var(--radius-tile)] border border-line bg-sheet p-4">
              <summary className="font-[650]">The manifest that will be pinned</summary>
              <pre className="t-code mt-3 max-h-[24rem] overflow-auto whitespace-pre-wrap text-[0.74rem] [overflow-wrap:anywhere]">{JSON.stringify(c.manifest, null, 2)}</pre>
            </details>
          )}
        </div>

        <div className="grid min-w-0 content-start gap-6">
          {plan && (
            <section className="rounded-[var(--radius-tile)] border-[1.5px] border-ink bg-sheet p-5" aria-labelledby="rf">
              <h3 id="rf" className="t-h3">
                Money
              </h3>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-[0.86rem]">
                <div>
                  <dt className="text-ink-3">Liquidity at risk</dt>
                  <dd className="t-figure text-[1.3rem]">
                    {formatAmount(plan.totals.exposedToLoss, { maxDecimals: 2 })} <span className="font-sans text-[0.78rem] font-[450] text-ink-3">{symbol}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-3">Gas and fees</dt>
                  <dd className="t-figure text-[1.3rem]">
                    {formatAmount(plan.totals.nonRecoverable, { maxDecimals: 4 })} <span className="font-sans text-[0.78rem] font-[450] text-ink-3">{symbol}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-3">Maximum spend</dt>
                  <dd className="t-figure text-[1.3rem]">
                    {formatAmount(plan.totals.maxSpend, { maxDecimals: 2 })} <span className="font-sans text-[0.78rem] font-[450] text-ink-3">{symbol}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-3">Spending limit</dt>
                  <dd className={cn('t-figure text-[1.3rem]', !plan.withinLimit && 'text-flare-ink')}>
                    {formatAmount(plan.input.spendingLimit, { maxDecimals: 2 })} <span className="font-sans text-[0.78rem] font-[450] text-ink-3">{symbol}</span>
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-[0.8rem] text-ink-3">
                Approves exactly {plan.input.liquidity} {symbol}, never unlimited. Reserved if disputed: about {formatAmount(plan.totals.reservedIfDisputed, { maxDecimals: 2 })} {symbol}, paid by whoever answers or escalates.
              </p>
            </section>
          )}

          <section aria-labelledby="rd" className="rounded-[var(--radius-tile)] border border-line bg-sheet">
            <h3 id="rd" className="t-h3 px-5 pt-5">
              Risks you are accepting
            </h3>
            <ul className="mt-2 divide-y divide-line">
              {COPY.disclosures.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(openId === d.id ? null : d.id)}
                    aria-expanded={openId === d.id}
                    className="flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left text-[0.88rem] font-[600] hover:bg-fog-2/60"
                  >
                    {d.title}
                    <ChevronDown size={14} aria-hidden className={cn('shrink-0 transition-transform', openId === d.id && 'rotate-180')} />
                  </button>
                  {openId === d.id && <p className="px-5 pb-3 text-[0.84rem] text-ink-2">{d.body}</p>}
                </li>
              ))}
            </ul>
            <label className="flex cursor-pointer items-start gap-3 border-t-[1.5px] border-ink px-5 py-4">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--ink)]" />
              <span className="text-[0.88rem]">
                I have read these risks. I understand the liquidity is capital at risk and not a bounty, that No is not a correctness verdict, and that invalid is not a refund.
              </span>
            </label>
          </section>

          {!wallet.isConnected && (
            <Button variant="secondary" onClick={() => wallet.connect()} icon={<Wallet size={16} aria-hidden />}>
              {wallet.isDemo ? 'Connect demo wallet' : 'Connect wallet'}
            </Button>
          )}
        </div>
      </div>

      <StageNav c={c} nextLabel="Continue to publish" nextDisabled={!acknowledged || issues.length > 0} />
      {(!acknowledged || issues.length > 0) && (
        <p className="mt-2 text-right text-[0.8rem] text-ink-3">{issues.length > 0 ? 'Fix the items above to continue.' : 'Acknowledge the risks to continue.'}</p>
      )}
    </div>
  )
}
