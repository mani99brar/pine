import type { Metadata } from 'next'
import { formatClaimNumber } from '@pine/core'
import { buildClaimJsonLd } from '@pine/core/agent'
import { ClaimView } from '@/components/claim/claim-view'
import { serverData, safely } from '@/lib/server-data'
import { JsonLd } from '@/lib/jsonld'
import { SITE_URL } from '@/lib/site'
import { stageView } from '@/lib/stage'

type Params = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params
  const claim = await safely(() => serverData().getClaim(id), null)
  if (!claim) {
    return { title: 'Claim', alternates: { types: { 'application/json': `/api/agent/v1/claims/${encodeURIComponent(id)}` } } }
  }
  const number = formatClaimNumber(claim.number)
  const stage = stageView(claim.status, claim.outcome).label
  const description = `${stage}. ${claim.source.owner}/${claim.source.repo} at ${claim.source.commitSha.slice(0, 7)}, policy ${claim.policy.id}@${claim.policy.version}. Claim: ${claim.violation}`
  return {
    title: `${number}: ${claim.title}`,
    description: description.slice(0, 300),
    alternates: {
      canonical: `/claims/${claim.id}`,
      types: { 'application/json': `/api/agent/v1/claims/${claim.id}` },
    },
    openGraph: {
      type: 'article',
      title: `${number}: ${claim.title}`,
      description: description.slice(0, 300),
      url: `/claims/${claim.id}`,
      publishedTime: claim.createdAt,
    },
    twitter: { card: 'summary', title: `${number}: ${claim.title}`, description: description.slice(0, 200) },
  }
}

export default async function ClaimPage({ params }: Params) {
  const { id } = await params
  const claim = await safely(() => serverData().getClaim(id), null)
  const jsonLd = claim ? safeJsonLd(() => buildClaimJsonLd(claim, { siteUrl: SITE_URL })) : null
  return (
    <>
      {jsonLd ? <JsonLd data={jsonLd} /> : null}
      <ClaimView id={id} initial={claim} />
    </>
  )
}

function safeJsonLd(fn: () => Record<string, unknown>) {
  try {
    return fn()
  } catch {
    return null
  }
}
