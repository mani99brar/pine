/**
 * Composer defaults and pure derivations (no React). `deriveComposer` is what `useClaimComposer`
 * memoizes; it is exported for tests and for server-side previews.
 *
 * Decisions (documented in docs/frontend/integrating-an-app.md):
 * - Evidence deadline defaults to now + 72h, rounded up to the next whole hour (UTC).
 * - Oracle opening time defaults to deadline + 1h and follows the deadline while it is still the default.
 * - Oracle defaults come from core's `defaultOracleParams` (category "misc", chain arbitrator, bond
 *   token, min bond `defaultMinBond`). The timeout is 302 400 s (3.5 days): Seer's official
 *   MarketFactory fixes `questionTimeout` (docs/research/seer-integration.md §1), so it is not
 *   user-editable; `normalizeDraft` enforces it together with the arbitrator and bond token.
 * - Evidence mechanism defaults to `erc1497-arbitrator-proxy` (commit-reveal is a launch gate).
 * - Funding defaults: liquidity "25", initial YES price 0.15, price range [0.02, 0.8], spending limit
 *   from account preferences (fallback "50").
 * - The manifest `claimId` is derived from the draft id (`pine-d…`), and `createdAt` is the draft's
 *   creation time, so the hash shown at review is exactly the hash that gets published.
 */
import {
  buildManifest,
  buildQuestion,
  defaultOracleParams,
  estimateFunding,
  getPolicy,
  pinEnvironment,
  SEER_QUESTION_TIMEOUT_SECONDS,
  validateClaimDraft,
} from '@pine/core'
import type {
  Address,
  ClaimDraft,
  ClaimManifest,
  ClaimQuestion,
  ClaimSpec,
  ComposerStage,
  DecimalString,
  EnvironmentPin,
  FundingInput,
  FundingPlan,
  Hex,
  IsoDate,
  OracleParams,
  PolicyVersion,
} from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { isoNow, randomId } from '../internal/util'
import {
  apiComposerIssues,
  apiEvidenceWindowSeconds,
  apiQuestionSketch,
  apiTimeline,
  isPublishablePolicy,
  type ApiTimeline,
} from './api-rules'

export const DEFAULT_DEADLINE_HOURS = 72
export const DEFAULT_ORACLE_DELAY_HOURS = 1
/** Seer official MarketFactory `questionTimeout` (immutable, all chains) — re-exported from core. */
export { SEER_QUESTION_TIMEOUT_SECONDS }
export const DEFAULT_ORACLE_TIMEOUT_SECONDS = SEER_QUESTION_TIMEOUT_SECONDS
export const DEFAULT_LIQUIDITY: DecimalString = '25'
export const DEFAULT_SPENDING_LIMIT: DecimalString = '50'
export const DEFAULT_INITIAL_YES_PRICE = 0.15
export const DEFAULT_PRICE_RANGE: [number, number] = [0.02, 0.8]
export const VIOLATION_PLACEHOLDER = '[violation not yet specified]'
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

const HOUR_MS = 3_600_000

/** Rounds up to the next whole UTC hour (unchanged if already on the hour). */
export function roundUpToHourUtc(d: Date): Date {
  const t = d.getTime()
  const rounded = Math.ceil(t / HOUR_MS) * HOUR_MS
  return new Date(rounded)
}

export function defaultDeadline(now: Date = new Date()): IsoDate {
  return isoNow(roundUpToHourUtc(new Date(now.getTime() + DEFAULT_DEADLINE_HOURS * HOUR_MS)))
}

export function addHours(iso: IsoDate, hours: number): IsoDate {
  return isoNow(new Date(Date.parse(iso) + hours * HOUR_MS))
}

export function newDraftId(): string {
  return randomId('d')
}

/** Manifest claim id for a draft: stable across edits so the previewed hash equals the published one. */
export function claimIdForDraft(draftId: string): string {
  const slug = draftId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
  return `pine-${slug || 'draft'}`
}

/** Core's chain defaults (fixed Seer timeout, arbitrator, bond token, category) with opening = deadline + 1h. */
export function defaultOracle(chainId: number, deadline: IsoDate): OracleParams {
  return defaultOracleParams(chainId, deadline, { openingTime: addHours(deadline, DEFAULT_ORACLE_DELAY_HOURS) })
}

export function defaultEnvironment(): EnvironmentPin {
  return pinEnvironment({ runtime: '', config: {}, reproductionCommand: '', setupSteps: [] })
}

export function defaultFunding(chainId: number, spendingLimit?: DecimalString): FundingInput {
  return {
    chainId,
    liquidity: DEFAULT_LIQUIDITY,
    spendingLimit: spendingLimit ?? DEFAULT_SPENDING_LIMIT,
    initialYesPrice: DEFAULT_INITIAL_YES_PRICE,
    priceRange: [...DEFAULT_PRICE_RANGE] as [number, number],
    sponsored: false,
  }
}

export interface CreateDraftInput {
  id?: string
  owner: string
  chainId: number
  spendingLimit?: DecimalString
  now?: Date
  /** Evidence deadline (default: now + 72h on the hour; `api` mode passes the backend's default window). */
  deadline?: IsoDate
  partial?: Partial<ClaimDraft>
  normalize?: NormalizeOptions
}

export function createDefaultDraft(input: CreateDraftInput): ClaimDraft {
  const now = input.now ?? new Date()
  const deadline = input.deadline ?? defaultDeadline(now)
  const ts = isoNow(now)
  const base: ClaimDraft = {
    id: input.id ?? newDraftId(),
    owner: input.owner,
    createdAt: ts,
    updatedAt: ts,
    stage: 'source',
    spec: {
      title: '',
      requirement: '',
      violation: '',
      scope: { inScope: [], outOfScope: [] },
      parameters: {},
      assumptions: [],
      exclusions: [],
      environment: defaultEnvironment(),
      regressionOnly: false,
      evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline },
      oracle: defaultOracle(input.chainId, deadline),
    },
    funding: defaultFunding(input.chainId, input.spendingLimit),
  }
  const p = input.partial ?? {}
  return normalizeDraft(
    {
      ...base,
      ...p,
      id: base.id,
      owner: p.owner ?? base.owner,
      spec: { ...base.spec, ...p.spec },
      funding: { ...base.funding, ...p.funding },
    },
    undefined,
    input.normalize,
  )
}

/** Terms are frozen once `create_market` confirmed (spec §10). */
export function isDraftFrozen(draft: ClaimDraft | undefined): boolean {
  return Boolean(draft?.publication?.steps?.some((s) => s.id === 'create_market' && s.status === 'confirmed'))
}

/**
 * Merges a partial patch into a draft. `spec` and `funding` are merged one level deep, so
 * `update({ spec: { title } })` keeps every other spec field. Use the function form for deep edits.
 */
export function mergeDraft(base: ClaimDraft, patch: Partial<ClaimDraft>): ClaimDraft {
  return {
    ...base,
    ...patch,
    spec: patch.spec ? { ...base.spec, ...patch.spec } : base.spec,
    funding: patch.funding ? { ...base.funding, ...patch.funding } : base.funding,
  }
}

export interface NormalizeOptions {
  /**
   * Resolve `policyVersion` from the bundled static catalog when the policy changes (default). `api` mode passes false:
   * the version comes from the backend catalog, which the composer sets explicitly.
   */
  staticPolicies?: boolean
}

/**
 * Keeps derived draft fields consistent after an edit:
 * - environment configHash/envHash recomputed from the pin;
 * - policyVersion follows policyId (latest version) when the policy changes (static catalog only);
 * - oracle opening time follows the deadline while it is still the default offset;
 * - oracle chain fields follow funding.chainId.
 */
export function normalizeDraft(next: ClaimDraft, prev: ClaimDraft | undefined, opts: NormalizeOptions = {}): ClaimDraft {
  const spec: Partial<ClaimSpec> = { ...next.spec }
  const funding: Partial<FundingInput> = { ...next.funding }

  // Policy version follows policy id.
  if (opts.staticPolicies !== false && spec.policyId && (spec.policyId !== prev?.spec.policyId || !spec.policyVersion)) {
    const p = getPolicy(spec.policyId, spec.policyId === prev?.spec.policyId ? spec.policyVersion : undefined)
    if (p) spec.policyVersion = p.version
  }

  // Environment hashes.
  if (spec.environment) {
    const { envHash: _e, configHash: _c, ...rest } = spec.environment
    spec.environment = pinEnvironment({ ...rest, config: rest.config ?? {}, setupSteps: rest.setupSteps ?? [] })
  }

  // Chain sync: oracle follows funding chain.
  const chainId = funding.chainId ?? spec.oracle?.chainId
  if (chainId !== undefined && spec.oracle && spec.oracle.chainId !== chainId) {
    const prevChain = getChainOrDefault(spec.oracle.chainId)
    const keepBond = spec.oracle.minBond !== prevChain.defaultMinBond
    spec.oracle = defaultOracleParams(chainId, spec.evidence?.deadline ?? spec.oracle.openingTime, {
      openingTime: spec.oracle.openingTime,
      ...(keepBond ? { minBond: spec.oracle.minBond } : {}),
      category: spec.oracle.category,
      language: spec.oracle.language,
    })
  }

  // Seer fixes the Reality.eth timeout and the arbitrator; they are not user-editable.
  if (spec.oracle) {
    const chain = getChainOrDefault(spec.oracle.chainId)
    if (
      spec.oracle.timeoutSeconds !== chain.seerQuestionTimeoutSeconds ||
      spec.oracle.arbitrator !== chain.arbitrator ||
      spec.oracle.bondToken !== chain.nativeSymbol
    ) {
      spec.oracle = {
        ...spec.oracle,
        timeoutSeconds: chain.seerQuestionTimeoutSeconds,
        arbitrator: chain.arbitrator,
        arbitratorName: chain.arbitratorName,
        bondToken: chain.nativeSymbol,
      }
    }
  }

  // Oracle opening follows the deadline while it is the default offset (or before the deadline).
  const prevDeadline = prev?.spec.evidence?.deadline
  const deadline = spec.evidence?.deadline
  if (spec.oracle && deadline && prevDeadline && deadline !== prevDeadline) {
    const wasDefault = spec.oracle.openingTime === addHours(prevDeadline, DEFAULT_ORACLE_DELAY_HOURS)
    const beforeDeadline = Date.parse(spec.oracle.openingTime) < Date.parse(deadline)
    if (wasDefault || beforeDeadline) {
      spec.oracle = { ...spec.oracle, openingTime: addHours(deadline, DEFAULT_ORACLE_DELAY_HOURS) }
    }
  }

  return { ...next, spec, funding }
}

/** Fills every ClaimSpec field so the builders can run on a partially written draft (preview). */
export function completeSpec(spec: Partial<ClaimSpec>, chainId: number, now: Date = new Date()): ClaimSpec {
  const deadline = spec.evidence?.deadline ?? defaultDeadline(now)
  const violation = spec.violation && spec.violation.trim() ? spec.violation : VIOLATION_PLACEHOLDER
  return {
    title: spec.title ?? '',
    policyId: spec.policyId ?? '',
    policyVersion: spec.policyVersion ?? '',
    ...(spec.claimClass ? { claimClass: spec.claimClass } : {}),
    requirement: spec.requirement ?? '',
    violation,
    scope: spec.scope ?? { inScope: [], outOfScope: [] },
    parameters: spec.parameters ?? {},
    ...(spec.faultModel ? { faultModel: spec.faultModel } : {}),
    ...(spec.allowedInputs ? { allowedInputs: spec.allowedInputs } : {}),
    assumptions: spec.assumptions ?? [],
    exclusions: spec.exclusions ?? [],
    environment: spec.environment ?? defaultEnvironment(),
    regressionOnly: spec.regressionOnly ?? false,
    evidence: { mechanism: spec.evidence?.mechanism ?? 'erc1497-arbitrator-proxy', deadline },
    oracle: spec.oracle ?? defaultOracle(chainId, deadline),
    ...(spec.specReference ? { specReference: spec.specReference } : {}),
  }
}

export function completeFunding(funding: Partial<FundingInput> | undefined, chainId: number): FundingInput {
  return { ...defaultFunding(chainId), ...funding, chainId: funding?.chainId ?? chainId } as FundingInput
}

export interface ComposerDerived {
  policy?: PolicyVersion
  /** The fully populated spec used for the question/manifest (placeholders for unwritten fields). */
  spec: ClaimSpec
  question?: ClaimQuestion
  manifest?: ClaimManifest
  manifestHash?: Hex
  claimId: string
  validation: ReturnType<typeof validateClaimDraft>
  funding?: FundingPlan
  fundingInput: FundingInput
  frozen: boolean
  /** Stages with blocking issues */
  blockedStages: ComposerStage[]
  /** Hard errors from builders (should not happen; surfaced instead of crashing the composer) */
  buildError?: string
  /** `api` mode only: what the backend will fix at preview, derived for display. */
  api?: ApiDerived
}

/** `api` mode inputs: the backend catalog's policy and the pinned deployment. */
export interface ApiDeriveContext {
  /** The chosen policy from the backend catalog: undefined while loading, null when the catalog does not list it. */
  policy: PolicyVersion | null | undefined
  /** The catalog lookup failed. */
  policyError?: boolean
  /** Pine's EvidenceRegistry, named by the market question. */
  evidenceRegistry?: Address
  /** The chain Pine publishes claims on (the deployment's chain). */
  chainId: number
}

export interface ApiDerived {
  /** True when the chosen policy can be used for new claims on this deployment. */
  policyPublishable: boolean
  /** Deadlines the preview would fix for the chosen evidence deadline. */
  timeline?: ApiTimeline
  /** Seconds from now to the evidence deadline (the window the backend receives). */
  evidenceWindowSeconds: number | null
  /** The market question with the claim document's CID and digest elided; null while it cannot be composed. */
  questionSketch: string | null
}

export function deriveComposer(draft: ClaimDraft, ctx: { creator?: Address; now?: Date; api?: ApiDeriveContext } = {}): ComposerDerived {
  const now = ctx.now ?? new Date()
  const chainId = draft.funding?.chainId ?? draft.spec.oracle?.chainId ?? getChainOrDefault(undefined).id
  if (ctx.api) return deriveApiComposer(draft, ctx.api, now, chainId)
  const policy = draft.spec.policyId ? getPolicy(draft.spec.policyId, draft.spec.policyVersion) : undefined
  const spec = completeSpec(
    { ...draft.spec, policyId: draft.spec.policyId, policyVersion: policy?.version ?? draft.spec.policyVersion },
    chainId,
    now,
  )
  const claimId = draft.publication?.claimId ?? claimIdForDraft(draft.id)
  const fundingInput = completeFunding(draft.funding, chainId)

  let question: ClaimQuestion | undefined
  let manifest: ClaimManifest | undefined
  let manifestHash: Hex | undefined
  let funding: FundingPlan | undefined
  let buildError: string | undefined

  if (policy && draft.source) {
    try {
      question = buildQuestion({ spec, source: draft.source, policy })
      const built = buildManifest({
        claimId,
        creator: ctx.creator ?? ZERO_ADDRESS,
        source: draft.source,
        spec,
        policy,
        createdAt: draft.createdAt,
      })
      manifest = built.manifest
      manifestHash = built.hash
    } catch (e) {
      buildError = e instanceof Error ? e.message : String(e)
    }
  }

  try {
    funding = estimateFunding(fundingInput)
  } catch (e) {
    buildError = buildError ?? (e instanceof Error ? e.message : String(e))
  }

  let validation: ReturnType<typeof validateClaimDraft>
  try {
    validation = validateClaimDraft(draft, now)
  } catch (e) {
    validation = { ok: false, issues: [{ path: '', message: e instanceof Error ? e.message : String(e), stage: 'review' }] }
  }
  const blockedStages = [...new Set(validation.issues.map((i) => i.stage))]

  return {
    policy,
    spec,
    question,
    manifest,
    manifestHash,
    claimId,
    validation,
    funding,
    fundingInput,
    frozen: isDraftFrozen(draft),
    blockedStages,
    buildError,
  }
}

/**
 * `api` mode: the backend composes the claim document and the question at preview, so nothing is built locally. The
 * policy is the backend's, validation is the backend's draft rules, and funding (a separate plan after the claim exists)
 * is left out.
 */
function deriveApiComposer(draft: ClaimDraft, api: ApiDeriveContext, now: Date, chainId: number): ComposerDerived {
  const policy = api.policy ?? undefined
  const spec = completeSpec({ ...draft.spec }, chainId, now)
  const issues = apiComposerIssues(draft, { policy: api.policy, policyError: api.policyError, now, chainId: api.chainId })
  const timeline = apiTimeline(draft.spec.evidence?.deadline)
  const source = draft.source
  const questionSketch = apiQuestionSketch({
    title: draft.spec.title?.trim(),
    repositoryId: source?.repoId,
    commit: source?.commit.sha,
    timeline,
    policySha256: policy?.contentHash,
    evidenceRegistry: api.evidenceRegistry,
  })
  return {
    policy,
    spec,
    claimId: draft.publication?.claimId ?? claimIdForDraft(draft.id),
    validation: { ok: issues.length === 0, issues },
    fundingInput: completeFunding(draft.funding, chainId),
    frozen: isDraftFrozen(draft),
    blockedStages: [...new Set(issues.map((i) => i.stage))],
    api: {
      policyPublishable: isPublishablePolicy(policy),
      timeline,
      evidenceWindowSeconds: apiEvidenceWindowSeconds(draft.spec.evidence?.deadline, now),
      questionSketch,
    },
  }
}

