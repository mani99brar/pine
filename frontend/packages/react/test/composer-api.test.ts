/** The claim composer in `api` mode (Pine backend): backend rules, derived timeline, question sketch, policies. */
import { describe, expect, it } from 'vitest'
import type { ClaimDraft, PolicyVersion, SourceRef } from '@pine/core'
import { getPolicy } from '@pine/core'
import { rawCidFromSha256, renderQuestion, type Hex32 } from '@pine/core/pine-shared'
import {
  API_COMPOSER_RULES,
  apiComposerIssues,
  apiDeadlineForDays,
  apiDefaultDeadline,
  apiQuestionSketch,
  apiTimeline,
  isPublishablePolicy,
} from '../src/composer/api-rules'
import { createDefaultDraft, deriveComposer, mergeDraft, normalizeDraft } from '../src/composer/defaults'

const NOW = new Date('2026-10-04T12:17:42Z')
const DAY = 86_400_000
const HOUR = 3_600_000
const COMMIT = 'c84e3dd7c01a2be9db29c372ed0006b55bf59ec0'
const REGISTRY = '0x2000000000000000000000000000000000000002'
const POLICY_SHA = `0x${'ab'.repeat(32)}`
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

function backendPolicy(over: Partial<PolicyVersion> = {}): PolicyVersion {
  return {
    id: 'BOT-001',
    family: 'BOT',
    version: '0.2.0',
    title: 'Automation and keeper reliability',
    summary: '',
    status: 'draft',
    contentHash: POLICY_SHA as `0x${string}`,
    uri: `ipfs://${rawCidFromSha256(POLICY_SHA as Hex32)}`,
    text: '',
    intendedUse: [],
    examples: [],
    claimClasses: [],
    parameters: [
      { key: 'sourceRequirement', label: 'Source requirement', help: '', kind: 'text', required: true, maxLength: 1000 },
      { key: 'startingStates', label: 'Starting states', help: '', kind: 'longtext', required: true, maxLength: 4000 },
      { key: 'simulatedAdapters', label: 'Simulated adapters', help: '', kind: 'list', required: true, maxLength: 100 },
    ],
    evidenceRequirements: [],
    exclusions: [],
    outcomeRules: { yes: '', no: '', invalid: '' },
    publishedAt: '',
    ...over,
  }
}

const SOURCE: SourceRef = {
  provider: 'github',
  owner: 'kleros',
  repo: 'kleros-v2',
  repoId: 427_016_914,
  pullRequest: { number: 2101, title: 'Reporter journal', htmlUrl: 'https://github.com/kleros/kleros-v2/pull/2101', author: 'tomas', state: 'open' },
  commit: { sha: COMMIT, message: 'reporter: persist the deposit source', author: 'tomas', committedAt: '2026-10-02T09:00:00Z', htmlUrl: `https://github.com/kleros/kleros-v2/commit/${COMMIT}` },
}

/** A draft the backend accepts (api mode), seven days of evidence window. */
function apiDraft(patch: (d: ClaimDraft) => ClaimDraft = (d) => d): ClaimDraft {
  const d = createDefaultDraft({ id: 'dapi0001', owner: 'local', chainId: 100, now: NOW, deadline: apiDefaultDeadline(NOW), normalize: { staticPolicies: false } })
  const full = mergeDraft(d, {
    source: SOURCE,
    spec: {
      ...d.spec,
      policyId: 'BOT-001',
      policyVersion: '0.2.0',
      title: 'Reporter deposits never draw on the gas reserve',
      requirement: 'Reporter-deposit principal must not be funded from arbitration allocations.',
      violation: 'reporter-deposit principal funded from the operator gas reserve',
      scope: { inScope: ['bots/gateway-balancer/src/reporter'], outOfScope: [] },
      parameters: { sourceRequirement: 'Spec section 4', startingStates: 'fresh deploy', simulatedAdapters: ['lifi'] },
      faultModel: 'crash between plan and submit',
      allowedInputs: 'any configuration of the bot',
      environment: { ...d.spec.environment!, runtime: 'node 22.14.0', externalState: 'none', reproductionCommand: 'pnpm vitest run', notes: 'pnpm 10, lockfile in repo' },
    },
  })
  return patch(normalizeDraft(full, d, { staticPolicies: false }))
}

const issuesOf = (d: ClaimDraft, policy: PolicyVersion | null | undefined = backendPolicy(), now = NOW) => apiComposerIssues(d, { policy, now, chainId: 100 })
const at = (d: ClaimDraft, path: string, policy?: PolicyVersion | null) => issuesOf(d, policy).filter((i) => i.path === path)

describe('api composer: a complete draft', () => {
  it('has no issues, builds nothing locally and exposes the backend timeline', () => {
    const d = apiDraft()
    expect(issuesOf(d)).toEqual([])
    const derived = deriveComposer(d, { now: NOW, api: { policy: backendPolicy(), evidenceRegistry: REGISTRY, chainId: 100 } })
    expect(derived.validation).toEqual({ ok: true, issues: [] })
    expect(derived.question).toBeUndefined()
    expect(derived.manifest).toBeUndefined()
    expect(derived.funding).toBeUndefined()
    expect(derived.policy?.version).toBe('0.2.0')
    expect(derived.api?.policyPublishable).toBe(true)
    expect(derived.api?.evidenceWindowSeconds).toBe(Math.floor((Date.parse(d.spec.evidence!.deadline) - NOW.getTime()) / 1000))
    expect(derived.api?.questionSketch).toMatch(/^Pine claim \[Reporter deposits never draw on the gas reserve\]: /)
  })

  it('funding never blocks publishing (liquidity is a separate plan after the claim exists)', () => {
    const d = apiDraft((x) => ({ ...x, funding: { ...x.funding, liquidity: '', spendingLimit: '-3', priceRange: [0.9, 0.1] } }))
    expect(issuesOf(d)).toEqual([])
  })

  it('ignores the static catalog: a backend-only version and parameters are not "unknown"', () => {
    const d = apiDraft()
    expect(getPolicy('BOT-001', '0.2.0')).toBeUndefined()
    expect(issuesOf(d).some((i) => i.path.startsWith('spec.policy') || i.path.startsWith('spec.parameters'))).toBe(false)
  })

  it('keeps the backend version when the policy changes (no static catalog lookup)', () => {
    const d = apiDraft()
    const next = normalizeDraft({ ...d, spec: { ...d.spec, policyId: 'FUNC-001', policyVersion: '0.3.0' } }, d, { staticPolicies: false })
    expect(next.spec.policyVersion).toBe('0.3.0')
    // The demo composer still follows the static catalog.
    expect(normalizeDraft({ ...d, spec: { ...d.spec, policyId: 'FUNC-001', policyVersion: '0.3.0' } }, d).spec.policyVersion).toBe('0.1.0')
  })
})

describe('api composer: backend field rules next to the composer fields', () => {
  it('SEC-CLAIM-05 refuses title characters that could break the on-chain question, with the position', () => {
    for (const bad of ['Deposits "never" leak', 'Deposits [x] never leak', 'Deposits \\ never leak']) {
      const issues = at(apiDraft((d) => ({ ...d, spec: { ...d.spec, title: bad } })), 'spec.title')
      expect(issues).toHaveLength(1)
      expect(issues[0]?.message).toMatch(/printable ASCII without " \\ \[ \] \(found .+ at position \d+\)/)
      expect(issues[0]?.stage).toBe('claim')
    }
    expect(at(apiDraft((d) => ({ ...d, spec: { ...d.spec, title: 'Déposits never leak' } })), 'spec.title')[0]?.message).toMatch(/U\+00E9/)
  })

  it('SEC-CLAIM-02 refuses invisible and control characters in claim text', () => {
    const d = apiDraft((x) => ({ ...x, spec: { ...x.spec, requirement: 'Deposits‮never leak' } }))
    expect(at(d, 'spec.requirement')[0]?.message).toMatch(/invisible or control character \(U\+202E\)/)
  })

  it('needs at least one in-scope component and the texts the claim document requires', () => {
    const d = apiDraft((x) => ({ ...x, spec: { ...x.spec, scope: { inScope: [], outOfScope: [] }, faultModel: undefined, allowedInputs: ' ' } }))
    expect(at(d, 'spec.scope.inScope').map((i) => i.message)).toEqual(['List at least one in-scope component.'])
    expect(at(d, 'spec.faultModel')).toHaveLength(1)
    expect(at(d, 'spec.allowedInputs')).toHaveLength(1)
    const env = apiDraft((x) => ({ ...x, spec: { ...x.spec, environment: { ...x.spec.environment!, externalState: undefined, notes: undefined } } }))
    expect(at(env, 'spec.environment.externalState')[0]?.message).toMatch(/write “none”/)
    expect(at(env, 'spec.environment.dependencyLock')[0]?.message).toMatch(/lockfile/)
    expect(issuesOf(env).every((i) => i.stage === 'claim')).toBe(true)
  })

  it('SEC-CLAIM-07 keeps the evidence deadline inside the 3..30 day window, at the boundaries', () => {
    const t = NOW.getTime()
    const withDeadline = (ms: number) => apiDraft((d) => ({ ...d, spec: { ...d.spec, evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline: iso(ms) } } }))
    const min = API_COMPOSER_RULES.evidenceWindowSeconds.min * 1000
    const max = API_COMPOSER_RULES.evidenceWindowSeconds.max * 1000
    // Whole seconds (an ISO deadline has no milliseconds): NOW is …:42.000.
    expect(at(withDeadline(t + min), 'spec.evidence.deadline')).toEqual([])
    expect(at(withDeadline(t + min - 1000), 'spec.evidence.deadline')[0]?.message).toMatch(/between 3 days and 30 days from now/)
    expect(at(withDeadline(t + max), 'spec.evidence.deadline')).toEqual([])
    expect(at(withDeadline(t + max + 1000), 'spec.evidence.deadline')[0]?.stage).toBe('deadlines')
    expect(at(withDeadline(t - HOUR), 'spec.evidence.deadline')[0]?.message).toMatch(/in the past/)
  })

  it('bounds the minimum answer bond to 1..100 xDAI (empty = the deployment default)', () => {
    const bond = (minBond: string) => apiDraft((d) => ({ ...d, spec: { ...d.spec, oracle: { ...d.spec.oracle!, minBond } } }))
    expect(at(bond('0.5'), 'spec.oracle.minBond')[0]?.message).toBe('The minimum bond must be between 1 and 100 xDAI.')
    expect(at(bond('100.000000000000000001'), 'spec.oracle.minBond')).toHaveLength(1)
    expect(at(bond('1e3'), 'spec.oracle.minBond')).toHaveLength(1)
    expect(at(bond('1'), 'spec.oracle.minBond')).toEqual([])
    expect(at(bond('100'), 'spec.oracle.minBond')).toEqual([])
    expect(at(bond(''), 'spec.oracle.minBond')).toEqual([])
  })

  it('SEC-GH-11 asks for the pull request or the branch that contains a commit (membership, not existence)', () => {
    const noPr = apiDraft((d) => ({ ...d, source: { ...SOURCE, pullRequest: undefined } }))
    expect(at(noPr, 'source')[0]?.message).toMatch(/pull request or the branch/)
    expect(at(noPr, 'source')[0]?.stage).toBe('source')
    const branch = apiDraft((d) => ({ ...d, source: { ...SOURCE, pullRequest: undefined, branch: 'main' } }))
    expect(at(branch, 'source')).toEqual([])
    const bad = apiDraft((d) => ({ ...d, source: { ...SOURCE, pullRequest: undefined, branch: 'feat/../main' } }))
    expect(at(bad, 'source')[0]?.message).toMatch(/not a branch name Pine accepts/)
  })

  it('still refuses secret-looking configuration keys (the configuration is published)', () => {
    const d = apiDraft((x) => ({ ...x, spec: { ...x.spec, environment: { ...x.spec.environment!, config: { API_KEY: 'x' } } } }))
    expect(issuesOf(normalizeDraft(d, undefined, { staticPolicies: false })).some((i) => i.path === 'spec.environment.config.API_KEY')).toBe(true)
  })

  it('flags blanket claims in the title and the violation', () => {
    const d = apiDraft((x) => ({ ...x, spec: { ...x.spec, title: 'The bot is secure' } }))
    expect(at(d, 'spec.title')[0]?.message).toMatch(/"secure" implies a blanket claim/)
  })
})

describe('api composer: backend policies', () => {
  it('accepts approved and (where allowed) draft policies only', () => {
    expect(isPublishablePolicy(backendPolicy({ status: 'enabled' }))).toBe(true)
    expect(isPublishablePolicy(backendPolicy({ status: 'draft' }))).toBe(true)
    expect(isPublishablePolicy(backendPolicy({ status: 'gated' }))).toBe(false)
    expect(isPublishablePolicy(backendPolicy({ status: 'retired' }))).toBe(false)
    expect(isPublishablePolicy(undefined)).toBe(false)
  })

  it('SEC-CLAIM-06 refuses a gated policy (SC-001) with the backend gate reason', () => {
    const sc = backendPolicy({ id: 'SC-001', family: 'SC', status: 'gated', gateReason: 'SC-001 stays disabled until the disclosure process is approved.', parameters: [] })
    const d = apiDraft((x) => ({ ...x, spec: { ...x.spec, policyId: 'SC-001', parameters: {} } }))
    expect(at(d, 'spec.policyId', sc).map((i) => i.message)).toEqual(['SC-001 stays disabled until the disclosure process is approved.'])
    expect(at(d, 'spec.policyId', sc)[0]?.stage).toBe('policy')
  })

  it('SEC-CLAIM-03 refuses a policy the backend catalog does not list, and parameters the policy does not define', () => {
    const d = apiDraft((x) => ({ ...x, spec: { ...x.spec, policyId: 'NET-404', policyVersion: '9.9.9' } }))
    expect(at(d, 'spec.policyId', null)[0]?.message).toMatch(/does not list NET-404@9\.9\.9/)
    const extra = apiDraft((x) => ({ ...x, spec: { ...x.spec, parameters: { ...x.spec.parameters, formatDefinition: 'RFC 8259' } } }))
    expect(at(extra, 'spec.parameters.formatDefinition')[0]?.message).toMatch(/not a parameter of BOT-001@0\.2\.0/)
    // An emptied field is "not provided", never an unknown parameter.
    const emptied = apiDraft((x) => ({ ...x, spec: { ...x.spec, parameters: { ...x.spec.parameters, formatDefinition: '' } } }))
    expect(at(emptied, 'spec.parameters.formatDefinition')).toEqual([])
  })

  it('checks required parameters and their length caps from the policy schema', () => {
    const d = apiDraft((x) => ({ ...x, spec: { ...x.spec, parameters: { sourceRequirement: 'x'.repeat(1001), simulatedAdapters: [] } } }))
    expect(at(d, 'spec.parameters.sourceRequirement')[0]?.message).toBe('Source requirement must be at most 1000 characters.')
    expect(at(d, 'spec.parameters.startingStates')[0]?.message).toBe('Starting states is required by BOT-001.')
    expect(at(d, 'spec.parameters.simulatedAdapters')[0]?.stage).toBe('claim')
  })

  it('reports nothing about the policy while it loads, and a retryable issue when the catalog failed', () => {
    const d = apiDraft()
    expect(issuesOf(d, undefined)).toEqual([])
    expect(apiComposerIssues(d, { policy: undefined, policyError: true, now: NOW })[0]?.message).toMatch(/could not be loaded/)
    expect(at(apiDraft((x) => ({ ...x, spec: { ...x.spec, policyId: undefined } })), 'spec.policyId', undefined).map((i) => i.message)).toEqual(['Choose a policy.'])
  })
})

describe('api composer: deadlines the backend fixes', () => {
  it('new drafts start with the backend default window (7 days, on the hour)', () => {
    expect(apiDefaultDeadline(NOW)).toBe('2026-10-11T13:00:00Z')
  })

  it('presets stay inside the window with a margin, on whole hours', () => {
    const t = NOW.getTime()
    const three = Date.parse(apiDeadlineForDays(3, NOW))
    expect(three - t).toBeGreaterThanOrEqual(3 * DAY + HOUR)
    expect(three % HOUR).toBe(0)
    expect(apiDeadlineForDays(7, NOW)).toBe('2026-10-11T13:00:00Z')
    const thirty = Date.parse(apiDeadlineForDays(30, NOW))
    expect(thirty - t).toBeLessThanOrEqual(API_COMPOSER_RULES.evidenceWindowSeconds.max * 1000)
    expect(thirty - t).toBeGreaterThan(30 * DAY - 2 * HOUR)
    for (const days of API_COMPOSER_RULES.presetDays) {
      const d = apiDraft((x) => ({ ...x, spec: { ...x.spec, evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline: apiDeadlineForDays(days, NOW) } } }))
      expect(at(d, 'spec.evidence.deadline')).toEqual([])
    }
  })

  it('derives reveal (+48 h), the oracle opening (= reveal) and the earliest finalization (+3.5 days)', () => {
    const t = apiTimeline('2026-10-11T13:00:20Z')
    expect(t).toEqual({
      evidenceDeadline: '2026-10-11T13:01:00Z',
      revealDeadline: '2026-10-13T13:01:00Z',
      answersOpen: '2026-10-13T13:01:00Z',
      earliestFinalization: '2026-10-17T01:01:00Z',
    })
    expect(apiTimeline(undefined)).toBeUndefined()
    expect(apiTimeline('not a date')).toBeUndefined()
  })
})

describe('api composer: the question sketch', () => {
  const input = {
    title: 'Reporter deposits never draw on the gas reserve',
    repositoryId: 427_016_914,
    commit: COMMIT,
    timeline: apiTimeline('2026-10-11T13:00:00Z'),
    policySha256: POLICY_SHA,
    evidenceRegistry: REGISTRY,
  }

  it('is the registry question with only the claim document part elided', () => {
    const sketch = apiQuestionSketch(input)
    expect(sketch).not.toBeNull()
    const digest = `0x${'12'.repeat(32)}` as Hex32
    const real = renderQuestion({
      evidenceRegistry: REGISTRY,
      title: input.title,
      evidenceDeadline: Date.parse('2026-10-11T13:00:00Z') / 1000,
      revealDeadline: Date.parse('2026-10-13T13:00:00Z') / 1000,
      repositoryId: input.repositoryId,
      commit: COMMIT,
      claimDocumentSha256: digest,
      policyDocumentSha256: POLICY_SHA as Hex32,
    })
    expect(sketch?.replace('ipfs://… (sha256 …)', `ipfs://${rawCidFromSha256(digest)} (sha256 ${digest})`)).toBe(real)
    expect(sketch).toContain(`policy ipfs://${rawCidFromSha256(POLICY_SHA as Hex32)} (sha256 ${POLICY_SHA})`)
  })

  it('SEC-CLAIM-05 never shows a placeholder digest as if it were real, and is absent for an unsafe title', () => {
    const sketch = apiQuestionSketch(input) ?? ''
    expect(sketch).not.toMatch(/0x(5a){32}/)
    expect(sketch).not.toContain(rawCidFromSha256(`0x${'5a'.repeat(32)}` as Hex32))
    expect(apiQuestionSketch({ ...input, title: 'x] Yes = always [' })).toBeNull()
    expect(apiQuestionSketch({ ...input, title: 'a "quoted" title' })).toBeNull()
    expect(apiQuestionSketch({ ...input, repositoryId: undefined })).toBeNull()
    expect(apiQuestionSketch({ ...input, evidenceRegistry: undefined })).toBeNull()
  })
})
