'use client'

import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import type { IsoDate } from '@pine/core'
import { formatAmount, formatDate, fromScaled } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import type { ClaimComposer, VerifiedPreview } from '@pine/react'
import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { HashChip } from '@/components/ui/interactive'
import { Notice } from '@/components/ui/primitives'
import { issuesFor, StageHeader, StageNav, UI_STEPS, type StepNav, type UiStep } from '../shared'
import { useApiPublication } from './context'
import { ApiIdentityGate, identityReady, useApiIdentity } from './identity'
import { WriteErrorNotice } from './WriteError'

// Review in api mode: Pine freezes the claim document (preview) only after the explicit live-system attestation; the
// browser verifies the preview (digest, CID, question, token names, creator, deployment, composed terms) and only the
// verified values are shown here, as plain text. Any verification issue blocks publishing with its message.

const isoOf = (unix: number): IsoDate => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const UINT = /^(?:0|[1-9][0-9]{0,77})$/

/** Steps where a publication has started: the review cannot be redone, only followed. */
const PUBLISHING = new Set(['publishing', 'confirming', 'confirmed', 'failed', 'expired'])

export const ATTESTATION_TEXT = 'I attest no counterexample would demonstrate an exploitable flaw in a deployed system holding third-party funds or data.'

function membershipText(m: VerifiedPreview['document']['target']['membership']): string {
  const ref = m.ref.kind === 'pull' ? `pull request #${m.ref.number}` : `branch ${m.ref.name}`
  if (m.method === 'pull_head') return `Head commit of ${ref}`
  if (m.method === 'pull_commit') return `A commit of ${ref}`
  return `In the history of ${ref}`
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="pt-0.5 text-[0.84375rem] text-lumen-3">{label}</dt>
      <dd className="min-w-0 text-[0.9375rem] text-lumen [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

function Costs({ costs }: { costs: VerifiedPreview['costs'] }) {
  if (!costs) return <p className="text-[0.875rem] text-lumen-3">Pine gave no gas estimate.</p>
  const gas = costs.estimatedGas && UINT.test(costs.estimatedGas) ? formatAmount(costs.estimatedGas, { maxDecimals: 0 }) : null
  const price = costs.gasPriceWei && UINT.test(costs.gasPriceWei) ? formatAmount(fromScaled(BigInt(costs.gasPriceWei), 9), { maxDecimals: 3 }) : null
  const total = costs.estimatedCostWei && UINT.test(costs.estimatedCostWei) ? formatAmount(fromScaled(BigInt(costs.estimatedCostWei), 18), { maxDecimals: 6 }) : null
  return (
    <div>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[minmax(9rem,max-content)_1fr]">
        <Fact label="Estimated gas">{gas ?? '—'}</Fact>
        <Fact label="Gas price">{price ? `${price} gwei` : 'unknown'}</Fact>
        <Fact label="Estimated cost">{total ? `about ${total} xDAI` : 'unknown'}</Fact>
        <Fact label="Value sent">0 xDAI, no token approval</Fact>
      </dl>
      {costs.note && <p className="mt-2 text-[0.8125rem] text-lumen-3">{costs.note}</p>}
    </div>
  )
}

/** The verified preview: only values the browser re-derived from the frozen document (plain text). */
function PreviewPanel({ preview, chainId }: { preview: VerifiedPreview; chainId: number }) {
  const doc = preview.document
  const t = preview.timeline
  const arb = getChainOrDefault(chainId).arbitration
  const repo = doc.target.repository
  return (
    <div className="grid gap-6">
      <div className="cut-xl well relative overflow-hidden p-5 sm:p-6">
        <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: 'linear-gradient(180deg,#5ad8ff,#ffb648,#ff6b83)' }} />
        <p className="text-[0.8125rem] text-lumen-3">The market question, verified</p>
        <p className="mt-2 text-[1.0625rem] leading-[1.65] text-lumen [overflow-wrap:anywhere]">{preview.question}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <HashChip value={preview.documentSha256} label="Claim document sha256" />
          <HashChip value={`ipfs://${preview.cid}`} label="Claim document CID" />
          <HashChip value={doc.policy.sha256} label={`Policy ${doc.policy.id}@${doc.policy.version} sha256`} />
        </div>
      </div>

      <section aria-labelledby="pv-terms" className="glass cut-lg p-5">
        <h3 id="pv-terms" className="t-h4">
          What the document pins
        </h3>
        <dl className="mt-3 grid gap-x-6 gap-y-2.5 sm:grid-cols-[minmax(9rem,max-content)_1fr]">
          <Fact label="Repository">
            <span className="untrusted">
              {repo.ownerLogin}/{repo.name}
            </span>{' '}
            <span className="text-lumen-3">(GitHub id {repo.id})</span>
          </Fact>
          <Fact label="Commit">
            <code className="t-code text-[0.8125rem]">{doc.target.commit}</code>
          </Fact>
          <Fact label="Membership">
            {membershipText(doc.target.membership)}, verified by Pine {formatDate(doc.target.membership.verifiedAt, 'long')}
          </Fact>
          {doc.target.baseCommit && (
            <Fact label="Base commit">
              <code className="t-code text-[0.8125rem]">{doc.target.baseCommit}</code>
            </Fact>
          )}
          <Fact label="Creator">
            <code className="t-code text-[0.8125rem]">{doc.creator}</code>
          </Fact>
          <Fact label="Outcome tokens">
            <code className="t-code text-[0.8125rem]">{preview.tokenNames.join(', ')}</code>
          </Fact>
          <Fact label="Minimum bond">{UINT.test(doc.market.minBondWei) ? `${formatAmount(fromScaled(BigInt(doc.market.minBondWei), 18), { maxDecimals: 6 })} xDAI` : '—'}</Fact>
        </dl>
      </section>

      <section aria-labelledby="pv-timeline" className="glass cut-lg p-5">
        <h3 id="pv-timeline" className="t-h4">
          Timeline
        </h3>
        <dl className="mt-3 grid gap-x-6 gap-y-2.5 sm:grid-cols-[minmax(11rem,max-content)_1fr]">
          <Fact label="Evidence deadline">
            {formatDate(isoOf(t.evidenceDeadline), 'utc')}
            <span className="block text-[0.8125rem] text-lumen-3">Evidence is committed or published while the block time is before it.</span>
          </Fact>
          <Fact label="Reveal deadline">
            {formatDate(isoOf(t.revealDeadline), 'utc')}
            <span className="block text-[0.8125rem] text-lumen-3">Sealed evidence is revealed while the block time is before it.</span>
          </Fact>
          <Fact label="Answers open">
            {formatDate(isoOf(t.answersOpen), 'utc')}
            <span className="block text-[0.8125rem] text-lumen-3">Reality.eth accepts answers from the reveal deadline on.</span>
          </Fact>
          <Fact label="Earliest finalization">
            {formatDate(isoOf(t.earliestFinalization), 'utc')}
            <span className="block text-[0.8125rem] text-lumen-3">Opening time plus the 3.5-day answer timeout; every new answer restarts it.</span>
          </Fact>
          <Fact label="If escalated">
            Kleros arbitration on Ethereum adds about {arb.typicalRulingDays} days, plus about {arb.typicalAppealDays} per appeal; the fee (about {arb.feeEstimate}{' '}
            {arb.feeCurrency}) is paid there by whoever requests it.
          </Fact>
        </dl>
      </section>

      <section aria-labelledby="pv-costs" className="glass cut-lg p-5">
        <h3 id="pv-costs" className="t-h4">
          Cost to publish
        </h3>
        <div className="mt-3">
          <Costs costs={preview.costs} />
        </div>
      </section>
      <p className="text-[0.84375rem] text-lumen-2">
        Publish before <span className="tnum text-lumen">{formatDate(isoOf(preview.planExpiresAt), 'utc')}</span>; after that, request a new preview.
      </p>
    </div>
  )
}

export function ApiStageReview({ c, nav, acknowledged, setAcknowledged }: { c: ClaimComposer; nav: StepNav; acknowledged: boolean; setAcknowledged: (v: boolean) => void }) {
  const pub = useApiPublication()
  const id = useApiIdentity()
  const [attested, setAttested] = useState(false)
  if (!pub) return null
  const byStep = UI_STEPS.map((s) => ({ s, issues: issuesFor(c, s.id) })).filter((x) => x.issues.length > 0 && x.s.id !== 'publish')
  const ready = identityReady(id, 'preview')
  const started = PUBLISHING.has(pub.status)
  const blockedReason = !c.validation.ok
    ? 'Resolve the issues above first.'
    : !c.api?.policyPublishable
      ? 'Choose a policy this deployment accepts first.'
      : !ready
        ? 'Sign in, link GitHub and connect the wallet you signed in with first.'
        : !attested
          ? 'Confirm the attestation first.'
          : null
  const preview = pub.preview
  const reviewable = pub.status === 'reviewable'
  const working = pub.status === 'saving' || pub.status === 'previewing'
  const disclosures = preview?.disclosures ?? []

  const requestPreview = () => {
    if (!attested || blockedReason) return
    void pub.requestPreview({ liveSystemImpactNone: true })
  }

  return (
    <div>
      <StageHeader step="review">
        Read the claim the way an investigator will. Pine freezes the claim document when you request the preview; this browser checks it before anything can be
        published.
      </StageHeader>
      <div className="grid gap-6">
        {byStep.length > 0 ? (
          <Notice tone="caution" title="Facets still uncut" role="status">
            <ul className="mt-1 grid gap-2">
              {byStep.map(({ s, issues }) => (
                <li key={s.id}>
                  <button type="button" className="link font-semibold text-lumen" onClick={() => nav.go(s.id as UiStep)}>
                    {s.label}
                  </button>
                  <ul className="mt-0.5 grid gap-0.5">
                    {issues.map((i) => (
                      <li key={i.path + i.message} className="[overflow-wrap:anywhere]">
                        {i.message}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </Notice>
        ) : !started && !preview ? (
          <Notice tone="info" title="Every facet is cut">
            Request the preview: Pine checks the commit on GitHub and freezes the claim document.
          </Notice>
        ) : null}

        {!started && <ApiIdentityGate need="preview" reason="Pine previews claims for the wallet you sign in with, and checks the commit through your linked GitHub account." />}

        {!started && !preview && c.api?.questionSketch && (
          <div className="cut-xl well p-5 sm:p-6">
            <p className="text-[0.8125rem] text-lumen-3">The question so far (the preview fixes the claim document&apos;s CID and digest)</p>
            <p className="mt-2 text-[0.96875rem] leading-[1.6] text-lumen-2 [overflow-wrap:anywhere]">{c.api.questionSketch}</p>
          </div>
        )}

        {!started && (
          <section aria-labelledby="attest-title" className="glass cut-lg p-5">
            <h3 id="attest-title" className="t-h4 flex items-center gap-2">
              <ShieldCheck size={18} aria-hidden className="text-hb" /> No live-system impact
            </h3>
            <p className="mt-2 max-w-[64ch] text-[0.9rem] leading-[1.55] text-lumen-2">
              Pine only lists claims whose counterexamples cannot harm a deployed system holding other people&apos;s funds or data. {COPY.noAttackAuthorization}
            </p>
            <label className="mt-4 flex items-start gap-3 border-t border-edge pt-4">
              <input type="checkbox" className="facet-check" checked={attested} disabled={c.frozen} onChange={(e) => setAttested(e.target.checked)} />
              <span className="text-[0.9rem] text-lumen">{ATTESTATION_TEXT}</span>
            </label>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button onClick={requestPreview} loading={working} disabled={Boolean(blockedReason) || pub.busy || c.frozen} aria-describedby="preview-why">
                Preview the claim
              </Button>
              <p id="preview-why" className="text-[0.84375rem] text-lumen-2" role="status" aria-live="polite">
                {pub.status === 'saving'
                  ? 'Saving the draft to Pine.'
                  : pub.status === 'previewing'
                    ? 'Pine is checking the commit on GitHub and freezing the claim document.'
                    : (blockedReason ?? (preview ? 'Requesting again replaces this preview.' : ''))}
              </p>
            </div>
          </section>
        )}

        {pub.error && !started && <WriteErrorNotice error={pub.error} onRetry={requestPreview} onRepreview={requestPreview} />}

        {preview && (
          <section aria-labelledby="preview-title" className="grid gap-4">
            <h3 id="preview-title" className="t-h3">
              Pine&apos;s preview
            </h3>
            {pub.verifyIssues.length > 0 ? (
              <Notice tone="critical" role="alert" title="This preview cannot be published">
                <ul className="mt-1 grid gap-1">
                  {pub.verifyIssues.map((i) => (
                    <li key={`${i.code}|${i.field ?? ''}|${i.message}`} className="[overflow-wrap:anywhere]">
                      {i.message}
                    </li>
                  ))}
                </ul>
              </Notice>
            ) : (
              <Notice tone="info" title="Verified in this browser">
                The document hashes to the digest Pine stated, the question and token names follow from it, it names this deployment and your wallet, and it
                carries exactly the terms you composed.
              </Notice>
            )}
            <PreviewPanel preview={preview} chainId={c.fundingInput.chainId} />
          </section>
        )}

        {preview && (reviewable || started) && (
          <section aria-labelledby="risks-title" className="glass cut-lg p-5">
            <h3 id="risks-title" className="t-h4">
              Before you publish
            </h3>
            <ul className="mt-3 grid max-h-[22rem] gap-3 overflow-y-auto pr-2">
              {(disclosures.length > 0 ? disclosures.map((d) => ({ id: d.code, title: null, body: d.text })) : COPY.disclosures.map((d) => ({ id: d.id, title: d.title, body: d.body }))).map((d) => (
                <li key={d.id}>
                  {d.title && <p className="text-[0.9rem] font-semibold text-lumen">{d.title}</p>}
                  <p className="mt-0.5 text-[0.84375rem] leading-[1.55] text-lumen-2">{d.body}</p>
                </li>
              ))}
            </ul>
            <label className="mt-5 flex items-start gap-3 border-t border-edge pt-4">
              <input type="checkbox" className="facet-check" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
              <span className="text-[0.9rem] text-lumen">
                I have read these disclosures. I understand that No is not a correctness verdict, that Invalid is not a refund, and that any liquidity I add is
                capital at risk.
              </span>
            </label>
            <p className="mt-2 text-[0.78rem] text-lumen-3">
              <Link className="link" href="/risks">
                All risks and launch gates
              </Link>
            </p>
          </section>
        )}
      </div>
      <StageNav nav={nav} nextLabel="Continue to publish" nextDisabled={!(started || (reviewable && acknowledged))} />
    </div>
  )
}
