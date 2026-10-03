import { toScaled, type ClaimDraft, type EnvironmentPin } from '@pine/core'
import {
  DRAFT_EVIDENCE_WINDOW_SECONDS,
  DRAFT_MIN_BOND_WEI,
  draftInputSchema,
  GIT_BRANCH_PATTERN,
  GITHUB_OWNER_PATTERN,
  GITHUB_REPO_NAME_PATTERN,
  POLICY_ID_PATTERN,
  POLICY_PARAMETER_KEY_PATTERN,
  POLICY_VERSION_PATTERN,
  type DraftInput,
} from '@pine/data'

// The composer's ClaimDraft → the backend's strict draft input (POST /api/v1/drafts, PUT /api/v1/drafts/:id). Invalid
// input is never sent: every rule the backend enforces is checked here and reported per field, with both the backend
// path and the composer field it comes from. Mapping decisions (documented for the composer):
// - Free text is NFC-normalized and trimmed; empty list entries are dropped. Text with control, bidi or zero-width
//   characters is refused (SEC-CLAIM-02), never silently cleaned.
// - environment.runtime = runtime, package manager and container image (one per line); dependencies = the pinned
//   lockfile and the environment notes; configuration = `key=value` lines; setup = the setup steps, one per line;
//   reproduction.notes stays empty. An empty configuration or setup list is rendered as "none" (the composer has no
//   other way to state it); other required text must be written by the user.
// - baseCommit is sent only for regression-only claims (the claim document's own rule); the PR base is not a term.
// - membership: the pull request when the source has one, else `source.branch`, else the default branch the UI passes.
// - evidenceWindowSeconds = spec.evidence.deadline − now; outside 3 days .. 30 days − 60 s it is an error, never clamped.
//   The backend measures the window from preview time, so the hook re-saves right before every preview.
// - minBondWei from spec.oracle.minBond (xDAI); null when unset (the deployment default).
// Not sent (fixed by Pine or absent from the v1 claim document): oracle opening time, timeout, arbitrator, language and
// category, the evidence mechanism, claimClass and specReference. The preview shows the values Pine actually uses.

export interface DraftFieldError {
  /** Backend input path, e.g. `scope.components.0`. */
  field: string
  /** Composer field the value comes from, e.g. `spec.scope.inScope` (same convention as the composer's issues). */
  composerPath: string
  message: string
}

export type DraftInputResult = { ok: true; input: DraftInput } | { ok: false; errors: DraftFieldError[] }

export interface DraftInputOptions {
  /** Branch used for the membership proof when the source has neither a pull request nor `branch`. */
  defaultBranch?: string
  /** Chain the claim must be published on (Pine publishes on Gnosis only). Default 100. */
  chainId?: number
  now?: Date
}

const XDAI_DECIMALS = 18
// The claim document's forbidden set (vendored safeText): C0 except tab/newline, DEL and C1, Arabic letter mark,
// zero-width and bidi controls, word joiner/invisible operators, the Reality separator U+241F and the BOM.
// eslint-disable-next-line no-control-regex -- the class exists to find control characters
const FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩␟﻿]/u
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
const PRINTABLE_TITLE = /^[\x20-\x7e]*$/

/** Composer field of a backend draft-input path (also used for backend VALIDATION_FAILED issues). */
export function composerPathOf(path: readonly (string | number)[]): string {
  const parts = path.map(String)
  if (parts[0] === 'input') parts.shift() // PUT bodies nest the input
  const [head, second, third] = parts
  switch (head) {
    case 'repository':
    case 'membership':
      return 'source'
    case 'commit':
      return 'source.commit'
    case 'baseCommit':
      return 'source.baseCommit'
    case 'policy':
      return 'spec.policyId'
    case 'scope':
      return second === 'outOfScope' ? 'spec.scope.outOfScope' : 'spec.scope.inScope'
    case 'policyParameters':
      return second ? `spec.parameters.${second}` : 'spec.parameters'
    case 'environment': {
      if (second === 'dependencies') return 'spec.environment.dependencyLock'
      if (second === 'configuration') return 'spec.environment.config'
      if (second === 'reproduction') {
        if (third === 'setup') return 'spec.environment.setupSteps'
        if (third === 'command') return 'spec.environment.reproductionCommand'
        return 'spec.environment.notes'
      }
      return second ? `spec.environment.${second}` : 'spec.environment'
    }
    case 'evidenceWindowSeconds':
      return 'spec.evidence.deadline'
    case 'minBondWei':
      return 'spec.oracle.minBond'
    case undefined:
      return 'spec'
    default:
      return `spec.${head}`
  }
}

const LABELS: Record<string, string> = {
  title: 'The title',
  requirement: 'The requirement',
  violation: 'The violation',
  allowedInputs: 'The allowed inputs',
  faultModel: 'The fault model',
  'scope.components': 'An in-scope component',
  'scope.outOfScope': 'An out-of-scope entry',
  assumptions: 'An assumption',
  exclusions: 'An exclusion',
  'environment.runtime': 'The runtime',
  'environment.dependencies': 'The dependencies',
  'environment.configuration': 'The configuration',
  'environment.externalState': 'The external state',
  'environment.reproduction.setup': 'The setup steps',
  'environment.reproduction.command': 'The reproduction command',
  'environment.reproduction.notes': 'The notes',
}

function labelOf(field: string): string {
  const base = field.replace(/\.\d+$/, '')
  return LABELS[base] ?? LABELS[field] ?? `“${field}”`
}

function codePoint(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
}

class Collector {
  readonly errors: DraftFieldError[] = []
  add(field: string, message: string, composerPath = composerPathOf(field.split('.'))): void {
    this.errors.push({ field, composerPath, message })
  }
}

/** NFC + trim, then the claim document's text rules with a precise message. Returns the normalized text, or null. */
function text(c: Collector, field: string, raw: string | undefined, max: number, opts: { min?: number; missing?: string } = {}): string | null {
  const value = (raw ?? '').normalize('NFC').trim()
  const min = opts.min ?? 1
  if (value.length < min) {
    c.add(field, opts.missing ?? `${labelOf(field)} is required.`)
    return null
  }
  if (LONE_SURROGATE.test(value)) {
    c.add(field, `${labelOf(field)} contains a broken character (an unpaired surrogate). Retype it.`)
    return null
  }
  const bad = FORBIDDEN.exec(value)
  if (bad) {
    c.add(field, `${labelOf(field)} contains an invisible or control character (${codePoint(bad[0])}) at position ${bad.index + 1}. Remove it.`)
    return null
  }
  if (value.length > max) {
    c.add(field, `${labelOf(field)} is ${value.length} characters long; the limit is ${max}.`)
    return null
  }
  return value
}

function list(c: Collector, field: string, raw: readonly string[] | undefined, itemMax: number, opts: { min?: number; max: number; missing?: string }): string[] {
  const items = (raw ?? []).map((v) => (typeof v === 'string' ? v.normalize('NFC').trim() : '')).filter((v) => v.length > 0)
  if (items.length < (opts.min ?? 0)) c.add(field, opts.missing ?? `${labelOf(field)} is required.`)
  if (items.length > opts.max) c.add(field, `At most ${opts.max} entries are allowed (found ${items.length}).`)
  const out: string[] = []
  items.forEach((item, i) => {
    const v = text(c, `${field}.${i}`, item, itemMax)
    if (v !== null) out.push(v)
  })
  return out
}

function title(c: Collector, raw: string | undefined): string | null {
  const value = (raw ?? '').normalize('NFC').trim()
  if (value.length === 0) {
    c.add('title', 'Write a title.')
    return null
  }
  if (value.length > 120) {
    c.add('title', `The title is ${value.length} characters long; the limit is 120.`)
    return null
  }
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charAt(i)
    if (!PRINTABLE_TITLE.test(ch) || ch === '"' || ch === '\\' || ch === '[' || ch === ']') {
      const shown = PRINTABLE_TITLE.test(ch) ? `“${ch}”` : codePoint(ch)
      c.add('title', `The title goes into the on-chain question, so it may only use printable ASCII without " \\ [ ] (found ${shown} at position ${i + 1}).`)
      return null
    }
  }
  return value
}

function parameterValue(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC').trim()
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.normalize('NFC').trim() : v)).filter((v) => v !== '')
  return value
}

function parameters(c: Collector, raw: ClaimDraft['spec']['parameters']): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!POLICY_PARAMETER_KEY_PATTERN.test(key)) {
      c.add(`policyParameters.${key}`, `Policy parameter “${key}” has an invalid name (letters, digits and _ only, starting with a letter).`)
      continue
    }
    const v = parameterValue(value)
    if (v === '' || v === undefined) continue // an emptied optional field means "not provided"
    if (typeof v === 'string' && FORBIDDEN.test(v)) {
      c.add(`policyParameters.${key}`, `Policy parameter “${key}” contains an invisible or control character. Remove it.`)
      continue
    }
    if (Array.isArray(v) && v.some((item) => typeof item === 'string' && FORBIDDEN.test(item))) {
      c.add(`policyParameters.${key}`, `Policy parameter “${key}” contains an invisible or control character. Remove it.`)
      continue
    }
    out[key] = v
  }
  return out
}

function joinLines(lines: (string | undefined)[]): string {
  return lines.filter((l): l is string => typeof l === 'string' && l.trim().length > 0).join('\n')
}

function environmentOf(c: Collector, env: Partial<EnvironmentPin> | undefined): DraftInput['environment'] | null {
  const e = env ?? {}
  const runtimeLine = (e.runtime ?? '').trim()
  if (!runtimeLine) c.add('environment.runtime', 'Name the runtime and its version, e.g. node 22.14.0.')
  const runtime = runtimeLine
    ? text(c, 'environment.runtime', joinLines([runtimeLine, e.packageManager?.trim() ? `Package manager: ${e.packageManager.trim()}` : undefined, e.containerImage?.trim() ? `Container image: ${e.containerImage.trim()}` : undefined]), 2_000)
    : null

  const lock = e.dependencyLock?.path?.trim()
    ? `Lockfile: ${e.dependencyLock.path.trim()}${e.dependencyLock.hash && /^0x[0-9a-fA-F]{2,}$/.test(e.dependencyLock.hash) ? ` (hash ${e.dependencyLock.hash.toLowerCase()})` : ''}`
    : undefined
  const dependencies = text(c, 'environment.dependencies', joinLines([lock, e.notes]), 4_000, {
    missing: 'Pin the dependency lockfile, or describe the dependencies in the environment notes.',
  })

  const entries = Object.entries(e.config ?? {}).filter(([k]) => k.trim().length > 0)
  for (const [k, v] of entries) {
    if (/[=\n\r]/.test(k) || /[\n\r]/.test(v)) c.add('environment.configuration', `Configuration entry “${k.slice(0, 40)}” cannot contain “=” in its key or line breaks.`)
  }
  const configuration = text(c, 'environment.configuration', entries.length > 0 ? entries.map(([k, v]) => `${k.trim()}=${v.trim()}`).join('\n') : 'none', 8_000)

  const externalState = text(c, 'environment.externalState', e.externalState, 4_000, {
    missing: 'Describe the external state the reproduction needs (write “none” if it needs none).',
  })
  const steps = (e.setupSteps ?? []).map((s) => (typeof s === 'string' ? s.trim() : '')).filter((s) => s.length > 0)
  const setup = text(c, 'environment.reproduction.setup', steps.length > 0 ? steps.join('\n') : 'none', 8_000)
  const command = text(c, 'environment.reproduction.command', e.reproductionCommand, 2_000, {
    missing: 'Write the command an investigator runs to reproduce the behavior.',
  })
  if (runtime === null || dependencies === null || configuration === null || externalState === null || setup === null || command === null) return null
  return { runtime, dependencies, configuration, externalState, reproduction: { setup, command, notes: '' } }
}

function minBondWei(c: Collector, minBond: string | undefined): string | null {
  if (minBond === undefined || minBond.trim() === '') return null
  const scaled = toScaled(minBond.trim(), XDAI_DECIMALS)
  if (!scaled || !scaled.exact || !/^\d*\.?\d*$/.test(minBond.trim())) {
    c.add('minBondWei', 'Enter the minimum bond as an xDAI amount with at most 18 decimals.')
    return null
  }
  if (scaled.value < DRAFT_MIN_BOND_WEI.min || scaled.value > DRAFT_MIN_BOND_WEI.max) {
    c.add('minBondWei', 'The minimum bond must be between 1 and 100 xDAI.')
    return null
  }
  return scaled.value.toString(10)
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const days = Math.floor(s / 86_400)
  const hours = Math.floor((s % 86_400) / 3_600)
  return days > 0 ? `${days} day${days === 1 ? '' : 's'}${hours ? ` ${hours} h` : ''}` : `${hours} h ${Math.floor((s % 3_600) / 60)} min`
}

/** The evidence window in seconds from `now`, or an error when the deadline is outside the backend bounds. */
function evidenceWindow(c: Collector, deadline: string | undefined, now: Date): number | null {
  if (!deadline) {
    c.add('evidenceWindowSeconds', 'Set an evidence deadline.')
    return null
  }
  const at = Date.parse(deadline)
  if (!Number.isFinite(at)) {
    c.add('evidenceWindowSeconds', 'The evidence deadline is not a valid date.')
    return null
  }
  const seconds = Math.floor((at - now.getTime()) / 1000)
  const { min, max } = DRAFT_EVIDENCE_WINDOW_SECONDS
  if (seconds < min || seconds > max) {
    const shown = seconds <= 0 ? 'in the past' : `${formatDuration(seconds)} from now`
    c.add('evidenceWindowSeconds', `The evidence deadline must be between 3 days and 30 days from now (it is ${shown}).`)
    return null
  }
  return seconds
}

/**
 * Maps a composer draft to the backend's draft input. Pure: the same draft, options and `now` give the same result.
 * On success the input also passed the strict backend schema (vendored rules), so the request cannot fail validation
 * for format reasons; policy parameters are still checked by the backend against the policy's own schema.
 */
export function toDraftInput(draft: ClaimDraft, opts: DraftInputOptions = {}): DraftInputResult {
  const c = new Collector()
  const now = opts.now ?? new Date()
  const spec = draft.spec
  const source = draft.source
  const expectedChain = opts.chainId ?? 100

  const chainId = draft.funding?.chainId ?? spec.oracle?.chainId
  if (chainId !== undefined && chainId !== expectedChain) {
    c.add('chainId', `Pine publishes claims on Gnosis (chain ${expectedChain}) only; this draft targets chain ${chainId}.`, 'funding.chainId')
  }

  // Source: repository, commit, membership, base commit.
  let repository: DraftInput['repository'] | null = null
  let commit: string | null = null
  let membership: DraftInput['membership'] | null = null
  let baseCommit: string | null = null
  if (!source) {
    c.add('repository', 'Select a repository and the exact commit to pin.', 'source')
  } else {
    if (!GITHUB_OWNER_PATTERN.test(source.owner) || !GITHUB_REPO_NAME_PATTERN.test(source.repo) || source.repo === '.' || source.repo === '..') {
      c.add('repository', 'The repository owner or name is not a valid GitHub name.', 'source')
    } else {
      repository = { owner: source.owner, name: source.repo }
    }
    const sha = source.commit?.sha?.toLowerCase() ?? ''
    if (!/^[0-9a-f]{40}$/.test(sha)) c.add('commit', 'Pin the full 40-character commit id.', 'source.commit')
    else commit = sha
    if (source.pullRequest) {
      const n = source.pullRequest.number
      if (Number.isInteger(n) && n > 0 && n <= 2 ** 31 - 1) membership = { kind: 'pull', number: n }
      else c.add('membership', 'The pull request number is invalid.', 'source')
    } else {
      const branch = (source.branch ?? opts.defaultBranch ?? '').trim()
      if (!branch) {
        c.add('membership', 'Choose the pull request or the branch that contains the commit, so Pine can prove the commit belongs to the repository.', 'source')
      } else if (!GIT_BRANCH_PATTERN.test(branch) || branch.split('/').some((p) => p === '' || p === '.' || p === '..')) {
        c.add('membership', `“${branch.slice(0, 60)}” is not a branch name Pine accepts.`, 'source')
      } else {
        membership = { kind: 'branch', name: branch }
      }
    }
    if (spec.regressionOnly) {
      const base = source.baseCommit?.sha?.toLowerCase() ?? ''
      if (!/^[0-9a-f]{40}$/.test(base)) c.add('baseCommit', 'Regression-only claims need a pinned base commit to compare against.', 'source.baseCommit')
      else if (base === commit) c.add('baseCommit', 'The base commit must differ from the selected commit.', 'source.baseCommit')
      else baseCommit = base
    }
  }

  // Policy.
  let policy: DraftInput['policy'] | null = null
  if (!spec.policyId || !POLICY_ID_PATTERN.test(spec.policyId)) c.add('policy', 'Choose a policy.', 'spec.policyId')
  else if (!spec.policyVersion || !POLICY_VERSION_PATTERN.test(spec.policyVersion)) c.add('policy', 'Choose a policy version.', 'spec.policyVersion')
  else policy = { id: spec.policyId, version: spec.policyVersion }

  const t = title(c, spec.title)
  const requirement = text(c, 'requirement', spec.requirement, 4_000, { missing: 'State the exact requirement the code must meet.' })
  const violation = text(c, 'violation', spec.violation, 4_000, { missing: 'Describe what a violation of the requirement looks like.' })
  const components = list(c, 'scope.components', spec.scope?.inScope, 300, { min: 1, max: 50, missing: 'List at least one in-scope component.' })
  const outOfScope = list(c, 'scope.outOfScope', spec.scope?.outOfScope, 300, { max: 50 })
  const allowedInputs = text(c, 'allowedInputs', spec.allowedInputs, 4_000, { missing: 'Describe the inputs an investigator may use.' })
  const assumptions = list(c, 'assumptions', spec.assumptions, 1_000, { max: 50 })
  const faultModel = text(c, 'faultModel', spec.faultModel, 4_000, { missing: 'Describe the fault model (which failures count).' })
  const exclusions = list(c, 'exclusions', spec.exclusions, 1_000, { max: 50 })
  const policyParameters = parameters(c, spec.parameters)
  const environment = environmentOf(c, spec.environment)
  const evidenceWindowSeconds = evidenceWindow(c, spec.evidence?.deadline, now)
  const bond = minBondWei(c, spec.oracle?.minBond)

  if (c.errors.length > 0) return { ok: false, errors: c.errors }
  const candidate = {
    repository,
    commit,
    baseCommit,
    membership,
    policy,
    title: t,
    requirement,
    violation,
    scope: { components, outOfScope },
    allowedInputs,
    assumptions,
    faultModel,
    regressionOnly: spec.regressionOnly ?? false,
    exclusions,
    policyParameters,
    environment,
    evidenceWindowSeconds,
    minBondWei: bond,
  }
  // Backstop: the exact strict backend schema (vendored text rules).
  const parsed = draftInputSchema.safeParse(candidate)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => {
        const path = issue.path.map(String)
        return { field: path.join('.'), composerPath: composerPathOf(path), message: issue.message }
      }),
    }
  }
  return { ok: true, input: parsed.data }
}
