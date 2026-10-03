import { z } from 'zod'
import type { PineApiIssue } from './http'

// Funding lane answers (packages/api/src/modules/funding/store.ts `PlanView`): ladder, withdraw, merge and redeem plans
// are always 200 and carry ISO `expiresAt` (unlike markets plans). The ladder needs a two-step risk acknowledgement whose
// computed figures come back as the `issues` of a 409 CONFLICT (ladder.ts `assertRiskAcknowledged`).

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const iso = z.string().max(40)

export const FUNDING_PLAN_KINDS = ['ladder', 'withdraw', 'merge', 'redeem'] as const
export type FundingPlanKind = (typeof FUNDING_PLAN_KINDS)[number]

export const fundingPlanViewSchema = z.object({
  planId: z.uuid(),
  kind: z.enum(FUNDING_PLAN_KINDS),
  market: address,
  account: address,
  state: z.enum(['planned', 'submitted', 'confirmed', 'failed', 'expired']),
  createdAt: iso,
  /** Offer expiry as an ISO timestamp. */
  expiresAt: iso,
  /** WireTxPlan: decoded and verified by the client, never trusted. */
  plan: z.unknown(),
  /** Route-specific public figures (decimal strings). Display only. */
  details: z.record(z.string(), z.unknown()),
  steps: z
    .array(
      z.object({
        id: z.string().max(64),
        state: z.enum(['pending', 'confirmed']),
        txHashes: z.array(hex32).max(8),
        confirmedTxHash: hex32.nullable(),
        revertReason: z.string().max(500).nullable(),
      }),
    )
    .max(16),
  /** How to recover funds from a partly executed plan (failed state). Platform-authored text. */
  recovery: z.string().max(1_000).nullable(),
})
export type FundingPlanView = z.infer<typeof fundingPlanViewSchema>

/** The figures the backend computed for a ladder (SEC-LEGAL-03); amounts in base units, prices as decimals. */
export interface LadderRiskFigures {
  /** Maximum loss if YES resolves, in sDAI share base units: the value the user acknowledges. */
  maxLossIfYesShares: string
  maxLossIfYesXdaiWei: string
  budgetWei: string
  sets: string
  finalLowerPrice: string
  finalUpperPrice: string
}

const UINT = /^(?:0|[1-9][0-9]{0,77})$/
const PRICE = /^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,18})?$/
const FIGURES: Record<keyof LadderRiskFigures, RegExp> = {
  maxLossIfYesShares: UINT,
  maxLossIfYesXdaiWei: UINT,
  budgetWei: UINT,
  sets: UINT,
  finalLowerPrice: PRICE,
  finalUpperPrice: PRICE,
}

/**
 * Reads the ladder figures from a 409 refusal: issues at `["riskAcknowledgement", "computed", <name>]` whose message is
 * the value. Returns null unless every figure is present and well formed (the body is untrusted).
 */
export function ladderFiguresFromIssues(issues: readonly PineApiIssue[] | undefined): LadderRiskFigures | null {
  const found: Partial<LadderRiskFigures> = {}
  for (const issue of issues ?? []) {
    const [first, second, name] = issue.path
    if (first !== 'riskAcknowledgement' || second !== 'computed' || typeof name !== 'string' || !(name in FIGURES)) continue
    const key = name as keyof LadderRiskFigures
    if (FIGURES[key].test(issue.message)) found[key] = issue.message
  }
  const keys = Object.keys(FIGURES) as (keyof LadderRiskFigures)[]
  return keys.every((key) => found[key] !== undefined) ? (found as LadderRiskFigures) : null
}
