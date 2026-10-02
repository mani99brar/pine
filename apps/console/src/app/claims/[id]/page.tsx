import type { Metadata } from 'next'
import { formatClaimNumber } from '@pine/core'
import { buildClaimJsonLd } from '@pine/core/agent'
import { getServerClaim, jsonLdString, siteUrl } from '@/lib/server/data'
import { CLAIM_TABS, type ClaimTab } from '@/lib/claim-tabs'
import { ClaimWorkspace } from '@/components/claim/workspace'

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  const claim = await getServerClaim(id)
  const json = `/api/agent/v1/claims/${encodeURIComponent(id)}`
  if (!claim) {
    return { title: id.toUpperCase(), alternates: { types: { 'application/json': json } } }
  }
  const title = `${formatClaimNumber(claim.number)} ${claim.title}`
  return {
    title,
    description: claim.manifest.question.text,
    alternates: { canonical: `/claims/${claim.id}`, types: { 'application/json': json } },
    openGraph: { title: `${title} | Pine Console`, description: claim.manifest.question.text, type: 'article' },
    twitter: { card: 'summary', title, description: claim.manifest.question.text },
  }
}

export default async function ClaimPage({ params, searchParams }: Props) {
  const { id } = await params
  const sp = await searchParams
  const tabParam = typeof sp.tab === 'string' ? sp.tab : ''
  const tab: ClaimTab = (CLAIM_TABS as readonly string[]).includes(tabParam) ? (tabParam as ClaimTab) : 'overview'
  const claim = await getServerClaim(id)
  return (
    <>
      {claim ? (
        <script
          type="application/ld+json"
          // JSON-LD built from our own indexed data; "<" is escaped so it cannot break out of the tag.
          dangerouslySetInnerHTML={{ __html: jsonLdString(buildClaimJsonLd(claim, { siteUrl })) }}
        />
      ) : null}
      <ClaimWorkspace id={id} initialTab={tab} />
    </>
  )
}
