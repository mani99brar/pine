/**
 * llms.txt / llms-full.txt (llmstxt.org format: H1, blockquote summary, free-form notes, H2 sections of links)
 * and the /.well-known/pine.json discovery descriptor.
 */
import { CHAINS, SUPPORTED_CHAIN_IDS } from '../chains'
import { COPY } from '../copy'
import { EVIDENCE_MECHANISMS, isEvidenceMechanismEnabled } from '../evidence'
import { formatAmount, formatClaimNumber, formatPrice, formatUtcMinute } from '../format'
import { OUTCOME_META, STATUS_META } from '../lifecycle'
import { AGENT_BRIEF_SCHEMA_URL, CLAIM_MANIFEST_SCHEMA_URL } from '../manifest'
import { POLICIES, policyPath } from '../policies'
import type { ClaimSummary, PlatformStats, PolicyVersion } from '../types'
import { agentUrls } from './urls'

function oneLine(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

function summaryLine(appName: string): string {
  return `${appName} publishes bounded, policy-versioned claims about exact GitHub commits and funds Seer prediction markets on whether a reproducible counterexample is submitted before an absolute UTC deadline. Reality.eth answers each market; Kleros arbitrates disputes.`
}

function claimLink(siteUrl: string, c: ClaimSummary): string {
  const urls = agentUrls(siteUrl)
  const price = typeof c.yesPrice === 'number' ? `, implied chance of accepted counterexample ${formatPrice(c.yesPrice)}` : ''
  return `- [${formatClaimNumber(c.number)}: ${oneLine(c.title)}](${urls.claimMarkdown(c.id)}): ${c.policy.id}@${c.policy.version} on ${c.source.owner}/${c.source.repo}@${c.source.commitSha.slice(0, 12)}; evidence deadline ${formatUtcMinute(c.evidenceDeadline)}${price}; ${STATUS_META[c.status]?.label ?? c.status}`
}

const HOW_TO_SUBMIT = (siteUrl: string): string[] => {
  const urls = agentUrls(siteUrl)
  return [
    `1. Fetch open claims: GET ${urls.openClaims} (filters: status, policy, repo, limit, cursor).`,
    `2. Read one claim's brief: GET ${urls.claim('{id}')} or as a Markdown prompt with ?format=md. Verify the manifest: GET ${urls.manifest('{id}')} and check keccak256(canonical JSON) against the x-pine-manifest-hash header and the market name.`,
    '3. Reproduce only against the pinned commit, environment (envHash) and configuration, inside an isolated sandbox without secrets or production keys.',
    '4. Package the evidence: reproduction command, setup, expected vs actual behavior, explanation tied to the exact requirement; pin it to IPFS (or another durable, content-addressed location).',
    `5. Submit before the deadline through the claim's evidence mechanism. Default: ERC-1497 submitEvidence(uint256(realityQuestionId), evidenceURI) on the Kleros arbitration contract on Ethereum (chain 1). The submission block timestamp is the timeliness proof. Or use the claim page: ${urls.evidencePage('{id}')}.`,
  ]
}

const RULES: string[] = [
  'One claim = one bounded violation of one pinned commit, environment and policy version. Only a timely, admissible demonstration of that violation counts.',
  `Yes = "${OUTCOME_META.yes.label}"; No = "${OUTCOME_META.no.label}". ${COPY.noIsNotSafety}`,
  COPY.invalidIsNotRefund,
  COPY.deadlineIsNotTradingCutoff,
  COPY.lateEvidence,
  `${COPY.priceLabel}: ${COPY.priceCaveat}`,
  COPY.volumeCaveat,
  COPY.liquidityIsNotBounty,
  COPY.evidenceIsNotPayment,
  COPY.oracleActors,
  COPY.noAttackAuthorization,
  COPY.untrustedContent,
  COPY.noMergeAuthority,
]

export function buildLlmsTxt(ctx: { siteUrl: string; appName: string; stats?: PlatformStats; claims?: ClaimSummary[] }): string {
  const urls = agentUrls(ctx.siteUrl)
  const lines: string[] = [`# ${ctx.appName}`, '', `> ${summaryLine(ctx.appName)}`, '']
  lines.push(
    'Each claim pins a repository commit, environment hash and policy version and asks one question: "Was a reproducible counterexample demonstrating [violation] against commit [sha] … submitted through [mechanism] before [UTC deadline]?" Investigators, including AI agents, can find counterexamples and submit evidence permissionlessly.',
    '',
  )
  if (ctx.stats) {
    const s = ctx.stats
    lines.push(
      `Current: ${s.openClaims} open claims, ${s.resolvedClaims} resolved (${s.counterexamplesAccepted} with a counterexample demonstrated), ${s.evidenceSubmissions} evidence submissions, ${formatAmount(s.totalLiquidity, { compact: true })} ${s.collateralSymbol} liquidity. ${COPY.volumeCaveat}`,
      '',
    )
  }
  lines.push(
    '## Agent API',
    '',
    `- [Open claims](${urls.openClaims}): JSON list of agent briefs for claims whose evidence window is open`,
    `- [Claim brief](${urls.claim('{id}')}): one claim's investigation brief; add ?format=md for a Markdown prompt`,
    `- [Claim manifest](${urls.manifest('{id}')}): the immutable manifest, canonical JSON, hash in x-pine-manifest-hash`,
    `- [Discovery descriptor](${urls.wellKnown}): API base, schemas, chains, contracts and policy catalog`,
    `- [Claim manifest JSON Schema](${urls.schema}): draft 2020-12 schema (${CLAIM_MANIFEST_SCHEMA_URL})`,
    `- [OpenAPI](${urls.openapi}): OpenAPI 3.1 description of the agent API`,
    `- [Atom feed](${urls.feed}): newly published claims`,
    '',
    '## Policies',
    '',
    ...POLICIES.map(
      (p) =>
        `- [${policyPath(p)} ${p.title}](${urls.policy(p.id, p.version)}): ${oneLine(p.summary)}${p.status === 'gated' ? ` Gated: ${COPY.scGate.split('.')[0]}.` : ''}`,
    ),
    '',
    '## How to submit evidence',
    '',
    ...HOW_TO_SUBMIT(ctx.siteUrl),
    '',
    '## Rules',
    '',
    ...RULES.map((r) => `- ${r}`),
    '',
  )
  const open = (ctx.claims ?? []).filter((c) => c.status === 'open').slice(0, 25)
  if (open.length) {
    lines.push('## Open claims', '', ...open.map((c) => claimLink(ctx.siteUrl, c)), '')
  }
  lines.push(
    '## Optional',
    '',
    `- [Full context](${urls.llmsFull}): policy texts, every listed claim and all risk disclosures in one file`,
    `- [Risks and launch gates](${urls.risksPage}): unresolved launch decisions`,
    '',
  )
  return lines.join('\n')
}

export function buildLlmsFullTxt(ctx: { siteUrl: string; appName: string; policies: PolicyVersion[]; claims: ClaimSummary[] }): string {
  const urls = agentUrls(ctx.siteUrl)
  const lines: string[] = [`# ${ctx.appName} (full context)`, '', `> ${summaryLine(ctx.appName)}`, '']
  lines.push(
    `Machine endpoints: ${urls.openClaims} · ${urls.wellKnown} · ${urls.schema} · ${urls.openapi} · ${urls.feed}`,
    '',
    '## How to submit evidence',
    '',
    ...HOW_TO_SUBMIT(ctx.siteUrl),
    '',
    '## Rules',
    '',
    ...RULES.map((r) => `- ${r}`),
    '',
    '## Evidence mechanisms',
    '',
    ...Object.values(EVIDENCE_MECHANISMS).map(
      (m) =>
        `- ${m.label} (${m.id}${isEvidenceMechanismEnabled(m.id) ? '' : ', not enabled'}): ${m.description}${m.contract ? ` Contract ${m.contract} on chain ${m.chainId}.` : ''}${m.launchGate ? ` Caveat: ${m.launchGate}` : ''}`,
    ),
    '',
    '## Chains',
    '',
    ...SUPPORTED_CHAIN_IDS.map((id) => {
      const c = CHAINS[id]
      if (!c) return `- chain ${id}`
      return `- ${c.name} (${c.id}): collateral ${c.collateral.symbol} ${c.collateral.address}; Seer MarketFactory ${c.seer.marketFactory}; Router ${c.seer.router}; Reality.eth ${c.reality}; arbitrator ${c.arbitrator}; arbitration and evidence on chain ${c.arbitration.chainId} at ${c.arbitration.requestContract}; answer timeout ${c.seerQuestionTimeoutSeconds}s${c.testnet ? '; testnet' : ''}.`
    }),
    '',
    '## Claims',
    '',
  )
  if (ctx.claims.length === 0) lines.push('_No claims listed._', '')
  for (const c of ctx.claims) {
    lines.push(
      `### ${formatClaimNumber(c.number)}: ${oneLine(c.title)}`,
      '',
      `- Status: ${STATUS_META[c.status]?.label ?? c.status}${c.outcome ? ` (${OUTCOME_META[c.outcome].label})` : ''}`,
      `- Violation sought: ${oneLine(c.violation)}`,
      `- Target: https://github.com/${c.source.owner}/${c.source.repo}/commit/${c.source.commitSha}${c.source.prNumber ? ` (PR #${c.source.prNumber})` : ''}`,
      `- Policy: ${c.policy.id}@${c.policy.version} ${c.policy.title}`,
      `- Evidence deadline: ${formatUtcMinute(c.evidenceDeadline)}`,
      `- Chain: ${c.chainId}${c.marketAddress ? `; market ${c.marketAddress}` : ''}`,
      ...(typeof c.yesPrice === 'number' ? [`- ${COPY.priceLabel}: ${formatPrice(c.yesPrice)}`] : []),
      `- Liquidity: ${formatAmount(c.liquidity)} ${c.collateralSymbol}; evidence items: ${c.evidenceCount}`,
      `- Brief: ${urls.claim(c.id)} · Markdown: ${urls.claimMarkdown(c.id)} · Manifest: ${urls.manifest(c.id)}`,
      '',
    )
  }
  lines.push('## Policies (full text)', '')
  for (const p of ctx.policies) {
    lines.push(
      `### ${policyPath(p)} ${p.title}`,
      '',
      `Status: ${p.status}${p.gateReason ? ` (${p.gateReason})` : ''}. Content hash (keccak256 of the text below): ${p.contentHash}. URI: ${p.uri}.`,
      '',
      p.text.trim(),
      '',
    )
  }
  lines.push('## Risk disclosures', '', ...COPY.disclosures.map((d) => `- ${d.title}: ${d.body}`), '')
  lines.push(
    '## Launch gates (SPEC §10)',
    '',
    ...COPY.launchGates.map((g) => `${g.id}. ${g.title} (${g.status.replace('_', ' ')}): ${g.body}${g.note ? ` ${g.note}` : ''}`),
    '',
  )
  return lines.join('\n')
}

export function buildWellKnown(ctx: { siteUrl: string; appName: string }): Record<string, unknown> {
  const urls = agentUrls(ctx.siteUrl)
  return {
    name: ctx.appName,
    description: summaryLine(ctx.appName),
    version: '1',
    site: urls.site,
    api: {
      base: urls.api,
      claims: urls.claims,
      openClaims: urls.openClaims,
      claim: `${urls.claims}/{id}`,
      claimMarkdown: `${urls.claims}/{id}?format=md`,
      manifest: `${urls.claims}/{id}/manifest.json`,
      policies: urls.policies,
      policy: `${urls.policies}/{id}`,
      openapi: urls.openapi,
      feed: urls.feed,
    },
    llms: { txt: urls.llms, full: urls.llmsFull },
    schemas: {
      claimManifest: { id: CLAIM_MANIFEST_SCHEMA_URL, url: urls.schema },
      agentClaimBrief: { id: AGENT_BRIEF_SCHEMA_URL },
    },
    hashing: {
      manifest: 'keccak256(UTF-8(RFC 8785 canonical JSON))',
      question: 'keccak256(UTF-8(question text))',
      policy: 'keccak256(UTF-8(policy text))',
      environment: 'keccak256(canonical JSON of the environment pin without envHash)',
    },
    chains: SUPPORTED_CHAIN_IDS.map((id) => CHAINS[id])
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ({
        chainId: c.id,
        name: c.name,
        testnet: c.testnet,
        collateral: c.collateral,
        nativeToken: c.nativeSymbol,
        contracts: {
          marketFactory: c.seer.marketFactory,
          router: c.seer.router,
          conditionalTokens: c.seer.conditionalTokens,
          realityProxy: c.seer.realityProxy,
          reality: c.reality,
          arbitrator: c.arbitrator,
        },
        arbitration: {
          chainId: c.arbitration.chainId,
          contract: c.arbitration.requestContract,
          court: c.arbitration.courtName,
          feeCurrency: c.arbitration.feeCurrency,
        },
        realityTemplateId: c.realityTemplateId,
        answerTimeoutSeconds: c.seerQuestionTimeoutSeconds,
        verified: c.verified,
      })),
    evidenceMechanisms: Object.values(EVIDENCE_MECHANISMS).map((m) => ({ ...m, enabled: isEvidenceMechanismEnabled(m.id) })),
    policies: POLICIES.map((p) => ({
      id: p.id,
      version: p.version,
      title: p.title,
      status: p.status,
      contentHash: p.contentHash,
      uri: p.uri,
      url: urls.policy(p.id, p.version),
    })),
    outcomes: {
      yes: OUTCOME_META.yes.long,
      no: OUTCOME_META.no.long,
      invalid: OUTCOME_META.invalid.long,
    },
    disclaimers: [COPY.notAReview, COPY.noIsNotSafety, COPY.invalidIsNotRefund, COPY.liquidityIsNotBounty, COPY.untrustedContent],
  }
}
