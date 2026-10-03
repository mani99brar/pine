/**
 * Pine domain contract.
 *
 * This file is the shared contract between @pine/core, @pine/data, @pine/react,
 * @pine/server and the three apps. Additive changes are fine; renaming or
 * removing fields breaks every consumer — don't.
 *
 * Conventions:
 * - Timestamps are ISO-8601 UTC strings (`2026-10-10T18:00:00Z`) unless named `*Ts` (unix seconds).
 * - Token/collateral amounts are decimal strings in human units (e.g. "12.5" sDAI),
 *   never floats, never wei, unless the field name ends in `Wei` (bigint-as-string).
 * - Prices are numbers in [0, 1] denominated in collateral per outcome token.
 */

export type Hex = `0x${string}`
export type Address = Hex
export type ChainId = number
export type IsoDate = string
export type DecimalString = string

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export type PolicyFamilyId = 'FUNC' | 'BOT' | 'SC'

export interface PolicyFamily {
  id: PolicyFamilyId
  name: string // "Functional correctness"
  tagline: string
  description: string
}

export type PolicyParameterKind =
  | 'text'
  | 'longtext'
  | 'select'
  | 'multiselect'
  | 'list' // list of strings
  | 'boolean'
  | 'address'
  | 'hash'
  | 'url'

export interface PolicyParameterSpec {
  key: string
  label: string
  help: string
  kind: PolicyParameterKind
  required: boolean
  options?: { value: string; label: string; help?: string }[]
  placeholder?: string
  example?: string | string[] | boolean
  maxLength?: number
}

export type PolicyStatus = 'enabled' | 'gated' | 'draft' | 'retired'

export interface PolicyVersion {
  id: string // "BOT-001"
  family: PolicyFamilyId
  version: string // "0.1.0"
  title: string // "Automation and Keeper Reliability"
  summary: string
  status: PolicyStatus
  gateReason?: string
  /** keccak256 of the canonical policy text (UTF-8) */
  contentHash: Hex
  /** Durable retrieval location, e.g. ipfs://… */
  uri: string
  /** Full policy text, Markdown */
  text: string
  intendedUse: string[]
  examples: string[]
  /** Suggested claim classes inside the family (e.g. BOT-001 candidate claims) */
  claimClasses: { id: string; label: string; description: string }[]
  parameters: PolicyParameterSpec[]
  evidenceRequirements: string[]
  exclusions: string[]
  outcomeRules: { yes: string; no: string; invalid: string }
  publishedAt: IsoDate
  supersedes?: string // previous version
}

// ---------------------------------------------------------------------------
// Source (GitHub)
// ---------------------------------------------------------------------------

export interface GitHubUser {
  login: string
  id: number
  name?: string | null
  avatarUrl: string
  htmlUrl: string
}

export interface RepoSummary {
  id: number
  owner: string
  name: string
  fullName: string // owner/name
  description: string | null
  private: boolean
  defaultBranch: string
  language: string | null
  stars: number
  forks?: number
  openPullRequests?: number
  license: string | null
  htmlUrl: string
  updatedAt: IsoDate
  topics?: string[]
}

export type PullState = 'open' | 'closed' | 'merged'

export interface PullSummary {
  number: number
  title: string
  state: PullState
  draft: boolean
  author: GitHubUser
  htmlUrl: string
  headSha: string
  headRef: string
  baseSha: string
  baseRef: string
  createdAt: IsoDate
  updatedAt: IsoDate
  commits: number
  additions: number
  deletions: number
  changedFiles: number
  labels: string[]
  body?: string | null
}

export interface CommitSummary {
  sha: string // 40-hex
  message: string
  author: { name: string; login?: string; avatarUrl?: string; date: IsoDate }
  htmlUrl: string
  parents: string[]
  verified?: boolean // GitHub signature verification (not Pine verification)
  stats?: { additions: number; deletions: number; total: number }
  files?: { filename: string; status: string; additions: number; deletions: number }[]
}

export interface SourceRef {
  provider: 'github'
  owner: string
  repo: string
  repoId?: number
  pullRequest?: { number: number; title: string; htmlUrl: string; author: string; state: PullState }
  commit: { sha: string; message: string; author: string; committedAt: IsoDate; htmlUrl: string }
  /** Required when the claim concerns a regression introduced relative to base */
  baseCommit?: { sha: string; htmlUrl: string }
  license?: string | null
  /** Additive (api mode): branch whose history contains the commit, proving membership when there is no pull request */
  branch?: string
}

// ---------------------------------------------------------------------------
// Claim authoring
// ---------------------------------------------------------------------------

export type EvidenceMechanismId =
  /** ERC-1497 `submitEvidence` on the Reality↔Kleros arbitrator proxy; block timestamp is the proof */
  | 'erc1497-arbitrator-proxy'
  /** Commit hash on-chain first, reveal package later (front-running mitigation; launch gate) */
  | 'commit-reveal'

export interface EvidenceMechanism {
  id: EvidenceMechanismId
  label: string
  /** Contract that receives submissions, when on-chain */
  contract?: Address
  chainId: ChainId
  description: string
  launchGate?: string
}

export interface EnvironmentPin {
  runtime: string // "node 22.14.0"
  packageManager?: string // "pnpm 10.9.2"
  dependencyLock?: { path: string; hash: Hex }
  /** Non-secret configuration as key/value; hashed into configHash */
  config: Record<string, string>
  configHash: Hex
  containerImage?: string // image@sha256:…
  externalState?: string // e.g. "Gnosis block 41_200_000 snapshot" or "none"
  reproductionCommand: string // "pnpm vitest run test/reporter-funding.spec.ts"
  setupSteps: string[]
  notes?: string
  /** keccak256 of canonical JSON of this pin (without envHash itself) */
  envHash: Hex
}

export interface OracleParams {
  chainId: ChainId
  /** When Reality.eth accepts answers; must be >= evidence deadline */
  openingTime: IsoDate
  /** Seconds an answer must stand unchallenged */
  timeoutSeconds: number
  /** Minimum bond for an answer, decimal string in the chain's native/bond token */
  minBond: DecimalString
  bondToken: string // "xDAI"
  arbitrator: Address
  arbitratorName: string // "Kleros (Seer Reality proxy)"
  language: string // "en_US"
  category: string // "software-verification"
}

export interface ClaimSpec {
  title: string // short human title, <= 90 chars
  policyId: string
  policyVersion: string
  /** Optional claim class inside the policy family */
  claimClass?: string
  /** One exact behavioral requirement / invariant */
  requirement: string
  /** Violation phrase inserted in the question: "reporter-deposit principal can consume…" */
  violation: string
  scope: { inScope: string[]; outOfScope: string[] }
  parameters: Record<string, string | string[] | boolean>
  faultModel?: string
  allowedInputs?: string
  assumptions: string[]
  exclusions: string[]
  environment: EnvironmentPin
  /** Only regressions relative to the base commit qualify */
  regressionOnly: boolean
  evidence: { mechanism: EvidenceMechanismId; deadline: IsoDate }
  oracle: OracleParams
  /** Pointer to the source requirement doc, if any */
  specReference?: { label: string; url: string; hash?: Hex }
}

export interface ClaimQuestion {
  text: string
  outcomes: string[] // ["Yes", "No"] — Seer adds "Invalid result" natively
  /** keccak256(text) */
  hash: Hex
}

export interface ClaimManifest {
  $schema: string
  manifestVersion: '1'
  claimId: string
  createdAt: IsoDate
  creator: Address
  source: SourceRef
  policy: { id: string; version: string; hash: Hex; uri: string }
  claim: ClaimSpec
  question: ClaimQuestion
  disclaimers: string[]
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type ClaimStatus =
  | 'draft'
  | 'publishing' // partially created/funded — recoverable
  | 'open' // evidence window open, market trading
  | 'awaiting_answer' // deadline passed, oracle not yet answered
  | 'answer_proposed' // Reality answer posted, challenge window running
  | 'disputed' // answer challenged, bonds escalating
  | 'arbitration' // escalated to Kleros
  | 'resolved' // final; see outcome
  | 'settled' // resolved and the viewer has nothing left to redeem/withdraw
  | 'failed' // creation failed irrecoverably

export type Outcome = 'yes' | 'no' | 'invalid'

export interface TimelineEvent {
  id: string
  kind:
    | 'drafted'
    | 'manifest_pinned'
    | 'market_created'
    | 'liquidity_added'
    | 'liquidity_removed'
    | 'evidence_submitted'
    | 'evidence_deadline'
    | 'oracle_opened'
    | 'answer_posted'
    | 'answer_challenged'
    | 'arbitration_requested'
    | 'ruling'
    | 'finalized'
    | 'redeemed'
  at: IsoDate
  title: string
  detail?: string
  actor?: Address
  txHash?: Hex
  /** true for scheduled future events (deadline, expected finalization) */
  scheduled?: boolean
}

// ---------------------------------------------------------------------------
// Market / oracle
// ---------------------------------------------------------------------------

export interface TokenInfo {
  address: Address
  symbol: string
  decimals: number
  name?: string
}

export interface OutcomeQuote {
  index: number
  label: string // "Yes" | "No" | "Invalid result"
  token: Address
  /** Last/mid price in collateral, [0,1] */
  price: number
  change24h?: number // absolute price change
}

export interface DepthLevel {
  /** price in collateral */
  price: number
  /** cumulative outcome tokens available up to this price */
  size: number
  side: 'bid' | 'ask'
}

export interface DepthSnapshot {
  outcome: 'yes' | 'no'
  mid: number
  levels: DepthLevel[]
  at: IsoDate
}

export interface PoolInfo {
  address: Address
  dex: string // "Swapr (Algebra)" | "Uniswap v3"
  outcome: 'yes' | 'no'
  tvl: DecimalString
  feeBps: number
}

export interface MarketState {
  chainId: ChainId
  address: Address
  seerUrl: string
  conditionId: Hex
  questionId: Hex
  collateral: TokenInfo
  outcomes: OutcomeQuote[]
  pools: PoolInfo[]
  liquidity: DecimalString // total pool TVL in collateral
  volume24h: DecimalString
  volumeTotal: DecimalString
  traders: number
  openInterest: DecimalString
  createdAt: IsoDate
  createdTx: Hex
}

export type RealityAnswer = 'yes' | 'no' | 'invalid' | 'too_soon'

export interface OracleAnswerEntry {
  answer: RealityAnswer
  bond: DecimalString
  answerer: Address
  at: IsoDate
  txHash: Hex
}

export interface ArbitrationState {
  requested: boolean
  requestedAt?: IsoDate
  requester?: Address
  disputeId?: string
  court?: string
  cost: DecimalString // arbitration fee in native token
  status: 'not_requested' | 'pending' | 'appeal_period' | 'ruled'
  ruling?: RealityAnswer
  appealDeadline?: IsoDate
  klerosUrl?: string
}

export interface OracleState {
  chainId: ChainId
  realityQuestionId: Hex
  realityUrl: string
  templateId: number
  openingTime: IsoDate
  timeoutSeconds: number
  minBond: DecimalString
  bondToken: string
  currentAnswer?: RealityAnswer
  currentBond?: DecimalString
  /** When the current answer finalizes if unchallenged */
  finalizesAt?: IsoDate
  isFinalized: boolean
  finalAnswer?: RealityAnswer
  history: OracleAnswerEntry[]
  arbitration: ArbitrationState
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export type EvidenceKind = 'counterexample' | 'rebuttal' | 'clarification' | 'commitment'

export interface EvidenceAttachment {
  name: string
  uri: string
  mime: string
  size: number
  hash: Hex
}

export interface Evidence {
  id: string
  claimId: string
  kind: EvidenceKind
  title: string
  /** Untrusted user content — render as plain text / sanitized markdown only */
  summary: string
  submitter: Address
  submittedAt: IsoDate // block timestamp
  blockNumber: number
  txHash: Hex
  chainId: ChainId
  uri: string
  contentHash: Hex
  timely: boolean
  reproduction?: {
    command: string
    environment: string
    expected: string
    actual: string
    steps?: string[]
  }
  attachments: EvidenceAttachment[]
  /** For commit-reveal: the commitment this reveals, or reveal status */
  commitment?: { hash: Hex; revealed: boolean; revealedAt?: IsoDate }
}

export interface EvidenceDraft {
  claimId: string
  kind: EvidenceKind
  title: string
  summary: string
  reproduction?: Evidence['reproduction']
  attachments: Omit<EvidenceAttachment, 'uri' | 'hash'>[]
  mode: 'direct' | 'commit'
}

// ---------------------------------------------------------------------------
// Claims (read models)
// ---------------------------------------------------------------------------

export interface ClaimSummary {
  id: string // stable id, e.g. "pine-0042"
  number: number // 42 → displayed "PINE-0042"
  title: string
  violation: string
  policy: {
    id: string
    version: string
    family: PolicyFamilyId
    title: string
    /**
     * Additive (api mode): the policy the claim pins on chain cannot be named (its digest is no catalog policy and the
     * claim is not integrity-verified). `id` is 'UNKNOWN' and `family` a placeholder: show `hash`/`uri`, never a
     * /policies/<id> link or a family label.
     */
    unknown?: boolean
    /** Additive (api mode): SHA-256 of the policy document the claim pins on chain. */
    hash?: Hex
    /** Additive (api mode): content address of that policy document (ipfs://<raw CID>). */
    uri?: string
  }
  source: {
    owner: string
    repo: string
    commitSha: string
    prNumber?: number
    prTitle?: string
    /** Additive (api mode): the numeric GitHub repository id the claim pins on chain (its repository identity). */
    repoId?: number
    /**
     * Additive: `owner`/`repo` are only as stated in the claim document; nothing tied them to `repoId`. Show them as
     * unverified, never as the verified repository.
     */
    unverifiedName?: boolean
  }
  status: ClaimStatus
  outcome?: Outcome
  createdAt: IsoDate
  evidenceDeadline: IsoDate
  chainId: ChainId
  marketAddress?: Address
  creator: Address
  creatorGithub?: string
  /** Market-implied chance that a qualifying counterexample is accepted (YES price) */
  yesPrice?: number
  yesPrice24hAgo?: number
  liquidity: DecimalString
  volume: DecimalString
  collateralSymbol: string
  evidenceCount: number
  traders: number
  sponsored: boolean
  tags: string[]
}

export interface PublicationStep {
  id: TxStepId
  status: TxStepStatus
  txHash?: Hex
  error?: string
  at?: IsoDate
}

export interface ClaimDetail extends ClaimSummary {
  manifest: ClaimManifest
  manifestUri: string
  manifestHash: Hex
  market?: MarketState
  oracle?: OracleState
  evidence: Evidence[]
  timeline: TimelineEvent[]
  /** Present when status === 'publishing' or 'failed' */
  publication?: { steps: PublicationStep[]; resumable: boolean; note?: string }
  /** Funding as originally planned/committed by the creator */
  funding?: { liquidity: DecimalString; spendingLimit: DecimalString; withdrawable: boolean }
}

export type ClaimSort = 'newest' | 'deadline' | 'liquidity' | 'volume' | 'yes_price' | 'activity'

export interface ClaimQuery {
  status?: ClaimStatus | ClaimStatus[]
  outcome?: Outcome
  policyId?: string
  family?: PolicyFamilyId
  repo?: string // owner/name
  /**
   * Additive: a GitHub repository id from a trusted source (GitHub's answer for owner/name, or a claim's
   * `source.repoId`). api mode: sent as the backend's repositoryId filter; takes precedence over `repo`.
   */
  repositoryId?: number
  creator?: Address
  chainId?: ChainId
  search?: string
  sort?: ClaimSort
  cursor?: string
  limit?: number
}

export interface Page<T> {
  items: T[]
  nextCursor?: string
  total?: number
}

// ---------------------------------------------------------------------------
// Prices / activity / portfolio
// ---------------------------------------------------------------------------

export type PriceRange = '24h' | '7d' | '30d' | 'all'

export interface PricePoint {
  t: number // unix ms
  yes: number
  no: number
  volume?: number
}

export type ActivityType =
  | 'market_created'
  | 'manifest_pinned'
  | 'liquidity_added'
  | 'liquidity_removed'
  | 'split'
  | 'merge'
  | 'trade'
  | 'evidence_submitted'
  | 'answer_posted'
  | 'arbitration_requested'
  | 'ruling'
  | 'finalized'
  | 'redeemed'
  | 'approval'

export interface ActivityItem {
  id: string
  type: ActivityType
  claimId: string
  claimNumber: number
  claimTitle: string
  actor: Address
  at: IsoDate
  txHash: Hex
  chainId: ChainId
  /** signed collateral flow from the actor's perspective (+ in, − out) */
  amount?: DecimalString
  token?: string
  outcome?: 'yes' | 'no' | 'invalid'
  side?: 'buy' | 'sell'
  summary: string
  status?: 'confirmed' | 'pending' | 'failed'
}

export interface ActivityQuery {
  claimId?: string
  account?: Address
  types?: ActivityType[]
  cursor?: string
  limit?: number
}

export interface OutcomePosition {
  claimId: string
  claimNumber: number
  claimTitle: string
  status: ClaimStatus
  outcome: 'yes' | 'no' | 'invalid'
  balance: DecimalString
  avgPrice?: number
  markPrice: number
  value: DecimalString
  /** True when resolved and this position pays out */
  redeemable: boolean
  redeemableAmount?: DecimalString
}

export interface LiquidityPosition {
  claimId: string
  claimNumber: number
  claimTitle: string
  tokenId: string
  pool: Address
  outcome: 'yes' | 'no'
  deposited: DecimalString
  currentValue: DecimalString
  feesEarned: DecimalString
  withdrawable: boolean
  inRange: boolean
}

export interface Portfolio {
  address: Address
  positions: OutcomePosition[]
  liquidity: LiquidityPosition[]
  totals: {
    positionsValue: DecimalString
    liquidityValue: DecimalString
    redeemable: DecimalString
    depositedAllTime: DecimalString
    withdrawnAllTime: DecimalString
    feesPaidAllTime: DecimalString
  }
}

export interface PlatformStats {
  openClaims: number
  resolvedClaims: number
  totalLiquidity: DecimalString
  volume30d: DecimalString
  evidenceSubmissions: number
  counterexamplesAccepted: number // resolved YES
  collateralSymbol: string
}

// ---------------------------------------------------------------------------
// Funding & transactions
// ---------------------------------------------------------------------------

export type CostKind =
  /** Paid and gone (gas, protocol/platform fee) */
  | 'spent'
  /** Deposited and exposed to market loss */
  | 'at_risk'
  /** Set aside, only spent if a condition occurs (oracle bond, arbitration) */
  | 'reserved'
  /** Recoverable by withdrawing (not guaranteed value) */
  | 'withdrawable'

export interface CostLine {
  key:
    | 'gas_market_creation'
    | 'gas_approval'
    | 'gas_split'
    | 'gas_liquidity'
    | 'protocol_fee'
    | 'platform_fee'
    | 'liquidity_deposit'
    | 'swap_fee_tier'
    | 'oracle_bond'
    | 'arbitration_fee'
    | 'ipfs_pinning'
  label: string
  amount: DecimalString
  currency: string // "sDAI" | "xDAI"
  kind: CostKind
  estimate: boolean
  payer: 'you' | 'answerer' | 'challenger' | 'platform' | 'sponsor'
  note: string
  /** Included in the spending-limit total */
  countsTowardLimit: boolean
}

export type TxStepId =
  | 'upload_manifest'
  | 'create_market'
  | 'approve_collateral'
  | 'split_position'
  | 'add_liquidity_yes'
  | 'add_liquidity_no'
  | 'register_claim'
  // additive (core): non-publication flows
  | 'upload_evidence'
  | 'submit_evidence'
  | 'redeem_positions'
  | 'approve_outcome_tokens'
  // additive (api mode): one step of a backend transaction plan, `plan:<plan step id>`, plus the offchain step that
  // creates and verifies the plan
  | `plan:${string}`

export type TxStepStatus = 'idle' | 'awaiting_signature' | 'pending' | 'confirmed' | 'failed' | 'skipped'

export interface TxStep {
  id: TxStepId
  label: string
  description: string
  kind: 'offchain' | 'transaction' | 'signature'
  /**
   * Present for transactions. `from`, when set, is the only account the step may be sent from (the account a verified
   * plan was built for): the executor refuses to simulate or send from any other.
   */
  request?: { chainId: ChainId; to: Address; data: Hex; value: string /* wei */; from?: Address }
  /** Estimated cost shown before the wallet prompt */
  estimatedCost?: { amount: DecimalString; currency: string }
  /** Collateral this step moves out of the wallet (e.g. the liquidity deposit); counts toward the spending limit */
  collateralCost?: { amount: DecimalString; currency: string }
  /** After this step confirms, claim terms are frozen */
  freezesTerms?: boolean
  optional?: boolean
}

export interface FundingInput {
  chainId: ChainId
  liquidity: DecimalString // collateral the customer deposits as liquidity
  spendingLimit: DecimalString
  initialYesPrice: number // e.g. 0.15
  /** Price band for concentrated liquidity, [lo, hi] */
  priceRange: [number, number]
  sponsored?: boolean
}

export interface FundingPlan {
  input: FundingInput
  collateral: TokenInfo
  costs: CostLine[]
  totals: {
    maxSpend: DecimalString // sum of countsTowardLimit lines
    exposedToLoss: DecimalString
    nonRecoverable: DecimalString
    reservedIfDisputed: DecimalString
    withdrawable: DecimalString
  }
  withinLimit: boolean
  headroom: DecimalString // spendingLimit − maxSpend
  warnings: string[]
  steps: TxStep[]
}

// ---------------------------------------------------------------------------
// Drafts & accounts
// ---------------------------------------------------------------------------

export type ComposerStage = 'source' | 'policy' | 'claim' | 'deadlines' | 'funding' | 'review' | 'publish'

export interface ClaimDraft {
  id: string
  owner: string // github login or address
  createdAt: IsoDate
  updatedAt: IsoDate
  stage: ComposerStage
  source?: SourceRef
  spec: Partial<ClaimSpec>
  funding?: Partial<FundingInput>
  /** Persisted tx progress for recovery */
  publication?: {
    steps: PublicationStep[]
    manifestUri?: string
    manifestHash?: Hex
    marketAddress?: Address
    claimId?: string
    /** Additive (api mode): the backend draft this local draft is mirrored to, and its latest preview and publication */
    backend?: { draftId: string; revision: number; previewId?: string; documentSha256?: Hex; publicationId?: string }
  }
}

export interface LinkedWallet {
  address: Address
  chainId: ChainId
  verifiedAt: IsoDate // SIWE
  label?: string
  primary: boolean
}

export interface AccountPreferences {
  defaultChainId: ChainId
  defaultSpendingLimit: DecimalString
  notifyOnEvidence: boolean
  notifyOnAnswer: boolean
  notifyOnDeadline: boolean
  notificationEmail?: string
  displayCurrency: 'collateral' | 'usd'
}

export interface Account {
  id: string
  github: GitHubUser & { scopes: string[] }
  wallets: LinkedWallet[]
  preferences: AccountPreferences
  createdAt: IsoDate
  demo: boolean
}

// ---------------------------------------------------------------------------
// Agent-facing
// ---------------------------------------------------------------------------

export interface AgentClaimBrief {
  schema: string
  id: string
  number: number
  url: string
  status: ClaimStatus
  outcome?: Outcome
  question: string
  questionHash: Hex
  manifest: { uri: string; hash: Hex; jsonUrl: string }
  policy: { id: string; version: string; hash: Hex; uri: string; url: string; title: string }
  target: {
    repository: string // https://github.com/owner/repo
    commit: string
    commitUrl: string
    baseCommit?: string
    pullRequest?: string
  }
  requirement: string
  violation: string
  scope: { inScope: string[]; outOfScope: string[] }
  faultModel?: string
  assumptions: string[]
  exclusions: string[]
  environment: EnvironmentPin
  reproduction: { command: string; setupSteps: string[] }
  evidence: {
    mechanism: EvidenceMechanism
    deadline: IsoDate
    deadlineTs: number
    requirements: string[]
    submitUrl: string
  }
  market?: {
    chainId: ChainId
    address: Address
    seerUrl: string
    collateral: string
    outcomes: { label: string; price: number; token: Address }[]
    liquidity: DecimalString
  }
  oracle?: { realityQuestionId: Hex; realityUrl: string; openingTime: IsoDate; currentAnswer?: RealityAnswer }
  disclaimers: string[]
  updatedAt: IsoDate
}

// ---------------------------------------------------------------------------
// GitHub input parsing (additive, owned by core)
// ---------------------------------------------------------------------------

/**
 * Parsed result of a pasted GitHub URL / shorthand.
 * Structurally identical to `ParsedGitHubRef` in packages/data/src/types.ts (data may re-export this one).
 * Additive: `short: true` is set when the SHA has fewer than 40 hex chars; short SHAs are accepted for
 * lookup only and must be resolved to the full 40-hex SHA via GitHub before a claim can pin them.
 */
export type ParsedGitHubRef =
  | { kind: 'repo'; owner: string; repo: string }
  | { kind: 'pull'; owner: string; repo: string; number: number }
  | { kind: 'commit'; owner: string; repo: string; sha: string; short?: boolean }
  | { kind: 'pull_commit'; owner: string; repo: string; number: number; sha: string; short?: boolean }
