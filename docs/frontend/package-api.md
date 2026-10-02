# Shared package API (contract)

The three apps program against these exports. The package agent implements them exactly. Additions are welcome; signature changes are not. Type names refer to `packages/core/src/types.ts` and `packages/data/src/types.ts`.

## @pine/core

```ts
export * from './types'

// policies
export const POLICY_FAMILIES: PolicyFamily[]
export const POLICIES: PolicyVersion[]                        // FUNC-001, BOT-001, SC-001 (SC gated) @ 0.1.0
export function getPolicy(id: string, version?: string): PolicyVersion | undefined
export function policyPath(p: Pick<PolicyVersion,'id'|'version'>): string   // "BOT-001@0.1.0"

// evidence mechanisms
export const EVIDENCE_MECHANISMS: Record<EvidenceMechanismId, EvidenceMechanism>

// hashing & canonical JSON
export function canonicalJson(value: unknown): string        // RFC 8785-style: sorted keys, no whitespace; throws on non-finite numbers
export function hashJson(value: unknown): Hex                // keccak256(utf8(canonicalJson(value)))
export function hashText(text: string): Hex                  // keccak256(utf8(text))
export function shortHash(h: string, chars?: number): string // 0x1234…abcd
export function shortSha(sha: string): string                // 7 chars

// environment & claim
export function computeEnvHash(env: Omit<EnvironmentPin,'envHash'>): Hex
export function computeConfigHash(config: Record<string,string>): Hex
export function buildQuestion(input: { spec: ClaimSpec; source: SourceRef; policy: PolicyVersion }): ClaimQuestion
export function buildMarketDescription(manifest: ClaimManifest, manifestUri: string, manifestHash: Hex): string
export function buildManifest(input: { claimId: string; creator: Address; source: SourceRef; spec: ClaimSpec; policy: PolicyVersion; createdAt?: IsoDate }): { manifest: ClaimManifest; hash: Hex }
export function formatClaimNumber(n: number): string         // "PINE-0042"

// validation (zod 4) — each returns { success, data | error } like zod
export const claimSpecSchema, sourceRefSchema, environmentPinSchema, oracleParamsSchema, fundingInputSchema, evidenceDraftSchema
export function validateClaimDraft(draft: ClaimDraft, now?: Date): { ok: boolean; issues: { path: string; message: string; stage: ComposerStage }[] }
export function parseGitHubRef(input: string): ParsedGitHubRef | null   // URLs, "owner/repo", "owner/repo#12", "owner/repo@sha"

// lifecycle
export function deriveStatus(input: { publication?: ...; market?: MarketState; oracle?: OracleState; evidenceDeadline: IsoDate; now?: Date }): { status: ClaimStatus; outcome?: Outcome }
export function nextStep(claim: ClaimDetail, now?: Date): { title: string; detail: string; at?: IsoDate; actor: 'anyone'|'investigators'|'answerers'|'creator'|'arbitrator'|'holders' }
export const STATUS_META: Record<ClaimStatus, { label: string; description: string; tone: 'neutral'|'active'|'warning'|'critical'|'muted' }>
export const OUTCOME_META: Record<Outcome, { label: string; long: string; tone: 'counterexample'|'held'|'invalid' }>
//   yes → "Counterexample demonstrated", no → "No qualifying counterexample submitted", invalid → "Resolved invalid"
export function timeRemaining(to: IsoDate, now?: Date): { ms: number; label: string; past: boolean } // "2d 4h"

// funding
export function estimateFunding(input: FundingInput, ctx?: { gasPriceGwei?: number; nativeUsd?: number }): FundingPlan
export function priceImpact(depth: DepthSnapshot, side: 'buy'|'sell', amountCollateral: number): { avgPrice: number; impact: number; filled: number; executable: boolean }

// tx plans (viem encodeFunctionData; addresses from chains.ts)
export function buildPublishSteps(input: { chainId: number; manifestUri: string; manifestHash: Hex; question: ClaimQuestion; oracle: OracleParams; funding: FundingInput; creator: Address }): TxStep[]
export function buildEvidenceTx(input: { chainId: number; questionId: Hex; evidenceUri: string }): TxStep
export function buildRedeemTx(input: { chainId: number; market: Address; outcomeIndexes: number[]; amounts: bigint[] }): TxStep

// formatting
export function formatAmount(v: DecimalString | number, opts?: { symbol?: string; maxDecimals?: number; compact?: boolean }): string
export function formatPrice(p: number): string               // 0.153 → "15.3%"  (price-as-chance)
export function formatPriceCents(p: number): string          // 0.153 → "0.153"
export function formatDate(iso: IsoDate, style?: 'short'|'long'|'utc'): string
export function formatRelative(iso: IsoDate, now?: Date): string
export function explorerTxUrl(chainId: number, hash: Hex): string
export function explorerAddressUrl(chainId: number, address: Address): string

// @pine/core/chains
export const CHAINS: Record<number, { id: number; name: string; nativeSymbol: string; collateral: TokenInfo; explorer: string; seer: {...addresses}; reality: Address; arbitrator: Address; verified: boolean; notes: string[] }>
export const SUPPORTED_CHAIN_IDS: number[]

// @pine/core/abis — minimal ABI fragments (MarketFactory, Router, Reality, ArbitratorProxy, ERC20, ConditionalTokens)

// @pine/core/copy — canonical language (see spec §8)
export const COPY: {
  outcome: { yes: string; no: string; invalid: string }
  priceLabel: string           // "Market-implied chance a qualifying counterexample is accepted"
  priceCaveat: string
  volumeCaveat: string
  liquidityIsNotBounty: string
  invalidIsNotRefund: string
  noIsNotSafety: string
  deadlineIsNotTradingCutoff: string
  noMergeAuthority: string
  untrustedContent: string
  spendingLimit: string
  scGate: string
  demoMode: string
  disclosures: { id: string; title: string; body: string }[]   // full risk list for review/ack step
  launchGates: { id: number; title: string; body: string; status: 'open'|'partially_addressed' }[] // SPEC §10
}

// @pine/core/agent
export function toAgentBrief(claim: ClaimDetail, ctx: { siteUrl: string }): AgentClaimBrief
export function briefToMarkdown(brief: AgentClaimBrief): string
export function buildLlmsTxt(ctx: { siteUrl: string; appName: string; stats?: PlatformStats; claims?: ClaimSummary[] }): string
export function buildLlmsFullTxt(ctx: { siteUrl: string; appName: string; policies: PolicyVersion[]; claims: ClaimSummary[] }): string
export function buildWellKnown(ctx: { siteUrl: string; appName: string }): Record<string, unknown>
export function buildAtomFeed(ctx: { siteUrl: string; appName: string; claims: ClaimSummary[] }): string
export function buildClaimJsonLd(claim: ClaimDetail, ctx: { siteUrl: string }): Record<string, unknown>
export const CLAIM_MANIFEST_JSON_SCHEMA: Record<string, unknown>
export function buildAgentOpenApi(ctx: { siteUrl: string }): Record<string, unknown>
```

## @pine/data

```ts
export * from './types'
export function readPineEnv(): PineEnv        // reads NEXT_PUBLIC_* (safe on client and server)
export function createDataProvider(env?: PineEnv): PineDataProvider
export function createGitHubSource(opts: { mode: 'live'|'mock'; token?: string; baseUrl?: string }): GitHubSource
export function createManifestStorage(env?: PineEnv): ManifestStorage
export function createDraftStore(env?: PineEnv): DraftStore           // browser: localStorage; server: memory
export function createAccountStore(env?: PineEnv): AccountStore
export { MockDataProvider, RestDataProvider, EnvioDataProvider }
// MockDataProvider also has demo write paths so demo publishing/evidence shows up everywhere (persisted to
// localStorage 'pine:mock:*' in the browser, memory on the server):
//   addClaim(detail: ClaimDetail): void; addEvidence(claimId: string, e: Evidence): void; recordActivity(a: ActivityItem): void
//   updateClaim(id: string, patch: Partial<ClaimDetail>): void; reset(): void
export const DEMO_WALLET_ADDRESS: Address        // the simulated wallet; fixtures give it positions, LP, history
export const DEMO_GITHUB_USER: GitHubUser          // the demo sign-in identity; owns several fixture claims
export { parseGitHubRef } // re-export from core
// fixtures: import { fixtures } from '@pine/data/fixtures' → { claims: ClaimDetail[], repos, pulls, commits, users, accounts, activity }
```

The mock fixtures are what reviewers see, so they must be rich and realistic. Include at least 14 claims covering every status and outcome: open (several, with varied prices, liquidity and policies), awaiting_answer, answer_proposed, disputed, arbitration, resolved yes, resolved no, resolved invalid, settled, publishing (partial: market created, liquidity step failed), failed, plus one sponsored claim. The gateway-balancer keeper example from `docs/keeper-bot-market-example.md` is the flagship (BOT-001, open). Each claim needs evidence (0–4 items, including a commitment and a late one), timelines, price history generated deterministically (seeded), depth and activity. Use plausible public-style repos (fictional orgs are fine, e.g. `kleros/gateway-balancer-bot`, `acme-labs/fastparse`, `northwind/auth-gateway`, `vaultline/escrow-contracts`). Dates are relative to "now" so the demo never goes stale. Generate them at module load, anchored to `Date.now()` and rounded to the hour.

## @pine/react

```tsx
// providers
export function PineProviders(props: { children; session?: Session | null; rainbowTheme?: Theme; appName: string }): JSX.Element
//   wraps: SessionProvider (next-auth), WagmiProvider, QueryClientProvider, RainbowKitProvider, PineContext (env, provider, storage, github)
export function usePine(): { env: PineEnv; data: PineDataProvider; storage: ManifestStorage; drafts: DraftStore; demo: boolean }

// queries (TanStack Query; all return UseQueryResult)
export function useClaims(q?: ClaimQuery)
export function useInfiniteClaims(q?: ClaimQuery)
export function useClaim(id: string | undefined, opts?: { live?: boolean })   // live polls every 15s
export function usePriceHistory(id: string | undefined, range: PriceRange)
export function useDepth(id: string | undefined, outcome: 'yes'|'no')
export function useEvidence(id: string | undefined)
export function useActivity(q?: ActivityQuery)
export function usePortfolio(address: Address | undefined)
export function usePolicies()
export function usePolicy(id: string | undefined, version?: string)
export function useStats()

// github (calls the app's /api/github/* proxy routes from @pine/server)
export function useGitHubViewerRepos()
export function useGitHubRepoSearch(query: string)
export function useGitHubRepo(owner?: string, repo?: string)
export function useGitHubPulls(owner?: string, repo?: string, state?: 'open'|'closed'|'all')
export function useGitHubPull(owner?: string, repo?: string, number?: number)
export function useGitHubPullCommits(owner?: string, repo?: string, number?: number)
export function useGitHubCommits(owner?: string, repo?: string, ref?: string)
export function useGitHubCommit(owner?: string, repo?: string, sha?: string)
export function useResolveGitHubInput(input: string)   // parse + fetch → { ref, repo, pull, commit }

// account
export function useAccount(): { status: 'loading'|'signed_out'|'signed_in'; account: Account | null; signIn(provider?: 'github'|'demo'): Promise<void>; signOut(): Promise<void>; refresh(): Promise<void> }
export function useLinkWallet(): { link(): Promise<LinkedWallet>; unlink(address): Promise<void>; setPrimary(address): Promise<void>; status; error }  // SIWE via /api/account/siwe
export function useUpdatePreferences()

// composer & drafts
export function useDrafts(): { drafts: ClaimDraft[]; create(partial?): ClaimDraft; save(d); remove(id); isLoading }
export function useClaimComposer(draftId?: string): {
  draft: ClaimDraft; update(patch: Partial<ClaimDraft> | ((d) => ClaimDraft)): void; setStage(s: ComposerStage): void
  policy?: PolicyVersion; question?: ClaimQuestion; manifest?: ClaimManifest; manifestHash?: Hex
  validation: ReturnType<typeof validateClaimDraft>; funding?: FundingPlan; saving: boolean; lastSavedAt?: IsoDate
}
export function usePublishClaim(draftId: string): TxRunner & { claimId?: string; marketAddress?: Address }

// tx runner (generic; used for publish, evidence, redeem, finish-funding)
export interface TxRunnerStep extends TxStep { status: TxStepStatus; txHash?: Hex; error?: string; startedAt?: IsoDate; confirmedAt?: IsoDate }
export interface TxRunner { steps: TxRunnerStep[]; current?: TxRunnerStep; state: 'idle'|'running'|'paused'|'done'|'failed'; start(): Promise<void>; retry(): Promise<void>; skip(id: TxStepId): void; reset(): void; spent: DecimalString; }
export function useTxRunner(key: string, steps: TxStep[], opts?: { spendingLimit?: DecimalString; onConfirmed?(step): void }): TxRunner
export function useSubmitEvidence(claimId: string): { submit(draft: EvidenceDraft): Promise<void>; runner: TxRunner }
export function useRedeem(claimId: string): { runner: TxRunner; redeemable: DecimalString }

// unified wallet (apps use this for every wallet button/state — works for demo wallet and real wagmi wallets)
export function useWallet(): { address?: Address; chainId?: number; isConnected: boolean; isDemo: boolean; connect(): void /* opens RainbowKit modal or connects demo */; disconnect(): void; switchChain(id: number): Promise<void>; balance?: { amount: DecimalString; symbol: string } }

// demo wallet controls (mock mode)
export function useDemoWallet(): { enabled: boolean; address?: Address; connect(): void; disconnect(): void; failNext(stepId?: TxStepId): void; balance: DecimalString }

// misc
export function useNow(intervalMs?: number): Date            // ticking clock for countdowns
export function useCopy(): { copy(text: string): Promise<void>; copied: boolean }
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, deps?: unknown[]): void
```

## @pine/server (Next.js route handlers)

Apps mount these with one-line route files, e.g. `src/app/api/agent/v1/claims/route.ts`:
`export { GET } from '@pine/server/agent/claims'`. Better, a single catch-all: `src/app/api/agent/[...path]/route.ts` → `export { GET } from '@pine/server/agent'`.

```ts
// @pine/server/auth
export function createAuth(opts: { appName: string }): { handlers: { GET; POST }; auth; signIn; signOut }
//   GitHub provider (scope "read:user") when AUTH_GITHUB_ID set; "demo" Credentials provider otherwise (and always in mock mode)
// usage: src/auth.ts → export const { handlers, auth, signIn, signOut } = createAuth({ appName: 'Pine Console' })
//        src/app/api/auth/[...nextauth]/route.ts → export const { GET, POST } = handlers

// @pine/server/github — catch-all proxy: /api/github/[...path] (viewer repos, search, repo, pulls, pull, pull commits, commits, commit)
export function createGitHubHandler(auth): { GET }

// @pine/server/siwe — /api/account/[...path]: GET nonce, POST verify (links wallet), DELETE wallet, GET me, PATCH preferences, GET export
export function createAccountHandler(auth): { GET; POST; PATCH; DELETE }

// @pine/server/agent — catch-all /api/agent/[...path]: v1/claims, v1/claims/:id, v1/claims/:id/manifest.json, v1/policies, v1/policies/:id, v1/schema/claim-manifest.json, v1/openapi.json, v1/feed.xml
export function createAgentHandler(opts: { appName: string }): { GET }
// plus standalone handlers for root files:
export function llmsTxtHandler(opts): { GET }        // src/app/llms.txt/route.ts
export function llmsFullTxtHandler(opts): { GET }    // src/app/llms-full.txt/route.ts
export function wellKnownHandler(opts): { GET }      // src/app/.well-known/pine.json/route.ts
// all responses: CORS `*` for GET, `Cache-Control: public, max-age=30, stale-while-revalidate=300`
```
