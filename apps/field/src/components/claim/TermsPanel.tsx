'use client'

import Link from 'next/link'
import type { ClaimDetail } from '@pine/core'
import { formatDate, formatDuration, getEvidenceMechanism } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { Lock } from 'lucide-react'
import { ExternalLink, HashChip } from '@/components/ui/interactive'
import { KV, Note } from '@/components/ui/primitives'

/** Immutable references: everything frozen when the market was created. */
export function TermsPanel({ claim }: { claim: ClaimDetail }) {
  const m = claim.manifest
  const spec = m.claim
  const chain = getChainOrDefault(claim.chainId)
  const mech = getEvidenceMechanism(spec.evidence.mechanism)
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <KV
          rows={[
            { k: 'Manifest', v: <span className="flex flex-wrap items-center gap-2"><HashChip value={claim.manifestHash} label="keccak256" /><code className="t-code break-all text-[0.78rem] text-ink-2">{claim.manifestUri}</code></span> },
            { k: 'Question hash', v: <HashChip value={m.question.hash} label="hash" /> },
            { k: 'Outcomes', v: `${m.question.outcomes.join(', ')}, plus Seer's native "Invalid result"` },
            {
              k: 'Policy',
              v: (
                <span className="flex flex-wrap items-center gap-2">
                  <Link href={`/policies/${m.policy.id}?v=${m.policy.version}`} className="font-[600] underline underline-offset-2">
                    {m.policy.id}@{m.policy.version}
                  </Link>
                  <HashChip value={m.policy.hash} label="text hash" />
                </span>
              ),
            },
            { k: 'Repository', v: <ExternalLink href={`https://github.com/${m.source.owner}/${m.source.repo}`}>{`${m.source.owner}/${m.source.repo}`}</ExternalLink> },
            { k: 'Commit', v: <HashChip value={m.source.commit.sha} label="sha" href={m.source.commit.htmlUrl} /> },
            ...(m.source.baseCommit ? [{ k: 'Base commit', v: <HashChip value={m.source.baseCommit.sha} label="sha" href={m.source.baseCommit.htmlUrl} /> }] : []),
            { k: 'Only regressions qualify', v: spec.regressionOnly ? 'Yes, relative to the base commit' : 'No, any qualifying violation in the commit' },
            { k: 'Environment hash', v: <HashChip value={spec.environment.envHash} label="env" /> },
            { k: 'Evidence channel', v: mech?.label ?? spec.evidence.mechanism },
            { k: 'Evidence deadline', v: `${formatDate(spec.evidence.deadline, 'long')} (absolute, UTC)` },
            { k: 'Oracle opens', v: formatDate(spec.oracle.openingTime, 'long') },
            { k: 'Answer timeout', v: `${formatDuration(spec.oracle.timeoutSeconds * 1000)} per answer` },
            { k: 'Minimum bond', v: `${spec.oracle.minBond} ${spec.oracle.bondToken}` },
            { k: 'Arbitrator', v: spec.oracle.arbitratorName },
            ...(claim.market
              ? [
                  { k: 'Market', v: <span className="flex flex-wrap items-center gap-2"><HashChip value={claim.market.address} label="address" /><ExternalLink href={claim.market.seerUrl}>Seer</ExternalLink></span> },
                  { k: 'Condition id', v: <HashChip value={claim.market.conditionId} label="id" /> },
                  { k: 'Collateral', v: `${claim.market.collateral.symbol} on ${chain.name}` },
                ]
              : []),
            ...(claim.oracle ? [{ k: 'Reality.eth question', v: <span className="flex flex-wrap items-center gap-2"><HashChip value={claim.oracle.realityQuestionId} label="id" /><ExternalLink href={claim.oracle.realityUrl}>Reality.eth</ExternalLink></span> }] : []),
            { k: 'Created', v: formatDate(m.createdAt, 'long') },
            { k: 'Creator', v: <span className="flex flex-wrap items-center gap-2"><HashChip value={m.creator} label="address" />{claim.creatorGithub && <span className="text-ink-2">@{claim.creatorGithub}</span>}</span> },
          ]}
        />
      </div>
      <aside className="grid content-start gap-4">
        <Note tone="boundary" icon={<Lock size={15} aria-hidden />} title="Frozen terms">
          {COPY.frozenTerms}
        </Note>
        {claim.funding && (
          <div className="rounded-[var(--radius-tile)] border border-line bg-sheet p-4 text-[0.88rem]">
            <p className="font-[650]">Creator funding</p>
            <p className="mt-1 text-ink-2">
              {claim.funding.liquidity} {claim.collateralSymbol} liquidity under a {claim.funding.spendingLimit} {claim.collateralSymbol} spending limit.{' '}
              {claim.funding.withdrawable ? 'The liquidity stays withdrawable.' : 'The liquidity is committed.'}
            </p>
            <p className="mt-2 text-[0.8rem] text-ink-3">{COPY.liquidityIsNotBounty}</p>
          </div>
        )}
        <details className="rounded-[var(--radius-tile)] border border-line bg-sheet p-4">
          <summary className="font-[650]">Full manifest JSON</summary>
          <pre className="t-code mt-3 max-h-[28rem] overflow-auto whitespace-pre-wrap text-[0.75rem] [overflow-wrap:anywhere]">{JSON.stringify(m, null, 2)}</pre>
        </details>
        {m.disclaimers.length > 0 && (
          <div className="text-[0.8rem] text-ink-3">
            <p className="font-[650] text-ink-2">Disclaimers in the manifest</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {m.disclaimers.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  )
}
