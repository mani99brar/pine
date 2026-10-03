'use client'

import type { ClaimSummary } from '@pine/core'
import { formatDuration } from '@pine/core'
import type { ApiClaimFacts } from '@pine/data'
import { Notice } from '@/components/ui/primitives'
import { apiFactsOf } from '@/lib/claims'
import { cn } from '@/lib/cn'

/** Why the claim document's terms are not shown, or null when they are. */
export function documentWithheldReason(api: ApiClaimFacts): string | null {
  if (api.documentVerified) return null
  if (api.hidden) return 'Pine withholds this claim’s text after a moderation decision.'
  switch (api.integrity.status) {
    case 'pending':
      return 'Pine has not verified the claim document against the market yet.'
    case 'mismatch':
      return 'The claim document does not match the market, so its terms are not shown.'
    case 'document_unavailable':
      return 'Pine could not retrieve the claim document recorded on chain.'
    default:
      return 'The claim document could not be read right now, or it did not match the digest recorded on chain.'
  }
}

/**
 * Backend claims: moderation, integrity and indexer freshness, before anything else on the page. A mismatch is loud:
 * the market's on-chain terms and its claim document disagree.
 */
export function ApiClaimNotices({ claim, className }: { claim: ClaimSummary; className?: string }) {
  const api = apiFactsOf(claim)
  if (!api) return null
  const { integrity, indexer } = api
  const notices: React.ReactNode[] = []
  if (api.hidden) {
    notices.push(
      <Notice key="hidden" tone="boundary" title="Hidden by moderation">
        Pine withholds this claim’s title, question and document after a moderation decision. Its on-chain facts stay visible, and the market itself is not changed by Pine.
      </Notice>,
    )
  }
  if (integrity.status === 'mismatch') {
    notices.push(
      <Notice key="mismatch" tone="critical" role="alert" title="This market does not match its claim document">
        Pine compared the market on chain with the claim document it records and found differences
        {integrity.mismatchFields.length > 0 ? (
          <>
            {' '}
            in <span className="font-semibold text-lumen">{integrity.mismatchFields.join(', ')}</span>
          </>
        ) : null}
        . Do not rely on these terms: trade, answer or file evidence only if you have checked the market yourself.
      </Notice>,
    )
  } else if (integrity.status === 'pending') {
    notices.push(
      <Notice key="pending" tone="info" role="status" title="Being verified by the indexer">
        Pine has not yet checked this market against its claim document; it does so about once a minute after a claim is published. Until then the terms are unverified.
      </Notice>,
    )
  } else if (integrity.status === 'document_unavailable') {
    notices.push(
      <Notice key="unavailable" tone="caution" title="Claim document unavailable">
        Pine could not retrieve the claim document whose digest the market records, so the terms cannot be shown or checked. The question below is the market’s own on-chain text.
      </Notice>,
    )
  } else if (!api.hidden && !api.documentVerified) {
    notices.push(
      <Notice key="unread" tone="caution" title="Claim document not shown">
        The document could not be read right now, or it did not match the digest recorded on chain, so its terms are not shown.
      </Notice>,
    )
  }
  if (indexer.halted) {
    notices.push(
      <Notice key="halted" tone="critical" role="alert" title="Pine’s indexer has stopped">
        It stopped at block {indexer.indexedBlock}. Claim, evidence and oracle states shown here may be out of date: check the chain before you act.
      </Notice>,
    )
  } else if (indexer.stale) {
    notices.push(
      <Notice key="stale" tone="caution" role="status" title="Pine’s indexer is behind the chain">
        Last indexed block {indexer.indexedBlock}, about {formatDuration(indexer.lagSeconds * 1000)} behind. States and prices may be out of date.
      </Notice>,
    )
  }
  if (notices.length === 0) return null
  return <div className={cn('grid gap-3', className)}>{notices}</div>
}
