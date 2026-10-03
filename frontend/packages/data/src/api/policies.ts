import type { Hex, PolicyFamilyId, PolicyParameterSpec, PolicyStatus, PolicyVersion } from '@pine/core'
import type { WirePolicyDetail, WirePolicyParameters, WirePolicySummary } from './read-schemas'

// Backend policy catalog → PolicyVersion. The backend serves id, version, title, digest, CID, status and (detail route)
// the Markdown text and gate; the structured sections the static catalog carries (intended use, evidence, exclusions,
// outcome rules) are extracted from that text as plain strings. Fields the backend has no data for stay neutral:
// `examples` and `claimClasses` are empty, `publishedAt` is "" (unknown).

/** Policy family from the id prefix ("BOT-001" → BOT); null for a family this frontend does not know. */
export function policyFamilyOf(id: string): PolicyFamilyId | null {
  const prefix = id.split('-', 1)[0]
  return prefix === 'FUNC' || prefix === 'BOT' || prefix === 'SC' ? prefix : null
}

/**
 * Status of a catalog entry on THIS deployment:
 * - approved and publishable → `enabled`
 * - draft and publishable (a development or staging deployment that allows draft policies) → `draft`
 * - retired → `retired`
 * - anything else (disabled, not enabled here, draft on production) → `gated`, with the reason.
 * A `draft` policy is usable for new claims here; it is not approved market terms.
 */
export function policyStatusOf(p: Pick<WirePolicySummary, 'status' | 'publishable'>, gate?: string | null): { status: PolicyStatus; gateReason?: string } {
  if (p.status === 'retired') return { status: 'retired' }
  if (p.publishable && p.status === 'approved') return { status: 'enabled' }
  if (p.publishable && p.status === 'draft') return { status: 'draft' }
  const reason =
    gate ??
    (p.status === 'disabled'
      ? 'This policy is disabled.'
      : p.status === 'draft'
        ? 'Draft policy: new claims cannot use it on this deployment.'
        : 'This policy is not enabled on this deployment.')
  return { status: 'gated', gateReason: reason }
}

const LONG_TEXT_FROM = 500

function humanize(key: string): string {
  const words = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
  return words ? `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}` : key
}

/**
 * Composer fields from the policy's parameter JSON Schema: string → `text` (or `longtext` above 500 characters),
 * string enum → `select`, array of strings → `list` (`multiselect` with an enum), boolean → `boolean`. Other types have
 * no input kind here and are left out (the backend still validates the parameters).
 */
export function policyParametersFromSchema(schema: WirePolicyParameters): PolicyParameterSpec[] {
  const required = new Set(schema.required ?? [])
  const out: PolicyParameterSpec[] = []
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const base = { key, label: prop.title ?? humanize(key), help: prop.description ?? '', required: required.has(key) }
    if (prop.type === 'string' && prop.enum && prop.enum.length > 0) {
      out.push({ ...base, kind: 'select', options: prop.enum.map((v) => ({ value: v, label: v })) })
    } else if (prop.type === 'string') {
      const long = prop.maxLength === undefined || prop.maxLength > LONG_TEXT_FROM
      out.push({ ...base, kind: long ? 'longtext' : 'text', ...(prop.maxLength !== undefined ? { maxLength: prop.maxLength } : {}) })
    } else if (prop.type === 'array' && prop.items?.type === 'string') {
      const items = prop.items
      if (items.enum && items.enum.length > 0) {
        out.push({ ...base, kind: 'multiselect', options: items.enum.map((v) => ({ value: v, label: v })) })
      } else {
        out.push({ ...base, kind: 'list', ...(items.maxLength !== undefined ? { maxLength: items.maxLength } : {}) })
      }
    } else if (prop.type === 'boolean') {
      out.push({ ...base, kind: 'boolean' })
    }
  }
  return out
}

/** Presentational Markdown markers removed from extracted plain-text items. */
function plain(line: string): string {
  return line
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

interface Block {
  heading: string
  lines: string[]
}

function blocks(text: string, level: '## ' | '### '): Block[] {
  const out: Block[] = []
  let current: Block | null = null
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ') || line.startsWith('### ')) {
      current = line.startsWith(level) ? { heading: plain(line.slice(level.length)).toLowerCase(), lines: [] } : null
      if (current) out.push(current)
      continue
    }
    current?.lines.push(line)
  }
  return out
}

/** Paragraphs and bullet items of a section, as plain text. */
function items(lines: readonly string[]): string[] {
  const out: string[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length > 0) out.push(plain(paragraph.join(' ')))
    paragraph = []
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') {
      flush()
    } else if (/^[-*] /.test(line) || /^\d+\. /.test(line)) {
      flush()
      out.push(plain(line.replace(/^(?:[-*]|\d+\.) /, '')))
    } else {
      paragraph.push(line)
    }
  }
  flush()
  return out.filter((x) => x.length > 0)
}

export interface PolicySections {
  summary: string
  intendedUse: string[]
  evidenceRequirements: string[]
  exclusions: string[]
  outcomeRules: { yes: string; no: string; invalid: string }
}

/** Plain-text sections of a catalog policy text (## Intended use, ## Evidence, ## Exclusions…, ### C5 Correct answer). */
export function policySectionsFromText(text: string): PolicySections {
  const top = blocks(text, '## ')
  const section = (match: (heading: string) => boolean) => items(top.find((b) => match(b.heading))?.lines ?? [])
  const intendedUse = section((h) => h === 'intended use')
  const first = intendedUse[0] ?? ''
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(first)?.[1] ?? first
  const answers = items(blocks(text, '### ').find((b) => /^c5\b/.test(b.heading))?.lines ?? [])
  const rule = (label: string) => answers.find((a) => a.toLowerCase().startsWith(label)) ?? ''
  return {
    summary: sentence.length > 300 ? `${sentence.slice(0, 297)}...` : sentence,
    intendedUse,
    evidenceRequirements: section((h) => h === 'evidence'),
    exclusions: section((h) => h.startsWith('exclusions')),
    outcomeRules: { yes: rule('yes'), no: rule('no'), invalid: rule('invalid') },
  }
}

/**
 * A catalog entry as a PolicyVersion. `contentHash` is the SHA-256 of the policy file bytes (the digest the claim
 * registry records), not the keccak256 the static catalog uses; `uri` is the raw-codec IPFS CID of those bytes.
 */
export function policyFromApi(summary: WirePolicySummary, detail: WirePolicyDetail | null, parameters: WirePolicyParameters | null): PolicyVersion | null {
  const family = policyFamilyOf(summary.id)
  if (!family) return null
  const { status, gateReason } = policyStatusOf(summary, detail?.gate)
  const sections = detail ? policySectionsFromText(detail.text) : null
  return {
    id: summary.id,
    family,
    version: summary.version,
    title: summary.title,
    summary: sections?.summary ?? '',
    status,
    ...(gateReason !== undefined ? { gateReason } : {}),
    contentHash: summary.sha256 as Hex,
    uri: `ipfs://${summary.cid}`,
    text: detail?.text ?? '',
    intendedUse: sections?.intendedUse ?? [],
    examples: [],
    claimClasses: [],
    parameters: parameters ? policyParametersFromSchema(parameters) : [],
    evidenceRequirements: sections?.evidenceRequirements ?? [],
    exclusions: sections?.exclusions ?? [],
    outcomeRules: sections?.outcomeRules ?? { yes: '', no: '', invalid: '' },
    publishedAt: '',
  }
}

/** Semver comparison for "latest version" lookups (catalog versions are validated `\d+.\d+.\d+`). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
