'use client'
// Lane: api write side (publish, evidence, oracle, funding and exit actions over backend plans).
// Re-exported by src/index.ts.

// Claim publication: composer draft → backend draft → verified preview → createClaim plan → status.
export {
  toDraftInput,
  toDraftTerms,
  chosenEvidenceDeadline,
  composerPathOf,
  type DraftFieldError,
  type DraftInputResult,
  type DraftInputOptions,
  type DraftTerms,
  type DraftTermsResult,
} from './draft-input'
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

// Evidence: direct publication, or sealed commit and reveal (the salt never leaves this browser before the reveal).
export {
  useApiEvidence,
  prepareEvidence,
  checkCommitPlan,
  checkPublishEvidencePlan,
  checkRevealTemplate,
  buildRevealWire,
  findCommittedSubmission,
  newEvidenceSalt,
  readSeal,
  listSeals,
  sealStorageKey,
  mediaTypeOf,
  type ApiEvidence,
  type EvidenceActionKind,
  type EvidenceArtifactInput,
  type EvidenceComposition,
  type EvidenceContext,
  type EvidenceFieldError,
  type EvidenceSeal,
  type PreparedEvidence,
  type SealedEvidenceView,
  type UseApiEvidenceOptions,
} from './evidence'

// Oracle actions (answers with an explicit bond, bounties, resolution, reopen, Kleros relays, winnings, withdraw).
export {
  useApiOracle,
  checkOraclePlan,
  minimumBondOf,
  reopenedQuestionIdsOf,
  ORACLE_MAX_VALUE_WEI,
  type ApiOracle,
  type OracleActionBody,
  type OraclePlanCheck,
  type UseApiOracleOptions,
} from './oracle'

// Funding (YES ladder with its risk acknowledgement) and exits (withdraw, merge, redeem).
export {
  useApiFunding,
  checkLadderPlan,
  FUNDING_MAX_VALUE_WEI,
  FUNDING_MAX_APPROVAL,
  type ApiFunding,
  type FundingFlowOptions,
  type LadderQuote,
  type LadderRequest,
} from './funding'
export { useApiExits, checkExitPlan, type ApiExits, type ExitKind, type ExitPlanCheck } from './exits'

// Claim facts from ClaimRegistry on the user's RPC (deadlines, tokens, question), used by every action above.
export { readOnChainClaim, useOnChainClaim, runnerHasSentSteps, type OnChainClaim } from './publish-plan'
