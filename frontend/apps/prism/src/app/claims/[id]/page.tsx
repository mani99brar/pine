import type { Metadata } from 'next'
import type { ClaimDetail } from '@pine/core'
import { formatPrice, OUTCOME_META } from '@pine/core'
import { buildClaimJsonLd, jsonLdString } from '@pine/core/agent'
import { readPineEnv } from '@pine/data'
import { ClaimView } from '@/components/claim/ClaimView'
import { claimLabel, repoLabel } from '@/lib/claims'
import { getClaimServer } from '@/lib/server/data'
import { siteUrl } from '@/lib/site'

type Params = { params: Promise<{ id: string }> }

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const POLICY_ID = /^[A-Z]{2,8}-\d{3}$/
const VERSION = /^\d+\.\d+\.\d+$/

/** `api` mode: claims are Seer markets and their machine-readable view is the backend's agent route. */
function backendAgentLinks(): boolean {
  return readPineEnv().dataSource === 'api'
}

/** The claim's JSON alternate: the backend agent view in `api` mode (a market address is required), else the app's. */
function agentJsonPath(id: string, market?: string): string | null {
  if (!backendAgentLinks()) return `/api/agent/v1/claims/${encodeURIComponent(id)}`
  const m = market ?? id
  return ADDRESS.test(m) ? `/api/v1/agents/claims/${m.toLowerCase()}` : null
}

/**
 * `api` mode JSON-LD: backend claims are named by their market (they have no PINE number), their terms are the claim
 * document identified by its sha256, and the data downloads and the policy link point at the backend's public routes.
 */
function backendJsonLd(ld: Record<string, unknown>, claim: ClaimDetail, site: string): Record<string, unknown> {
  const agentJson = agentJsonPath(claim.id, claim.marketAddress)
  const market = claim.marketAddress ?? claim.id
  const { id, version } = claim.policy
  const policyUrl =
    POLICY_ID.test(id) && VERSION.test(version) ? `${site}/api/v1/policies/${id}/${version}` : `${site}/policies/${encodeURIComponent(id)}`
  const out: Record<string, unknown> = { ...ld }
  if (ADDRESS.test(market)) out.identifier = market.toLowerCase()
  const basedOn = ld.isBasedOn
  if (basedOn && typeof basedOn === 'object') out.isBasedOn = { ...basedOn, url: policyUrl }
  const subject = ld.subjectOf
  if (subject && typeof subject === 'object') {
    out.subjectOf = {
      ...subject,
      name: ADDRESS.test(market) ? `Claim document of ${market.toLowerCase()}` : 'Claim document',
      description: 'Immutable claim document (canonical JSON); identifier is its sha256 digest.',
      distribution: agentJson
        ? [{ '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: `${site}${agentJson}`, name: 'Agent view of the claim' }]
        : [],
    }
  }
  return out
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params
  const claim = await getClaimServer(id)
  if (!claim) {
    const json = agentJsonPath(id)
    return { title: 'Claim not found', alternates: json ? { types: { 'application/json': json } } : undefined, robots: { index: false } }
  }
  const json = agentJsonPath(id, claim.marketAddress)
  const title = `${claimLabel(claim)}: ${claim.title}`
  const state =
    (claim.status === 'resolved' || claim.status === 'settled') && claim.outcome
      ? ` Resolved: ${OUTCOME_META[claim.outcome].label}.`
      : claim.yesPrice !== undefined
        ? ` Market-implied chance a qualifying counterexample is accepted: ${formatPrice(claim.yesPrice)}.`
        : ''
  const description = `${claim.policy.id} claim on ${repoLabel(claim)} at commit ${claim.source.commitSha.slice(0, 7)}.${state}`
  return {
    title,
    description,
    alternates: { canonical: `/claims/${claim.id}`, ...(json ? { types: { 'application/json': json } } : {}) },
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
      const site = siteUrl()
      const built = buildClaimJsonLd(claim, { siteUrl: site })
      ld = jsonLdString(backendAgentLinks() ? backendJsonLd(built, claim, site) : built)
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
