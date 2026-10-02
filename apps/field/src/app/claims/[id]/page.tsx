import type { Metadata } from 'next'
import { formatClaimNumber, formatPrice } from '@pine/core'
import { buildClaimJsonLd } from '@pine/core/agent'
import { ClaimView } from '@/components/claim/ClaimView'
import { getClaimServer } from '@/lib/server/data'
import { siteUrl } from '@/lib/site'

type Params = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params
  const claim = await getClaimServer(id)
  const alternate = { types: { 'application/json': `/api/agent/v1/claims/${encodeURIComponent(id)}` } }
  if (!claim) return { title: 'Claim not found', alternates: alternate, robots: { index: false } }
  const title = `${formatClaimNumber(claim.number)}: ${claim.title}`
  const price = claim.yesPrice !== undefined ? ` Market-implied chance a qualifying counterexample is accepted: ${formatPrice(claim.yesPrice)}.` : ''
  const description = `${claim.policy.id} claim on ${claim.source.owner}/${claim.source.repo}@${claim.source.commitSha.slice(0, 7)}.${price}`
  return {
    title,
    description,
    alternates: { canonical: `/claims/${claim.id}`, ...alternate },
    openGraph: { title, description, type: 'article', url: `/claims/${claim.id}` },
    twitter: { card: 'summary_large_image', title, description },
  }
}

export default async function ClaimPage({ params }: Params) {
  const { id } = await params
  const claim = await getClaimServer(id)
  let jsonLd: string | null = null
  if (claim) {
    try {
      // Our own data, serialized with "<" escaped so it can never close the script element.
      jsonLd = JSON.stringify(buildClaimJsonLd(claim, { siteUrl: siteUrl() })).replace(/</g, '\\u003c')
    } catch {
      jsonLd = null
    }
  }
  return (
    <>
      {jsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />}
      <ClaimView id={id} />
    </>
  )
}
