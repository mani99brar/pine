import { describe, expect, it } from 'vitest'
import type { ClaimDraft, Hex } from '@pine/core'
import { draftInputSchema } from '@pine/data'
import { composerPathOf, toDraftInput, type DraftFieldError } from '../src/api/draft-input'
import { COMMIT, NOW } from './api-write-chain'

const DAY_MS = 86_400_000
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const HASH = `0x${'ee'.repeat(32)}` as Hex

function baseDraft(): ClaimDraft {
  return {
    id: 'dtest0001',
    owner: 'local',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    stage: 'review',
    source: {
      provider: 'github',
      owner: 'kleros',
      repo: 'kleros-v2',
      repoId: 427_016_914,
      pullRequest: { number: 2101, title: 'Separate reporter deposits', htmlUrl: 'https://github.com/kleros/kleros-v2/pull/2101', author: 'dev', state: 'open' },
      commit: { sha: COMMIT.toUpperCase(), message: 'm', author: 'dev', committedAt: '2026-10-02T09:00:00Z', htmlUrl: `https://github.com/kleros/kleros-v2/commit/${COMMIT}` },
      baseCommit: { sha: 'b'.repeat(40), htmlUrl: 'https://github.com/kleros/kleros-v2/commit/bbbb' },
    },
    spec: {
      title: 'Reporter deposits never draw on the gas reserve',
      policyId: 'BOT-001',
      policyVersion: '0.1.0',
      requirement: '  Reporter-deposit principal must not be funded from arbitration allocations.  ',
      violation: 'reporter-deposit principal funded from the gas reserve',
      scope: { inScope: ['src/funding', '  '], outOfScope: ['UI'] },
      parameters: { sourceRequirement: 'Spec section 4', startingStates: 'fresh deploy', simulatedAdapters: ['lifi', ''], formatDefinition: '' },
      faultModel: 'process crash between plan and submit',
      allowedInputs: 'any JSON configuration',
      assumptions: ['Gas price below 50 gwei'],
      exclusions: ['Live transfers'],
      environment: {
        runtime: 'node 22.14.0',
        packageManager: 'pnpm 10.9.2',
        dependencyLock: { path: 'pnpm-lock.yaml', hash: HASH },
        config: { NETWORK: 'gnosis', MODE: 'test' },
        configHash: HASH,
        containerImage: 'node@sha256:abc',
        externalState: 'none',
        reproductionCommand: 'pnpm vitest run test/reporter.spec.ts',
        setupSteps: ['pnpm install --frozen-lockfile', 'cp config/example.json config.json'],
        notes: 'Run with TZ=UTC',
        envHash: HASH,
      },
      regressionOnly: false,
      evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline: at(7 * DAY_MS) },
      oracle: {
        chainId: 100,
        openingTime: at(7 * DAY_MS + 3_600_000),
        timeoutSeconds: 302_400,
        minBond: '10',
        bondToken: 'xDAI',
        arbitrator: '0x68154ea682f95bf582b80dd6453fa401737491dc',
        arbitratorName: 'Kleros',
        language: 'en_US',
        category: 'misc',
      },
    },
    funding: { chainId: 100 },
  }
}

function edit(patch: (d: ClaimDraft) => void): ClaimDraft {
  const d = structuredClone(baseDraft())
  patch(d)
  return d
}

function errorsOf(d: ClaimDraft, opts: Parameters<typeof toDraftInput>[1] = {}): DraftFieldError[] {
  const r = toDraftInput(d, { now: NOW, ...opts })
  return r.ok ? [] : r.errors
}

describe('toDraftInput', () => {
  it('maps a complete composer draft to the exact strict backend draft body', () => {
    const r = toDraftInput(baseDraft(), { now: NOW })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.input).toEqual({
      repository: { owner: 'kleros', name: 'kleros-v2' },
      commit: COMMIT,
      baseCommit: null,
      membership: { kind: 'pull', number: 2101 },
      policy: { id: 'BOT-001', version: '0.1.0' },
      title: 'Reporter deposits never draw on the gas reserve',
      requirement: 'Reporter-deposit principal must not be funded from arbitration allocations.',
      violation: 'reporter-deposit principal funded from the gas reserve',
      scope: { components: ['src/funding'], outOfScope: ['UI'] },
      allowedInputs: 'any JSON configuration',
      assumptions: ['Gas price below 50 gwei'],
      faultModel: 'process crash between plan and submit',
      regressionOnly: false,
      exclusions: ['Live transfers'],
      policyParameters: { sourceRequirement: 'Spec section 4', startingStates: 'fresh deploy', simulatedAdapters: ['lifi'] },
      environment: {
        runtime: 'node 22.14.0\nPackage manager: pnpm 10.9.2\nContainer image: node@sha256:abc',
        dependencies: `Lockfile: pnpm-lock.yaml (hash ${HASH})\nRun with TZ=UTC`,
        configuration: 'NETWORK=gnosis\nMODE=test',
        externalState: 'none',
        reproduction: { setup: 'pnpm install --frozen-lockfile\ncp config/example.json config.json', command: 'pnpm vitest run test/reporter.spec.ts', notes: '' },
      },
      evidenceWindowSeconds: 7 * 86_400,
      minBondWei: '10000000000000000000',
    })
    // The body passes the strict backend schema (no unknown fields).
    expect(draftInputSchema.safeParse(r.input).success).toBe(true)
    expect(draftInputSchema.safeParse({ ...r.input, salt: '0x' }).success).toBe(false)
  })

  it('is pure: the same draft and clock give the same body', () => {
    expect(toDraftInput(baseDraft(), { now: NOW })).toEqual(toDraftInput(baseDraft(), { now: NOW }))
  })

  it.each([
    ['pull request', (d: ClaimDraft) => d, undefined, { kind: 'pull', number: 2101 }],
    ['source branch', (d: ClaimDraft) => ({ ...d, source: { ...d.source!, pullRequest: undefined, branch: 'release/v2' } }), 'main', { kind: 'branch', name: 'release/v2' }],
    ['default branch from the UI', (d: ClaimDraft) => ({ ...d, source: { ...d.source!, pullRequest: undefined } }), 'main', { kind: 'branch', name: 'main' }],
  ])('membership from the %s', (_name, patch, defaultBranch, expected) => {
    const r = toDraftInput(patch(baseDraft()), { now: NOW, defaultBranch })
    expect(r.ok && r.input.membership).toEqual(expected)
  })

  it('never guesses a branch: no pull request, branch or default branch is an error on the source', () => {
    const errs = errorsOf(edit((d) => (d.source!.pullRequest = undefined)))
    expect(errs).toEqual([expect.objectContaining({ field: 'membership', composerPath: 'source' })])
    expect(errorsOf(edit((d) => (d.source!.pullRequest = undefined)), { defaultBranch: 'feature/../main' })[0]?.field).toBe('membership')
  })

  it('sends the base commit only for regression-only claims (the PR base is not a claim term)', () => {
    const plain = toDraftInput(baseDraft(), { now: NOW })
    expect(plain.ok && plain.input.baseCommit).toBeNull()
    const reg = toDraftInput(edit((d) => (d.spec.regressionOnly = true)), { now: NOW })
    expect(reg.ok && reg.input).toMatchObject({ regressionOnly: true, baseCommit: 'b'.repeat(40) })
    expect(errorsOf(edit((d) => ((d.spec.regressionOnly = true), (d.source!.baseCommit = undefined))))[0]).toMatchObject({ field: 'baseCommit', composerPath: 'source.baseCommit' })
    expect(errorsOf(edit((d) => ((d.spec.regressionOnly = true), (d.source!.baseCommit = { sha: COMMIT, htmlUrl: '' }))))[0]?.message).toMatch(/differ/)
  })

  it.each([
    ['a double quote', 'The "reporter" never pays', /“"” at position 5/],
    ['a backslash', 'Path a\\b is safe', /“\\” at position 7/],
    ['a bracket that could close the question delimiter', 'Safe] Yes = always', /“]” at position 5/],
    ['non-ASCII', 'Réporter deposits', /U\+00E9 at position 2/],
    ['a line break', 'Two\nlines', /U\+000A at position 4/],
  ])('SEC-CLAIM-05 refuses a title with %s, naming the character and its position', (_name, title, message) => {
    const errs = errorsOf(edit((d) => (d.spec.title = title)))
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatchObject({ field: 'title', composerPath: 'spec.title' })
    expect(errs[0]!.message).toMatch(message)
  })

  it('refuses an empty or over-long title', () => {
    expect(errorsOf(edit((d) => (d.spec.title = '   ')))[0]?.field).toBe('title')
    expect(errorsOf(edit((d) => (d.spec.title = 'x'.repeat(121))))[0]?.message).toMatch(/121 characters/)
    expect(toDraftInput(edit((d) => (d.spec.title = 'x'.repeat(120))), { now: NOW }).ok).toBe(true)
  })

  it.each([
    ['right-to-left override', '‮'],
    ['zero-width space', '​'],
    ['the Reality separator', '␟'],
    ['a C1 control', '\u0085'],
    ['a byte order mark', '﻿'],
  ])('SEC-CLAIM-02 refuses %s in free text instead of hashing it', (_name, ch) => {
    const errs = errorsOf(edit((d) => (d.spec.requirement = `Funds are safe${ch} always`)))
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatchObject({ field: 'requirement', composerPath: 'spec.requirement' })
    expect(errs[0]!.message).toMatch(/invisible or control character \(U\+[0-9A-F]{4}\) at position 15/)
  })

  it('NFC-normalizes free text before it is hashed (SEC-CLAIM-02)', () => {
    const r = toDraftInput(edit((d) => (d.spec.requirement = 'Café never charges twice')), { now: NOW })
    expect(r.ok && r.input.requirement).toBe('Café never charges twice')
  })

  it.each([
    ['violation', (d: ClaimDraft) => (d.spec.violation = ''), 'violation', 'spec.violation'],
    ['allowed inputs', (d: ClaimDraft) => (d.spec.allowedInputs = undefined), 'allowedInputs', 'spec.allowedInputs'],
    ['fault model', (d: ClaimDraft) => (d.spec.faultModel = undefined), 'faultModel', 'spec.faultModel'],
    ['in-scope components', (d: ClaimDraft) => (d.spec.scope = { inScope: ['', ' '], outOfScope: [] }), 'scope.components', 'spec.scope.inScope'],
    ['runtime', (d: ClaimDraft) => (d.spec.environment!.runtime = ''), 'environment.runtime', 'spec.environment.runtime'],
    ['external state', (d: ClaimDraft) => (d.spec.environment!.externalState = undefined), 'environment.externalState', 'spec.environment.externalState'],
    ['reproduction command', (d: ClaimDraft) => (d.spec.environment!.reproductionCommand = ' '), 'environment.reproduction.command', 'spec.environment.reproductionCommand'],
    ['dependencies', (d: ClaimDraft) => ((d.spec.environment!.dependencyLock = undefined), (d.spec.environment!.notes = undefined)), 'environment.dependencies', 'spec.environment.dependencyLock'],
    ['policy', (d: ClaimDraft) => (d.spec.policyId = undefined), 'policy', 'spec.policyId'],
    ['commit', (d: ClaimDraft) => (d.source!.commit.sha = 'abc123'), 'commit', 'source.commit'],
  ])('reports a missing %s at its backend field and composer path', (_name, patch, field, composerPath) => {
    const errs = errorsOf(edit(patch))
    expect(errs).toEqual([expect.objectContaining({ field, composerPath })])
  })

  it('renders an empty configuration or setup list as "none" and keeps the lockfile when there are no notes', () => {
    const r = toDraftInput(
      edit((d) => {
        d.spec.environment!.config = {}
        d.spec.environment!.setupSteps = []
        d.spec.environment!.notes = undefined
      }),
      { now: NOW },
    )
    expect(r.ok && r.input.environment).toMatchObject({ configuration: 'none', dependencies: `Lockfile: pnpm-lock.yaml (hash ${HASH})`, reproduction: { setup: 'none' } })
  })

  it('refuses configuration keys that would break the key=value lines', () => {
    expect(errorsOf(edit((d) => (d.spec.environment!.config = { 'A=B': '1' })))[0]).toMatchObject({ field: 'environment.configuration', composerPath: 'spec.environment.config' })
  })

  it.each([
    ['2 days', 2 * DAY_MS, false],
    ['3 days less a second', 3 * DAY_MS - 1_000, false],
    ['exactly 3 days', 3 * DAY_MS, true],
    ['30 days less a minute', 30 * DAY_MS - 60_000, true],
    ['30 days', 30 * DAY_MS, false],
    ['in the past', -DAY_MS, false],
  ])('SEC-CLAIM-07 checks the evidence window: a deadline %s ahead', (_name, ms, ok) => {
    const r = toDraftInput(edit((d) => (d.spec.evidence = { mechanism: 'erc1497-arbitrator-proxy', deadline: at(ms) })), { now: NOW })
    expect(r.ok).toBe(ok)
    if (r.ok) expect(r.input.evidenceWindowSeconds).toBe(Math.floor(ms / 1000))
    else expect(r.errors).toEqual([expect.objectContaining({ field: 'evidenceWindowSeconds', composerPath: 'spec.evidence.deadline' })])
  })

  it.each([
    ['10', '10000000000000000000'],
    ['1', '1000000000000000000'],
    ['100', '100000000000000000000'],
    ['12.5', '12500000000000000000'],
    [undefined, null],
    ['', null],
  ])('converts the minimum bond %s xDAI to exact wei', (minBond, wei) => {
    const r = toDraftInput(edit((d) => (d.spec.oracle!.minBond = minBond as string)), { now: NOW })
    expect(r.ok && r.input.minBondWei).toBe(wei)
  })

  it.each([['0.5'], ['100.000000000000000001'], ['1e1'], ['-5'], ['1.0000000000000000001'], ['ten']])('refuses the minimum bond %s', (minBond) => {
    expect(errorsOf(edit((d) => (d.spec.oracle!.minBond = minBond)))).toEqual([expect.objectContaining({ field: 'minBondWei', composerPath: 'spec.oracle.minBond' })])
  })

  it('refuses policy parameter names outside ^[A-Za-z][A-Za-z0-9_]{0,63}$ and drops emptied optional values', () => {
    expect(errorsOf(edit((d) => (d.spec.parameters = { '1bad': 'x' })))[0]).toMatchObject({ field: 'policyParameters.1bad', composerPath: 'spec.parameters.1bad' })
    const r = toDraftInput(edit((d) => (d.spec.parameters = { keep: 'v', empty: '  ', flag: false })), { now: NOW })
    expect(r.ok && r.input.policyParameters).toEqual({ keep: 'v', flag: false })
  })

  it('refuses a draft composed for another chain', () => {
    expect(errorsOf(edit((d) => (d.funding = { chainId: 1 })))[0]).toMatchObject({ field: 'chainId', composerPath: 'funding.chainId' })
  })

  it('collects every error at once', () => {
    const errs = errorsOf(edit((d) => ((d.spec.title = 'a"b'), (d.spec.violation = ''), (d.spec.oracle!.minBond = '0'))))
    expect(errs.map((e) => e.field).sort()).toEqual(['minBondWei', 'title', 'violation'])
  })
})

describe('composerPathOf', () => {
  it.each([
    [['title'], 'spec.title'],
    [['input', 'title'], 'spec.title'],
    [['scope', 'components', '0'], 'spec.scope.inScope'],
    [['scope', 'outOfScope', 2], 'spec.scope.outOfScope'],
    [['policyParameters', 'startingStates'], 'spec.parameters.startingStates'],
    [['environment', 'reproduction', 'setup'], 'spec.environment.setupSteps'],
    [['environment', 'configuration'], 'spec.environment.config'],
    [['evidenceWindowSeconds'], 'spec.evidence.deadline'],
    [['minBondWei'], 'spec.oracle.minBond'],
    [['membership', 'name'], 'source'],
    [['baseCommit'], 'source.baseCommit'],
  ])('maps backend issue path %j to %s', (path, expected) => {
    expect(composerPathOf(path)).toBe(expected)
  })
})
