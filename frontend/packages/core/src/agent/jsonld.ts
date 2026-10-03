/** schema.org JSON-LD for claim pages: Question about SoftwareSourceCode, with the manifest as a Dataset. */
import { COPY } from '../copy'
import { formatClaimNumber } from '../format'
import { OUTCOME_META } from '../lifecycle'
import type { ClaimDetail } from '../types'
import { agentUrls } from './urls'

export function buildClaimJsonLd(claim: ClaimDetail, ctx: { siteUrl: string }): Record<string, unknown> {
  const urls = agentUrls(ctx.siteUrl)
  const url = urls.claimPage(claim.id)
  const owner = claim.manifest?.source?.owner ?? claim.source.owner
  const repo = claim.manifest?.source?.repo ?? claim.source.repo
  const sha = claim.manifest?.source?.commit?.sha ?? claim.source.commitSha
  const repoUrl = `https://github.com/${owner}/${repo}`
  const policy = claim.manifest?.policy

  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Question',
    '@id': url,
    url,
    identifier: formatClaimNumber(claim.number),
    name: claim.title,
    text: claim.manifest?.question?.text ?? claim.violation,
    dateCreated: claim.createdAt,
    expires: claim.evidenceDeadline,
    inLanguage: 'en',
    answerCount: claim.evidence?.length ?? claim.evidenceCount ?? 0,
    about: {
      '@type': 'SoftwareSourceCode',
      name: `${owner}/${repo}`,
      codeRepository: repoUrl,
      version: sha,
      url: `${repoUrl}/commit/${sha}`,
      ...(claim.manifest?.source?.license ? { license: claim.manifest.source.license } : {}),
    },
    isBasedOn: {
      '@type': 'CreativeWork',
      name: `${claim.policy.id}@${claim.policy.version} ${claim.policy.title}`,
      identifier: policy?.hash,
      url: urls.policy(claim.policy.id, claim.policy.version),
      ...(policy?.uri ? { sameAs: policy.uri } : {}),
    },
    subjectOf: {
      '@type': 'Dataset',
      name: `${formatClaimNumber(claim.number)} claim manifest`,
      description: 'Immutable claim manifest (canonical JSON); identifier is its keccak256 hash.',
      identifier: claim.manifestHash,
      ...(claim.manifestUri ? { sameAs: claim.manifestUri } : {}),
      encodingFormat: 'application/json',
      distribution: [
        { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: urls.manifest(claim.id) },
        { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: urls.claim(claim.id), name: 'Agent brief' },
        { '@type': 'DataDownload', encodingFormat: 'text/markdown', contentUrl: urls.claimMarkdown(claim.id), name: 'Agent brief (Markdown)' },
      ],
    },
    disambiguatingDescription: COPY.notAReview,
  }
  if (claim.marketAddress || claim.market?.address) {
    ld.mainEntityOfPage = { '@type': 'WebPage', '@id': url }
    ld.sameAs = claim.market?.seerUrl
  }
  if ((claim.status === 'resolved' || claim.status === 'settled') && claim.outcome) {
    ld.acceptedAnswer = { '@type': 'Answer', text: OUTCOME_META[claim.outcome].label, description: OUTCOME_META[claim.outcome].long }
  }
  return ld
}

/** Serialize JSON-LD for a <script type="application/ld+json"> tag, escaping "<" so content cannot close the tag. */
export function jsonLdString(ld: Record<string, unknown>): string {
  const ls = new RegExp(String.fromCharCode(0x2028), 'g')
  const ps = new RegExp(String.fromCharCode(0x2029), 'g')
  return JSON.stringify(ld).replace(/</g, '\\u003c').replace(ls, '\\u2028').replace(ps, '\\u2029')
}
