import type { Metadata } from 'next'
import { formatClaimNumber, formatPrice, OUTCOME_META } from '@pine/core'
import { buildClaimJsonLd, jsonLdString } from '@pine/core/agent'
import { ClaimView } from '@/components/claim/ClaimView'
import { getClaimServer } from '@/lib/server/data'
import { siteUrl } from '@/lib/site'

type Params = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params
  const claim = await getClaimServer(id)
  const json = `/api/agent/v1/claims/${encodeURIComponent(id)}`
  if (!claim) return { title: 'Claim not found', alternates: { types: { 'application/json': json } }, robots: { index: false } }
  const title = `${formatClaimNumber(claim.number)}: ${claim.title}`
  const state =
    (claim.status === 'resolved' || claim.status === 'settled') && claim.outcome
      ? ` Resolved: ${OUTCOME_META[claim.outcome].label}.`
      : claim.yesPrice !== undefined
        ? ` Market-implied chance a qualifying counterexample is accepted: ${formatPrice(claim.yesPrice)}.`
        : ''
  const description = `${claim.policy.id} claim on ${claim.source.owner}/${claim.source.repo} at commit ${claim.source.commitSha.slice(0, 7)}.${state}`
  return {
    title,
    description,
    alternates: { canonical: `/claims/${claim.id}`, types: { 'application/json': json } },
    openGraph: { title, description, type: 'article', url: `/claims/${claim.id}` },
    twitter: { card: 'summary_large_image', title, description },
  }
}

export default async function ClaimPage({ params }: Params) {
  const { id } = await params
  const claim = await getClaimServer(id)
  let ld: string | null = null
  if (claim) {
    try {
      // Built from our own data and serialized with "<" and line separators escaped.
      ld = jsonLdString(buildClaimJsonLd(claim, { siteUrl: siteUrl() }))
    } catch {
      ld = null
    }
  }
  return (
    <>
      {ld && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ld }} />}
      <ClaimView id={id} />
    </>
  )
}
