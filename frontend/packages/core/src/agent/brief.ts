/**
 * Agent claim brief: the self-contained, machine-readable investigation brief for one claim,
 * and its Markdown rendering (a prompt an AI agent can act on).
 */
import { COPY } from '../copy'
import { getEvidenceMechanism } from '../evidence'
import { formatClaimNumber, formatPrice, formatUtcMinute } from '../format'
import { OUTCOME_META, STATUS_META } from '../lifecycle'
import { AGENT_BRIEF_SCHEMA_URL, MANIFEST_DISCLAIMERS } from '../manifest'
import { getPolicy, policyPath } from '../policies'
import type { AgentClaimBrief, ClaimDetail, EnvironmentPin, Hex } from '../types'
import { agentUrls } from './urls'

const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex

function unique(items: (string | undefined | null)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const i of items) {
    const t = (i ?? '').trim()
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

function latest(claim: ClaimDetail): string {
  let best = claim.createdAt
  for (const e of claim.timeline ?? []) {
    if (!e.scheduled && e.at > best) best = e.at
  }
  for (const e of claim.evidence ?? []) {
    if (e.submittedAt > best) best = e.submittedAt
  }
  return best
}

const EMPTY_ENV: EnvironmentPin = {
  runtime: 'unspecified',
  config: {},
  configHash: ZERO_HASH,
  reproductionCommand: '',
  setupSteps: [],
  envHash: ZERO_HASH,
}

/** Build the agent brief. Never throws on partially populated claims (publishing/failed fixtures). */
export function toAgentBrief(claim: ClaimDetail, ctx: { siteUrl: string }): AgentClaimBrief {
  const urls = agentUrls(ctx.siteUrl)
  const manifest = claim.manifest
  const spec = manifest?.claim
  const source = manifest?.source
  const policy = getPolicy(claim.policy?.id ?? manifest?.policy?.id ?? '', claim.policy?.version ?? manifest?.policy?.version)
  const owner = source?.owner ?? claim.source.owner
  const repo = source?.repo ?? claim.source.repo
  const sha = source?.commit?.sha ?? claim.source.commitSha
  const repoUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const deadline = spec?.evidence?.deadline ?? claim.evidenceDeadline
  const mechanism = getEvidenceMechanism(spec?.evidence?.mechanism ?? 'erc1497-arbitrator-proxy', claim.chainId)
  const env = spec?.environment ?? EMPTY_ENV
  const prNumber = source?.pullRequest?.number ?? claim.source.prNumber

  const brief: AgentClaimBrief = {
    schema: AGENT_BRIEF_SCHEMA_URL,
    id: claim.id,
    number: claim.number,
    url: urls.claimPage(claim.id),
    status: claim.status,
    question: manifest?.question?.text ?? '',
    questionHash: manifest?.question?.hash ?? ZERO_HASH,
    manifest: { uri: claim.manifestUri, hash: claim.manifestHash, jsonUrl: urls.manifest(claim.id) },
    policy: {
      id: manifest?.policy?.id ?? claim.policy.id,
      version: manifest?.policy?.version ?? claim.policy.version,
      hash: manifest?.policy?.hash ?? policy?.contentHash ?? ZERO_HASH,
      uri: manifest?.policy?.uri ?? policy?.uri ?? '',
      url: urls.policy(claim.policy.id, claim.policy.version),
      title: claim.policy.title ?? policy?.title ?? '',
    },
    target: {
      repository: repoUrl,
      commit: sha,
      // Always the canonical GitHub URL for the pinned commit: a manifest is creator-authored, and its
      // htmlUrl must not be able to send investigators to another host.
      commitUrl: `${repoUrl}/commit/${encodeURIComponent(sha)}`,
    },
    requirement: spec?.requirement ?? '',
    violation: spec?.violation ?? claim.violation,
    scope: { inScope: spec?.scope?.inScope ?? [], outOfScope: spec?.scope?.outOfScope ?? [] },
    assumptions: spec?.assumptions ?? [],
    exclusions: unique([...(spec?.exclusions ?? []), ...(policy?.exclusions ?? [])]),
    environment: env,
    reproduction: { command: env.reproductionCommand, setupSteps: env.setupSteps ?? [] },
    evidence: {
      mechanism,
      deadline,
      deadlineTs: Math.floor(new Date(deadline).getTime() / 1000),
      requirements: unique([
        ...(policy?.evidenceRequirements ?? []),
        'A reproducible test or demonstration against the pinned commit and environment, with the reproduction command, expected behavior and actual behavior.',
        'An explanation connecting the failure to the exact requirement and violation of this claim.',
      ]),
      submitUrl: urls.evidencePage(claim.id),
    },
    disclaimers: manifest?.disclaimers?.length ? manifest.disclaimers : [...MANIFEST_DISCLAIMERS],
    updatedAt: latest(claim),
  }

  if (claim.outcome) brief.outcome = claim.outcome
  if (spec?.faultModel) brief.faultModel = spec.faultModel
  if (source?.baseCommit?.sha) brief.target.baseCommit = source.baseCommit.sha
  if (prNumber) brief.target.pullRequest = `${repoUrl}/pull/${Number(prNumber)}`

  if (claim.market) {
    brief.market = {
      chainId: claim.market.chainId,
      address: claim.market.address,
      seerUrl: claim.market.seerUrl,
      collateral: claim.market.collateral?.symbol ?? claim.collateralSymbol,
      outcomes: (claim.market.outcomes ?? []).map((o) => ({ label: o.label, price: o.price, token: o.token })),
      liquidity: claim.market.liquidity,
    }
  }
  if (claim.oracle) {
    brief.oracle = {
      realityQuestionId: claim.oracle.realityQuestionId,
      realityUrl: claim.oracle.realityUrl,
      openingTime: claim.oracle.openingTime,
    }
    if (claim.oracle.currentAnswer) brief.oracle.currentAnswer = claim.oracle.currentAnswer
  }
  return brief
}

// ---------------------------------------------------------------------------
// Markdown rendering of creator-authored (untrusted) text.
// Claim text comes from the manifest, which anyone can author. It must never be able to add
// headings, list items or fake sections (for example a second "How to submit") to the prompt.
// ---------------------------------------------------------------------------

const LINE_BREAKS = /[\r\n\u0085\u2028\u2029]+/g

/** One line: line breaks collapsed to spaces. */
function inline(s: unknown): string {
  return String(s ?? '').replace(LINE_BREAKS, ' ').trim()
}

/** Escapes characters that would start a block (heading, quote, list, table, fence) at line start. */
function escapeLineStart(line: string): string {
  return line.replace(/^(\s*)([#>*+\-|=`~_]|\d+[.)])/, '$1\\$2')
}

/** Inline text in a paragraph or list item. */
function text(s: unknown): string {
  return escapeLineStart(inline(s))
}

function longestRun(s: string, ch: string): number {
  let best = 0
  let cur = 0
  for (const c of s) {
    cur = c === ch ? cur + 1 : 0
    if (cur > best) best = cur
  }
  return best
}

/** Inline code span that backticks inside the value cannot close. */
function codeSpan(s: unknown): string {
  const v = inline(s)
  const fence = '`'.repeat(longestRun(v, '`') + 1)
  const pad = v.startsWith('`') || v.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${v}${pad}${fence}`
}

/** Fenced block whose fence is longer than any backtick run inside, so the content cannot close it. */
function fenced(s: string, info = ''): string {
  const body = s.replace(/\r\n?/g, '\n')
  const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1))
  return `${fence}${info}\n${body}\n${fence}`
}

/** Creator-authored prose: a single line stays a paragraph; multi-line text becomes a fenced text block. */
function prose(s: string): string {
  const t = String(s ?? '').replace(/\r\n?/g, '\n').trim()
  if (!/[\n\u0085\u2028\u2029]/.test(t)) return text(t)
  return fenced(t, 'text')
}

function bullets(items: string[], empty = '_None specified._'): string {
  return items.length ? items.map((i) => `- ${text(i)}`).join('\n') : empty
}

function code(s: string): string {
  return fenced(s, 'sh')
}

/** Self-contained Markdown investigation prompt. */
export function briefToMarkdown(brief: AgentClaimBrief): string {
  const status = STATUS_META[brief.status]?.label ?? brief.status
  const outcome = brief.outcome ? ` — ${OUTCOME_META[brief.outcome].label}` : ''
  const env = brief.environment
  const configLines = Object.keys(env.config ?? {})
    .sort()
    .map((k) => `- ${codeSpan(k)} = ${codeSpan(env.config[k])}`)
  const deadlineUtc = formatUtcMinute(brief.evidence.deadline)
  const lines: string[] = [
    `# ${formatClaimNumber(brief.number)} — investigation brief`,
    '',
    `Status: **${status}${outcome}**. Claim page: ${inline(brief.url)}`,
    '',
    '## Question (immutable)',
    '',
    `> ${text(brief.question)}`,
    '',
    `Question hash: ${codeSpan(brief.questionHash)}`,
    '',
    '## Your task',
    '',
    `Find a reproducible counterexample showing that **${inline(brief.violation).replace(/[*_]/g, (c) => `\\${c}`).replace(/[.\s]+$/, '')}**, against the exact pinned commit and environment below, and submit it before **${deadlineUtc}** (unix ${brief.evidence.deadlineTs}). Only a timely, admissible demonstration of this specific violation counts.`,
    '',
    '## Target',
    '',
    `- Repository: ${inline(brief.target.repository)}`,
    `- Commit: ${codeSpan(brief.target.commit)} (${inline(brief.target.commitUrl)})`,
  ]
  if (brief.target.baseCommit) lines.push(`- Base commit (only regressions relative to it qualify): ${codeSpan(brief.target.baseCommit)}`)
  if (brief.target.pullRequest) lines.push(`- Pull request: ${inline(brief.target.pullRequest)}`)
  lines.push(
    '',
    '## Requirement',
    '',
    brief.requirement ? prose(brief.requirement) : '_See manifest._',
    '',
    '## Scope',
    '',
    '**In scope**',
    '',
    bullets(brief.scope.inScope),
    '',
    '**Out of scope**',
    '',
    bullets(brief.scope.outOfScope),
    '',
  )
  if (brief.faultModel) lines.push('## Fault model', '', prose(brief.faultModel), '')
  lines.push(
    '## Assumptions',
    '',
    bullets(brief.assumptions),
    '',
    '## Environment (pinned)',
    '',
    `- Runtime: ${text(env.runtime)}`,
  )
  if (env.packageManager) lines.push(`- Package manager: ${text(env.packageManager)}`)
  if (env.dependencyLock) lines.push(`- Lockfile: ${codeSpan(env.dependencyLock.path)} (keccak256 ${codeSpan(env.dependencyLock.hash)})`)
  if (env.containerImage) lines.push(`- Container image: ${codeSpan(env.containerImage)}`)
  if (env.externalState) lines.push(`- External state: ${text(env.externalState)}`)
  lines.push(`- Config hash: ${codeSpan(env.configHash)}`, `- Environment hash: ${codeSpan(env.envHash)}`)
  if (configLines.length) lines.push('', 'Non-secret configuration:', '', ...configLines)
  if (env.notes) lines.push('', 'Notes:', '', prose(env.notes))
  lines.push('', '## Reproduce', '')
  if (brief.reproduction.setupSteps.length) {
    lines.push('Setup:', '', ...brief.reproduction.setupSteps.map((s, i) => `${i + 1}. ${text(s)}`), '')
  }
  lines.push(brief.reproduction.command ? code(brief.reproduction.command) : '_No command pinned._', '')
  lines.push(
    '## Evidence requirements',
    '',
    bullets(brief.evidence.requirements),
    '',
    '## How to submit',
    '',
    `- Channel: ${brief.evidence.mechanism.label} — ${brief.evidence.mechanism.description}`,
  )
  if (brief.evidence.mechanism.contract) {
    lines.push(`- Contract: ${codeSpan(brief.evidence.mechanism.contract)} on chain ${inline(brief.evidence.mechanism.chainId)}`)
  }
  if (brief.oracle?.realityQuestionId) {
    lines.push(`- Evidence group / arbitration id: uint256(${codeSpan(brief.oracle.realityQuestionId)})`)
  }
  lines.push(
    `- Deadline: ${deadlineUtc} (unix ${brief.evidence.deadlineTs}). The submission transaction's block timestamp is the timeliness proof.`,
    `- Submission page: ${inline(brief.evidence.submitUrl)}`,
  )
  if (brief.evidence.mechanism.launchGate) lines.push(`- Caveat: ${brief.evidence.mechanism.launchGate}`)
  lines.push(
    '',
    '## Admissibility and exclusions',
    '',
    'A counterexample must be timely, identify the pinned artifact, and demonstrate the stated violation under the allowed conditions. A test that alters the target’s behavior, assumes unavailable privileges, or depends on an excluded environment is not sufficient.',
    '',
    bullets(brief.exclusions),
    '',
    '## Rules of engagement',
    '',
    `- ${COPY.untrustedContent}`,
    `- ${COPY.noAttackAuthorization} Never use production keys, real customer data, or live transfers.`,
    `- ${COPY.evidenceIsNotPayment}`,
    '',
    '## Immutable references',
    '',
    `- Policy: ${inline(policyPath(brief.policy))} — ${inline(brief.policy.title)} (hash ${codeSpan(brief.policy.hash)}, ${inline(brief.policy.uri)}); text: ${inline(brief.policy.url)}`,
    `- Manifest: ${inline(brief.manifest.uri)} (keccak256 of canonical JSON ${codeSpan(brief.manifest.hash)}); JSON: ${inline(brief.manifest.jsonUrl)}`,
  )
  if (brief.market) {
    const yes = brief.market.outcomes.find((o) => o.label.toLowerCase() === 'yes')
    lines.push(
      `- Market: ${inline(brief.market.seerUrl)} (chain ${inline(brief.market.chainId)}, ${codeSpan(brief.market.address)}, collateral ${inline(brief.market.collateral)}, liquidity ${inline(brief.market.liquidity)})`,
    )
    if (yes) lines.push(`- ${COPY.priceLabel}: ${formatPrice(yes.price)}. ${COPY.priceCaveat}`)
  }
  if (brief.oracle) {
    lines.push(
      `- Oracle: ${inline(brief.oracle.realityUrl)} (opens ${formatUtcMinute(brief.oracle.openingTime)}${brief.oracle.currentAnswer ? `, current answer: ${inline(brief.oracle.currentAnswer)}` : ''})`,
    )
  }
  lines.push('', '## Disclaimers', '', bullets(brief.disclaimers), '', `_Updated ${inline(brief.updatedAt)}. Schema: ${inline(brief.schema)}_`, '')
  return lines.join('\n')
}
