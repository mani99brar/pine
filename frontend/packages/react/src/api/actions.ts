'use client'
// Lane: api write side (publish, evidence, oracle, funding and exit actions over backend plans).
// Re-exported by src/index.ts.

// Claim publication: composer draft → backend draft → verified preview → createClaim plan → status.
export { toDraftInput, composerPathOf, type DraftFieldError, type DraftInputResult, type DraftInputOptions } from './draft-input'
export {
  verifyPreview,
  checkCreateClaimPlan,
  createClaimParamsOf,
  type PreviewIssue,
  type PreviewIssueCode,
  type PreviewExpectations,
  type PreviewTimeline,
  type VerifiedPreview,
} from './verify-preview'
export { useApiPublish, type ApiPublish, type ApiPublishStatus, type UseApiPublishOptions, type BackendDraftRef } from './publish'

// Claim facts from ClaimRegistry on the user's RPC (deadlines, tokens, question), used by every action above.
export { readOnChainClaim, useOnChainClaim, runnerHasSentSteps, type OnChainClaim } from './publish-plan'
