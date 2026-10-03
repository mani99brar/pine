import { z } from 'zod'
import { MAX_TITLE_BYTES, safeText, validateTitle } from '@pine/core/pine-shared'

// Backend draft input (packages/api/src/modules/claims/drafts.ts `draftInputSchema`): the exact, strict body of
// POST /api/v1/drafts and of PUT /api/v1/drafts/:id `{input, expectedRevision}`. Text rules come from the vendored
// @pine/shared (safeText, validateTitle), so whatever passes here passes the backend's own schema.

export const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
export const GITHUB_REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/
export const GIT_BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/
export const POLICY_ID_PATTERN = /^[A-Z]{2,8}-\d{3}$/
export const POLICY_VERSION_PATTERN = /^\d+\.\d+\.\d+$/
/** Keys of `policyParameters` (the claim document's own rule). */
export const POLICY_PARAMETER_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

const XDAI = 10n ** 18n

/**
 * Evidence window the backend accepts (seconds from preview time to the evidence deadline). The API bounds are 3..30 days
 * (ADR D6); the preview rounds the deadline up to the next minute, so the largest window that always passes is 30 days
 * minus 60 s. Operators may configure tighter bounds; the backend then answers with a precise issue.
 */
export const DRAFT_EVIDENCE_WINDOW_SECONDS = { min: 3 * 86_400, max: 30 * 86_400 - 60 } as const
/** Reality minimum bond bounds (native xDAI, wei); `null` means the deployment default (10 xDAI). */
export const DRAFT_MIN_BOND_WEI = { min: 1n * XDAI, max: 100n * XDAI } as const

export const MAX_DRAFT_LIST_ITEMS = 50

const repoName = z
  .string()
  .regex(GITHUB_REPO_NAME_PATTERN, 'invalid repository name')
  .refine((value) => value !== '.' && value !== '..', 'invalid repository name')
const branchName = z
  .string()
  .regex(GIT_BRANCH_PATTERN, 'invalid branch name')
  .refine((value) => !value.split('/').some((part) => part === '' || part === '.' || part === '..'), 'invalid branch name')
const commitSha = z.string().regex(/^[0-9a-f]{40}$/, 'must be a full 40-hex commit id in lowercase')

const titleSchema = z
  .string()
  .max(MAX_TITLE_BYTES)
  .superRefine((value, ctx) => {
    try {
      validateTitle(value)
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message })
    }
  })

export const draftInputSchema = z
  .object({
    repository: z.object({ owner: z.string().regex(GITHUB_OWNER_PATTERN, 'invalid GitHub owner'), name: repoName }).strict(),
    commit: commitSha,
    baseCommit: commitSha.nullable(),
    membership: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('pull'), number: z.number().int().positive().max(2 ** 31 - 1) }).strict(),
      z.object({ kind: z.literal('branch'), name: branchName }).strict(),
    ]),
    policy: z.object({ id: z.string().regex(POLICY_ID_PATTERN), version: z.string().regex(POLICY_VERSION_PATTERN) }).strict(),
    title: titleSchema,
    requirement: safeText(4_000),
    violation: safeText(4_000),
    scope: z.object({ components: z.array(safeText(300)).min(1).max(50), outOfScope: z.array(safeText(300)).max(50) }).strict(),
    allowedInputs: safeText(4_000),
    assumptions: z.array(safeText(1_000)).max(50),
    faultModel: safeText(4_000),
    regressionOnly: z.boolean(),
    exclusions: z.array(safeText(1_000)).max(50),
    policyParameters: z.record(z.string().regex(POLICY_PARAMETER_KEY_PATTERN), z.unknown()),
    environment: z
      .object({
        runtime: safeText(2_000),
        dependencies: safeText(4_000),
        configuration: safeText(8_000),
        externalState: safeText(4_000),
        reproduction: z.object({ setup: safeText(8_000), command: safeText(2_000), notes: safeText(8_000, 0) }).strict(),
      })
      .strict(),
    evidenceWindowSeconds: z.number().int().min(DRAFT_EVIDENCE_WINDOW_SECONDS.min).max(DRAFT_EVIDENCE_WINDOW_SECONDS.max).nullable(),
    minBondWei: z
      .string()
      .regex(/^[1-9][0-9]{0,30}$/, 'must be a positive base-10 integer string')
      .refine((value) => /^[1-9][0-9]{0,30}$/.test(value) && BigInt(value) >= DRAFT_MIN_BOND_WEI.min && BigInt(value) <= DRAFT_MIN_BOND_WEI.max, 'must be between 1 and 100 xDAI')
      .nullable(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.regressionOnly && input.baseCommit === null) ctx.addIssue({ code: 'custom', path: ['baseCommit'], message: 'regression-only claims need a base commit' })
    if (input.baseCommit !== null && input.baseCommit === input.commit) ctx.addIssue({ code: 'custom', path: ['baseCommit'], message: 'base commit must differ from the target commit' })
  })

/** The backend draft input: exactly what POST /api/v1/drafts accepts. */
export type DraftInput = z.output<typeof draftInputSchema>

const issueSchema = z.object({ path: z.array(z.union([z.string(), z.number()])).max(20), message: z.string().max(500) })

/** DraftView (drafts.ts `draftResponse`); `input` is the stored value, possibly from older rules when `valid` is false. */
export const draftViewSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  input: z.unknown(),
  valid: z.boolean(),
  issues: z.array(issueSchema).max(50),
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
})
export type DraftView = z.infer<typeof draftViewSchema>

/** POST /api/v1/drafts (201), GET and PUT /api/v1/drafts/:id. */
export const draftEnvelopeSchema = z.object({ draft: draftViewSchema })
