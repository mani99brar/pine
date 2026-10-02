/**
 * zod 4 schemas and composer validation.
 *
 * Schemas validate shape and local constraints (each exposes zod's `safeParse` → { success, data | error }).
 * `validateClaimDraft` adds cross-field and clock-dependent rules and maps every issue to the composer stage
 * where the user can fix it, with a plain-language message.
 */
import { z } from 'zod'
import { getChain, SUPPORTED_CHAIN_IDS } from './chains'
import { COPY } from './copy'
import { isDecimal, parseDecimalParts, toScaled } from './decimal'
import { isEvidenceMechanismEnabled } from './evidence'
import { estimateFunding } from './funding'
import { getPolicy } from './policies'
import { computeConfigHash, computeEnvHash } from './question'
import type { ClaimDraft, ComposerStage, EnvironmentPin, PolicyVersion } from './types'

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const LIMITS = {
  titleMax: 90,
  requirementMax: 4000,
  violationMin: 10,
  violationMax: 500,
  reproductionCommandMax: 2000,
  listItemMax: 500,
  minDeadlineHours: 24,
  maxDeadlineDays: 180,
  minTimeoutSeconds: 3600,
  maxTimeoutSeconds: 365 * 24 * 3600,
  evidenceTitleMax: 140,
  evidenceSummaryMax: 20000,
} as const

/** Words implying blanket claims; rejected in titles and violation phrases. */
export const BLANKET_CLAIM_PATTERN = /\b(safe|secure|bug[\s-]?free|no bugs?|certified|audited|vulnerability[\s-]?free|exploit[\s-]?free)\b/i

const SECRET_KEY_PATTERN = /(secret|private[_-]?key|passw(or)?d|mnemonic|seed[_-]?phrase|api[_-]?key|access[_-]?token|auth[_-]?token|bearer)/i

// ---------------------------------------------------------------------------
// Primitive schemas
// ---------------------------------------------------------------------------

export const hash32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Expected a 32-byte 0x-prefixed hex hash.')
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Expected a 0x-prefixed 20-byte address.')
export const commitShaSchema = z.string().regex(/^[0-9a-fA-F]{40}$/, 'Expected a full 40-character commit SHA.')

const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/
export function isUtcIso(value: unknown): value is string {
  return typeof value === 'string' && UTC_RE.test(value) && !Number.isNaN(new Date(value).getTime())
}
export const utcIsoSchema = z
  .string()
  .refine(isUtcIso, 'Use an absolute UTC timestamp ending in Z, e.g. 2026-10-10T18:00:00Z.')

/** Canonical stored decimal: digits with an optional fractional part (no sign, exponent or separators). */
export const PLAIN_DECIMAL_RE = /^\d+(\.\d+)?$/

export function isPlainDecimal(v: unknown): v is string {
  return typeof v === 'string' && PLAIN_DECIMAL_RE.test(v)
}

const SCI_MESSAGE = 'Write amounts as plain decimals (for example 0.0000001), not scientific notation.'

export const positiveDecimalSchema = z
  .string()
  .refine((v) => isDecimal(v), 'Enter a plain decimal amount, e.g. 5 or 0.1.')
  .refine((v) => !isDecimal(v) || isPlainDecimal(v.trim()), SCI_MESSAGE)
  .refine((v) => (toScaled(v, 18)?.value ?? 0n) > 0n, 'Must be greater than zero.')
  .refine((v) => toScaled(v, 18)?.exact !== false, 'Use at most 18 decimal places.')

// ---------------------------------------------------------------------------
// Domain schemas
// ---------------------------------------------------------------------------

export const sourceRefSchema = z.object({
  provider: z.literal('github'),
  owner: z.string().min(1, 'Owner is required.'),
  repo: z.string().min(1, 'Repository is required.'),
  repoId: z.number().int().optional(),
  pullRequest: z
    .object({
      number: z.number().int().positive(),
      title: z.string(),
      htmlUrl: z.string(),
      author: z.string(),
      state: z.enum(['open', 'closed', 'merged']),
    })
    .optional(),
  commit: z.object({
    sha: commitShaSchema,
    message: z.string(),
    author: z.string(),
    committedAt: z.string(),
    htmlUrl: z.string(),
  }),
  baseCommit: z.object({ sha: commitShaSchema, htmlUrl: z.string() }).optional(),
  license: z.string().nullable().optional(),
})

export const environmentPinSchema = z.object({
  runtime: z.string().trim().min(1, 'Pin the runtime, e.g. "node 22.14.0".'),
  packageManager: z.string().optional(),
  dependencyLock: z.object({ path: z.string().min(1), hash: hash32Schema }).optional(),
  config: z.record(z.string(), z.string()),
  configHash: hash32Schema,
  containerImage: z.string().optional(),
  externalState: z.string().optional(),
  reproductionCommand: z
    .string()
    .trim()
    .min(1, 'Add the reproduction command investigators run.')
    .max(LIMITS.reproductionCommandMax),
  setupSteps: z.array(z.string().max(LIMITS.listItemMax)),
  notes: z.string().optional(),
  envHash: hash32Schema,
})

export const oracleParamsSchema = z.object({
  chainId: z.number().int().positive(),
  openingTime: utcIsoSchema,
  timeoutSeconds: z
    .number()
    .int()
    .min(LIMITS.minTimeoutSeconds, 'Answer timeout must be at least 1 hour (3600 seconds).')
    .max(LIMITS.maxTimeoutSeconds, 'Answer timeout must be at most 365 days.'),
  minBond: positiveDecimalSchema,
  bondToken: z.string().min(1),
  arbitrator: addressSchema,
  arbitratorName: z.string().min(1),
  language: z.string().min(2),
  category: z.string().min(1),
})

const paramValueSchema = z.union([z.string(), z.array(z.string()), z.boolean()])

export const claimSpecSchema = z.object({
  title: z.string().trim().min(1, 'Give the claim a short title.').max(LIMITS.titleMax, `Keep the title to ${LIMITS.titleMax} characters.`),
  policyId: z.string().min(1, 'Choose a policy.'),
  policyVersion: z.string().min(1, 'Choose a policy version.'),
  claimClass: z.string().optional(),
  requirement: z
    .string()
    .trim()
    .min(1, 'State the one exact requirement or invariant.')
    .max(LIMITS.requirementMax, `Keep the requirement under ${LIMITS.requirementMax} characters.`),
  violation: z
    .string()
    .trim()
    .min(LIMITS.violationMin, 'Describe the specific violation a counterexample must demonstrate.')
    .max(LIMITS.violationMax, `Keep the violation phrase under ${LIMITS.violationMax} characters; it goes into the market question.`),
  scope: z.object({
    inScope: z.array(z.string().max(LIMITS.listItemMax)).min(1, 'List at least one in-scope component.'),
    outOfScope: z.array(z.string().max(LIMITS.listItemMax)),
  }),
  parameters: z.record(z.string(), paramValueSchema),
  faultModel: z.string().optional(),
  allowedInputs: z.string().optional(),
  assumptions: z.array(z.string().max(LIMITS.listItemMax)),
  exclusions: z.array(z.string().max(LIMITS.listItemMax)),
  environment: environmentPinSchema,
  regressionOnly: z.boolean(),
  evidence: z.object({
    mechanism: z.enum(['erc1497-arbitrator-proxy', 'commit-reveal']),
    deadline: utcIsoSchema,
  }),
  oracle: oracleParamsSchema,
  specReference: z.object({ label: z.string(), url: z.string(), hash: hash32Schema.optional() }).optional(),
})

export const fundingInputSchema = z
  .object({
    chainId: z.number().int().positive(),
    liquidity: positiveDecimalSchema,
    spendingLimit: positiveDecimalSchema,
    initialYesPrice: z.number().gt(0, 'Initial Yes price must be above 0.').lt(1, 'Initial Yes price must be below 1.'),
    priceRange: z.tuple([z.number().gt(0).lt(1), z.number().gt(0).lt(1)]),
    sponsored: z.boolean().optional(),
  })
  .refine((f) => f.priceRange[0] < f.priceRange[1], { message: 'The low end of the price range must be below the high end.', path: ['priceRange'] })
  .refine((f) => f.initialYesPrice >= f.priceRange[0] && f.initialYesPrice <= f.priceRange[1], {
    message: 'The initial Yes price must be inside the price range.',
    path: ['initialYesPrice'],
  })

export const evidenceDraftSchema = z
  .object({
    claimId: z.string().min(1),
    kind: z.enum(['counterexample', 'rebuttal', 'clarification', 'commitment']),
    title: z.string().trim().min(1, 'Give the evidence a title.').max(LIMITS.evidenceTitleMax),
    summary: z.string().trim().min(1, 'Summarize what the evidence shows.').max(LIMITS.evidenceSummaryMax),
    reproduction: z
      .object({
        command: z.string().trim().min(1, 'Add the reproduction command.'),
        environment: z.string().trim().min(1, 'Describe the environment used.'),
        expected: z.string().trim().min(1, 'State the expected behavior.'),
        actual: z.string().trim().min(1, 'State the actual behavior.'),
        steps: z.array(z.string()).optional(),
      })
      .optional(),
    attachments: z.array(
      z.object({ name: z.string().min(1), mime: z.string().min(1), size: z.number().int().nonnegative() }),
    ),
    mode: z.enum(['direct', 'commit']),
  })
  .refine((e) => e.kind !== 'counterexample' || e.mode === 'commit' || !!e.reproduction, {
    message: 'A counterexample needs a reproduction: command, environment, expected and actual behavior.',
    path: ['reproduction'],
  })

// ---------------------------------------------------------------------------
// Draft validation
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  path: string
  message: string
  stage: ComposerStage
}

const CLAIM_FIELDS = new Set([
  'title',
  'requirement',
  'violation',
  'scope',
  'faultModel',
  'allowedInputs',
  'assumptions',
  'exclusions',
  'environment',
  'regressionOnly',
  'specReference',
  'claimClass',
  'parameters',
])

/** Composer stage for an issue path such as "spec.evidence.deadline". */
export function stageForPath(path: string): ComposerStage {
  const [root, field] = path.split('.')
  if (root === 'source') return 'source'
  if (root === 'funding') return 'funding'
  if (root === 'spec') {
    if (field === 'policyId' || field === 'policyVersion') return 'policy'
    if (field === 'evidence' || field === 'oracle') return 'deadlines'
    if (field && CLAIM_FIELDS.has(field)) return 'claim'
  }
  return 'review'
}

function pathOf(prefix: string, p: readonly PropertyKey[]): string {
  return [prefix, ...p.map((k) => String(k))].filter(Boolean).join('.')
}

function isEmptyParam(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim() !== '').length === 0
  return false
}

const HOUR = 3600_000
const DAY = 24 * HOUR

/**
 * Validate a composer draft. Never throws. Rules (beyond the schemas):
 * - full 40-hex commit; regression-only requires a base commit (different from the commit);
 * - policy exists and is enabled (SC-001 is gated: COPY.scGate); required policy parameters present;
 * - violation/title free of blanket-claim words; config free of secret-looking keys; hashes consistent;
 * - evidence deadline absolute UTC (Z), whole minute, ≥ now + 24h, ≤ now + 180d;
 * - oracle opening ≥ evidence deadline, timeout ≥ 3600s and equal to the chain's fixed Seer factory timeout
 *   (302400s), arbitrator/bond token match the chain, min bond > 0, same chain as funding;
 * - funding: liquidity > 0, limit > 0, estimated max spend ≤ spending limit.
 */
export function validateClaimDraft(
  draft: ClaimDraft,
  now: Date = new Date(),
): { ok: boolean; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = []
  const seen = new Set<string>()
  const add = (path: string, message: string, stage?: ComposerStage) => {
    const key = `${path}|${message}`
    if (seen.has(key)) return
    seen.add(key)
    issues.push({ path, message, stage: stage ?? stageForPath(path) })
  }

  const spec = (draft?.spec ?? {}) as Partial<ClaimDraft['spec']>
  const source = draft?.source

  // --- source --------------------------------------------------------------
  if (!source) {
    add('source', 'Select a repository and the exact commit to pin.')
  } else {
    const r = sourceRefSchema.safeParse(source)
    if (!r.success) {
      for (const i of r.error.issues) {
        const path = pathOf('source', i.path)
        const msg =
          path === 'source.commit.sha'
            ? 'Pin a full 40-character commit SHA. Short SHAs must be resolved through GitHub first.'
            : path === 'source.baseCommit.sha'
              ? 'The base commit must be a full 40-character SHA.'
              : i.message
        add(path, msg)
      }
    }
    if (spec.regressionOnly && !source.baseCommit) {
      add('source.baseCommit', 'Regression-only claims need a pinned base commit to compare against.')
    }
    if (source.baseCommit && source.baseCommit.sha?.toLowerCase() === source.commit?.sha?.toLowerCase()) {
      add('source.baseCommit', 'The base commit must differ from the selected commit.')
    }
  }

  // --- policy --------------------------------------------------------------
  let policy: PolicyVersion | undefined
  if (!spec.policyId) {
    add('spec.policyId', 'Choose a policy.')
  } else {
    policy = getPolicy(spec.policyId, spec.policyVersion)
    if (!policy) {
      add('spec.policyId', `Unknown policy ${spec.policyId}${spec.policyVersion ? `@${spec.policyVersion}` : ''}.`)
    } else if (policy.status === 'gated') {
      add('spec.policyId', COPY.scGate)
    } else if (policy.status !== 'enabled') {
      add('spec.policyId', `${policy.id}@${policy.version} is ${policy.status} and cannot be used for new claims.`)
    }
    if (policy && !spec.policyVersion) add('spec.policyVersion', 'Choose a policy version.')
  }

  // --- claim (schema) ------------------------------------------------------
  const specResult = claimSpecSchema.safeParse(spec)
  if (!specResult.success) {
    for (const i of specResult.error.issues) {
      const path = pathOf('spec', i.path)
      if (path === 'spec.policyId' || path === 'spec.policyVersion') continue // handled above
      if (path === 'spec.environment.configHash' || path === 'spec.environment.envHash') {
        add('spec.environment', 'Re-pin the environment so its configuration and environment hashes are computed.')
        continue
      }
      if (
        path.startsWith('spec.evidence.deadline') ||
        path.startsWith('spec.oracle.openingTime') ||
        path.startsWith('spec.oracle.minBond') ||
        path.startsWith('spec.oracle.timeoutSeconds')
      ) {
        continue // rich checks below
      }
      add(path, i.message)
    }
  }

  // --- claim (rules) -------------------------------------------------------
  for (const field of ['title', 'violation'] as const) {
    const value = spec[field]
    if (typeof value === 'string') {
      const m = BLANKET_CLAIM_PATTERN.exec(value)
      if (m) {
        add(
          `spec.${field}`,
          `"${m[0]}" implies a blanket claim about the code. Pine claims are bounded: describe the one specific violation a counterexample must demonstrate (for example "an unauthenticated caller can read another user's file through GET /files/:id"). ${COPY.noIsNotSafety}`,
        )
      }
    }
  }
  if (typeof spec.violation === 'string' && /[␟\u0000-\u001f]/.test(spec.violation)) {
    add('spec.violation', 'The violation phrase cannot contain line breaks or control characters; it is inserted into the market question.')
  }

  if (policy) {
    if (spec.claimClass && !policy.claimClasses.some((c) => c.id === spec.claimClass)) {
      add('spec.claimClass', `"${spec.claimClass}" is not a claim class of ${policy.id}.`)
    }
    const params = spec.parameters ?? {}
    for (const p of policy.parameters) {
      if (!p.required) continue
      const v = (params as Record<string, unknown>)[p.key]
      if (p.kind === 'boolean') {
        if (typeof v !== 'boolean') add(`spec.parameters.${p.key}`, `Answer "${p.label}".`)
      } else if (isEmptyParam(v)) {
        add(`spec.parameters.${p.key}`, `${p.label} is required by ${policy.id}.`)
      } else if (p.maxLength && typeof v === 'string' && v.length > p.maxLength) {
        add(`spec.parameters.${p.key}`, `${p.label} must be at most ${p.maxLength} characters.`)
      }
    }
    if (policy.id === 'FUNC-001' && params.violationScope === 'regression' && spec.regressionOnly !== true) {
      add('spec.regressionOnly', 'The policy parameters say only regressions qualify; turn on regression-only and pin a base commit.')
    }
  }

  const env = spec.environment as EnvironmentPin | undefined
  if (env && typeof env === 'object') {
    const config = env.config ?? {}
    for (const key of Object.keys(config)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        add(
          `spec.environment.config.${key}`,
          `"${key}" looks like a secret. Never pin secrets: the configuration is published with the claim. Use a placeholder and describe how to supply it.`,
        )
      }
    }
    try {
      if (env.configHash && env.configHash !== computeConfigHash(config)) {
        add('spec.environment', 'The configuration changed after it was pinned. Re-pin the environment to update its hashes.')
      } else if (env.envHash && env.envHash !== computeEnvHash(env)) {
        add('spec.environment', 'The environment changed after it was pinned. Re-pin the environment to update its hash.')
      }
    } catch {
      add('spec.environment', 'The environment contains values that cannot be hashed.')
    }
  }

  // --- deadlines & oracle --------------------------------------------------
  const evidence = spec.evidence
  let deadlineMs: number | undefined
  if (!evidence?.deadline) {
    add('spec.evidence.deadline', 'Set an evidence deadline (absolute UTC).')
  } else if (!isUtcIso(evidence.deadline)) {
    add(
      'spec.evidence.deadline',
      'Use an absolute UTC timestamp ending in Z, e.g. 2026-10-10T18:00:00Z. Local times are ambiguous for investigators in other time zones.',
    )
  } else {
    const d = new Date(evidence.deadline)
    deadlineMs = d.getTime()
    if (d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0) {
      add('spec.evidence.deadline', 'Use a whole minute (seconds = 00): the market question states the deadline to the minute.')
    }
    if (deadlineMs <= now.getTime()) {
      add('spec.evidence.deadline', 'The evidence deadline is in the past.')
    } else if (deadlineMs < now.getTime() + LIMITS.minDeadlineHours * HOUR) {
      add('spec.evidence.deadline', `The evidence deadline must be at least ${LIMITS.minDeadlineHours} hours from now so investigators have time to work.`)
    } else if (deadlineMs > now.getTime() + LIMITS.maxDeadlineDays * DAY) {
      add('spec.evidence.deadline', `The evidence deadline must be within ${LIMITS.maxDeadlineDays} days.`)
    }
  }
  if (evidence?.mechanism && !isEvidenceMechanismEnabled(evidence.mechanism)) {
    add('spec.evidence.mechanism', 'Commit–reveal evidence is not enabled yet (launch gate SPEC §10.5). Use on-chain ERC-1497 evidence.')
  } else if (!evidence?.mechanism) {
    add('spec.evidence.mechanism', 'Choose how evidence is submitted.')
  }

  const oracle = spec.oracle
  if (!oracle) {
    add('spec.oracle', 'Set the oracle parameters (opening time, timeout and minimum bond).')
  } else {
    if (!oracle.openingTime) {
      add('spec.oracle.openingTime', 'Set when the oracle opens for answers (absolute UTC).')
    } else if (!isUtcIso(oracle.openingTime)) {
      add('spec.oracle.openingTime', 'Use an absolute UTC timestamp ending in Z for the oracle opening time.')
    } else if (deadlineMs !== undefined && new Date(oracle.openingTime).getTime() < deadlineMs) {
      add('spec.oracle.openingTime', 'The oracle must not open before the evidence deadline; answers would be posted while evidence can still arrive.')
    }
    if (oracle.minBond === undefined || oracle.minBond === '') {
      add('spec.oracle.minBond', 'Set the minimum bond for the first answer.')
    } else if (!(parseDecimalParts(oracle.minBond) && (toScaled(oracle.minBond, 18)?.value ?? 0n) > 0n)) {
      add('spec.oracle.minBond', 'The minimum bond must be greater than zero.')
    } else if (!isPlainDecimal(oracle.minBond)) {
      add('spec.oracle.minBond', SCI_MESSAGE)
    }
    const oracleChain = oracle.chainId !== undefined ? getChain(oracle.chainId) : undefined
    if (oracle.chainId !== undefined && !SUPPORTED_CHAIN_IDS.includes(oracle.chainId)) {
      add('spec.oracle.chainId', `Chain ${oracle.chainId} is not supported.`)
    }
    if (typeof oracle.timeoutSeconds !== 'number' || !Number.isInteger(oracle.timeoutSeconds)) {
      add('spec.oracle.timeoutSeconds', 'Set the answer timeout in whole seconds.')
    } else if (oracle.timeoutSeconds < LIMITS.minTimeoutSeconds) {
      add('spec.oracle.timeoutSeconds', 'Answer timeout must be at least 1 hour (3600 seconds).')
    }
    if (oracleChain && SUPPORTED_CHAIN_IDS.includes(oracleChain.id)) {
      if (typeof oracle.timeoutSeconds === 'number' && oracle.timeoutSeconds >= LIMITS.minTimeoutSeconds && oracle.timeoutSeconds !== oracleChain.seerQuestionTimeoutSeconds) {
        add(
          'spec.oracle.timeoutSeconds',
          `Seer's official market factory on ${oracleChain.name} fixes the answer timeout at ${oracleChain.seerQuestionTimeoutSeconds} seconds (${oracleChain.seerQuestionTimeoutSeconds / 86400} days). Use that value.`,
        )
      }
      if (oracle.arbitrator && oracle.arbitrator.toLowerCase() !== oracleChain.arbitrator.toLowerCase()) {
        add('spec.oracle.arbitrator', `The arbitrator is fixed by Seer's factory on ${oracleChain.name}: ${oracleChain.arbitrator}.`)
      }
      if (oracle.bondToken && oracle.bondToken !== oracleChain.nativeSymbol) {
        add('spec.oracle.bondToken', `Reality.eth bonds on ${oracleChain.name} are paid in ${oracleChain.nativeSymbol}.`)
      }
    }
    if (draft?.funding?.chainId !== undefined && oracle.chainId !== undefined && draft.funding.chainId !== oracle.chainId) {
      add('funding.chainId', 'The market must be funded on the same chain as its oracle.')
    }
  }

  // --- funding -------------------------------------------------------------
  const funding = draft?.funding
  if (!funding) {
    add('funding', 'Set the liquidity and your spending limit.')
  } else {
    const liq = funding.liquidity
    if (liq === undefined || liq === null || String(liq).trim() === '') {
      add('funding.liquidity', 'Enter how much collateral to deposit as liquidity.')
    } else if (!isDecimal(liq)) {
      add('funding.liquidity', 'Enter a plain decimal amount, e.g. 5 or 0.1.')
    } else if (!isPlainDecimal(String(liq).trim())) {
      add('funding.liquidity', SCI_MESSAGE)
    } else if ((toScaled(liq, 18)?.value ?? 0n) <= 0n) {
      add('funding.liquidity', 'Liquidity must be greater than zero.')
    } else if (toScaled(liq, 18)?.exact === false) {
      add('funding.liquidity', 'Use at most 18 decimal places.')
    }
    const lim = funding.spendingLimit
    if (lim === undefined || lim === null || String(lim).trim() === '') {
      add('funding.spendingLimit', 'Set a spending limit.')
    } else if (!isDecimal(lim) || (toScaled(lim, 18)?.value ?? 0n) <= 0n) {
      add('funding.spendingLimit', 'The spending limit must be a decimal amount greater than zero.')
    } else if (!isPlainDecimal(String(lim).trim())) {
      add('funding.spendingLimit', SCI_MESSAGE)
    }
    if (funding.chainId === undefined) add('funding.chainId', 'Choose a chain.')
    else if (!SUPPORTED_CHAIN_IDS.includes(funding.chainId)) add('funding.chainId', `Chain ${funding.chainId} is not supported.`)

    const full = fundingInputSchema.safeParse(funding)
    if (!full.success) {
      for (const i of full.error.issues) {
        const path = pathOf('funding', i.path)
        if (path === 'funding.liquidity' || path === 'funding.spendingLimit' || path === 'funding.chainId') continue
        add(path.startsWith('funding.priceRange') ? 'funding.priceRange' : path, path.startsWith('funding.priceRange') ? 'Price range must satisfy 0 < low < high < 1.' : i.message)
      }
    } else {
      const plan = estimateFunding(full.data)
      if (!plan.withinLimit) {
        add(
          'funding.spendingLimit',
          `Estimated maximum spend (${plan.totals.maxSpend} ${plan.collateral.symbol}) exceeds your spending limit (${full.data.spendingLimit} ${plan.collateral.symbol}). Lower the liquidity or raise the limit.`,
        )
      }
    }
  }

  return { ok: issues.length === 0, issues }
}
