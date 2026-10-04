/**
 * @pine/react — headless React layer for Pine apps.
 * Every module with hooks/context is marked 'use client'. Never import @pine/server from client code.
 */

// providers
export {
  PineProviders,
  createPineQueryClient,
  createPineWagmiConfig,
  pineViemChains,
  pineWalletList,
  walletConnectProjectId,
  type PineProvidersProps,
} from './providers'
export { PineContext, usePine, isDemoEnv, type PineContextValue } from './providers/context'

// queries
export {
  useClaims,
  useInfiniteClaims,
  useClaim,
  usePriceHistory,
  useDepth,
  useEvidence,
  useActivity,
  usePortfolio,
  usePolicies,
  usePolicy,
  useStats,
  pineKeys,
  LIVE_POLL_MS,
} from './queries'

// wallet
export {
  useWallet,
  useDemoWallet,
  useDemoWalletState,
  demoWalletStore,
  DEMO_STARTING_BALANCE,
  DEMO_STARTING_NATIVE,
  type WalletState,
  type DemoWalletState,
} from './wallet'

// tx runner
export { useTxRunner, __resetTxRunners, getTxMachine, type TxRunner, type UseTxRunnerOptions } from './tx/use-tx-runner'
export {
  TxMachine,
  isManualStep,
  readPersistedRun,
  txStorageKey,
  TX_STORAGE_PREFIX,
  SpendingLimitError,
  type TxRunnerStep,
  type TxRunnerState,
  type TxRunnerSnapshot,
  type TxExecutor,
  type TxLimitCheck,
  type StepHandler,
  type StepOutcome,
  type StepProgress,
  type PendingCheck,
} from './tx/machine'
export { createDemoExecutor, setDemoTxDelays, DEMO_REJECTION_MESSAGE, type DemoExecutorOptions } from './tx/demo-executor'
export { createLiveExecutor, type SerializedReceipt } from './tx/live-executor'

// composer & drafts
export { useDrafts, useDraftOwner, publishRunKey, LOCAL_DRAFT_OWNER } from './composer/drafts'
export { useClaimComposer, useDraftQuery, AUTOSAVE_DEBOUNCE_MS, type ClaimComposer, type DraftPatch } from './composer/use-claim-composer'
export {
  createDefaultDraft,
  deriveComposer,
  normalizeDraft,
  mergeDraft,
  completeSpec,
  completeFunding,
  claimIdForDraft,
  defaultDeadline,
  defaultOracle,
  defaultFunding,
  roundUpToHourUtc,
  isDraftFrozen,
  newDraftId,
  DEFAULT_DEADLINE_HOURS,
  DEFAULT_ORACLE_DELAY_HOURS,
  DEFAULT_ORACLE_TIMEOUT_SECONDS,
  SEER_QUESTION_TIMEOUT_SECONDS,
  DEFAULT_LIQUIDITY,
  DEFAULT_SPENDING_LIMIT,
  DEFAULT_INITIAL_YES_PRICE,
  DEFAULT_PRICE_RANGE,
  VIOLATION_PLACEHOLDER,
  type ComposerDerived,
} from './composer/defaults'

// actions
export { usePublishClaim, type PublishClaim } from './actions/publish'
export { useSubmitEvidence, type SubmitEvidence } from './actions/evidence'
export { useRedeem } from './actions/redeem'
export { buildDemoClaimDetail } from './actions/demo-claim'

// github
export {
  useGitHubViewerRepos,
  useGitHubRepoSearch,
  useGitHubRepo,
  useGitHubPulls,
  useGitHubPull,
  useGitHubPullCommits,
  useGitHubCommits,
  useGitHubCommit,
  useResolveGitHubInput,
  useDebouncedValue,
  toSourceRef,
  type ResolvedGitHubInput,
  type ResolveStatus,
} from './github'

// account
export {
  useAccount,
  useLinkWallet,
  useUpdatePreferences,
  useAccountData,
  SIWE_STATEMENT,
  type PineSessionUser,
  type UseAccountResult,
  type LinkWalletStatus,
} from './account'

// api mode (Pine backend): session, SIWE sign-in, GitHub linking
export {
  usePineSession,
  useSiweSignIn,
  useSignOut,
  useGitHubLink,
  checkSiweChallenge,
  checkGitHubAuthorizationUrl,
  githubConsentUrl,
  pineSessionSchema,
  SiweChallengeError,
  SIWE_TERMS_STATEMENT,
  type PineSession,
  type PineSessionState,
  type SiweStep,
} from './api/session'
export {
  pinnedManifest,
  buildPlanContext,
  verifyWirePlan,
  describePlanStep,
  planToTxSteps,
  planStepId,
  planStepIdOf,
  type RegistryReader,
  type VerifyOptions,
} from './api/plans'
export { useApiPlanRunner, type ApiPlanSpec, type ApiPlanRunner, type ApiPlanPhase, type CreatedPlan } from './api/use-plan-runner'
export * from './api/actions'
export * from './api/identity'

// misc
export { useNow, useCopy, useHotkeys } from './misc'
export { PineApiError } from './internal/api'
