/** Atom 1.0 feed of claims (newest first). All text is XML-escaped; invalid XML characters are stripped. */
import { formatClaimNumber, formatPrice, formatUtcMinute } from '../format'
import { OUTCOME_META, STATUS_META } from '../lifecycle'
import { POLICY_PUBLISHED_AT } from '../policies'
import type { ClaimSummary } from '../types'
import { agentUrls } from './urls'

// XML 1.0 forbids most C0 controls and lone surrogates.
const NONCHARS = String.fromCharCode(0xfffe) + String.fromCharCode(0xffff)
const INVALID_XML = new RegExp(
  `[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F${NONCHARS}]|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]`,
  'g',
)

/** Escape text for XML content and attribute values. */
export function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function rfc3339(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? POLICY_PUBLISHED_AT : d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function buildAtomFeed(ctx: { siteUrl: string; appName: string; claims: ClaimSummary[] }): string {
  const urls = agentUrls(ctx.siteUrl)
  const claims = [...(ctx.claims ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  const updated = claims.length ? rfc3339(claims[0]?.createdAt ?? POLICY_PUBLISHED_AT) : POLICY_PUBLISHED_AT

  const entries = claims.map((c) => {
    const status = STATUS_META[c.status]?.label ?? c.status
    const outcome = c.outcome ? ` (${OUTCOME_META[c.outcome].label})` : ''
    const repo = `${c.source.owner}/${c.source.repo}`
    const price = typeof c.yesPrice === 'number' ? ` Market-implied chance a qualifying counterexample is accepted: ${formatPrice(c.yesPrice)}.` : ''
    const summary =
      `Counterexample sought: ${c.violation}. Target ${repo} at ${c.source.commitSha}` +
      `${c.source.prNumber ? ` (PR #${c.source.prNumber})` : ''}. Policy ${c.policy.id}@${c.policy.version}. ` +
      `Status: ${status}${outcome}. Evidence deadline ${formatUtcMinute(c.evidenceDeadline)}.${price}`
    const author = c.creatorGithub ?? c.creator
    return [
      '  <entry>',
      `    <id>${escapeXml(urls.claimPage(c.id))}</id>`,
      `    <title>${escapeXml(`${formatClaimNumber(c.number)}: ${c.title}`)}</title>`,
      `    <link rel="alternate" type="text/html" href="${escapeXml(urls.claimPage(c.id))}"/>`,
      `    <link rel="alternate" type="application/json" href="${escapeXml(urls.claim(c.id))}"/>`,
      `    <link rel="related" type="text/markdown" href="${escapeXml(urls.claimMarkdown(c.id))}"/>`,
      `    <published>${rfc3339(c.createdAt)}</published>`,
      `    <updated>${rfc3339(c.createdAt)}</updated>`,
      `    <author><name>${escapeXml(author)}</name></author>`,
      `    <category term="${escapeXml(c.policy.id)}" label="${escapeXml(c.policy.title)}"/>`,
      `    <category term="status:${escapeXml(c.status)}" label="${escapeXml(status)}"/>`,
      ...(c.tags ?? []).map((t) => `    <category term="${escapeXml(t)}"/>`),
      `    <summary type="text">${escapeXml(summary)}</summary>`,
      '  </entry>',
    ].join('\n')
  })

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${escapeXml(urls.feed)}</id>`,
    `  <title>${escapeXml(`${ctx.appName} — verification claims`)}</title>`,
    `  <subtitle>${escapeXml('Bounded, policy-versioned claims about exact GitHub commits, open for reproducible counterexamples.')}</subtitle>`,
    `  <updated>${updated}</updated>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(urls.feed)}"/>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(urls.site || '/')}"/>`,
    `  <generator>${escapeXml(ctx.appName)}</generator>`,
    ...entries,
    '</feed>',
    '',
  ].join('\n')
}
