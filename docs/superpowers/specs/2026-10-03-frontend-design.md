# Pine Frontend — Design Spec

Date: 2026-10-03
Status: decided autonomously. The requester delegated all decisions ("take decisions … I'll see you once the task is finished") and was unavailable for review. Every decision below is recorded so it can be overridden later.

Source requirements: [SPEC.md](../../../SPEC.md), [policies/README.md](../../../policies/README.md), [docs/keeper-bot-market-example.md](../../keeper-bot-market-example.md).

## 1. Intent

**What was asked:** a frontend for the GitHub Claim Verification product. It must cover account creation, market creation and management, and the full application view. It needs a data layer that can read from either a REST API or an Envio indexer (the indexer itself is not to be built), plus machine-readable data for AI agents. Deliver **three production-ready versions**. Creativity, UI/UX and usability matter most.

**Assumptions, stated plainly:**

- The three versions are alternative product directions for the same feature set. They are not three releases of one design. They share a domain/data core so business rules stay identical, and they differ in IA, interaction paradigm and visual identity.
- "Production ready" means: typed, builds cleanly, and is configurable for live operation through env vars. Every app can also run with **zero external services** in a demo mode, so it can be reviewed immediately. Unresolved launch gates from SPEC §10 are surfaced in the UI and docs, never hidden behind fake certainty.
- "Create account" means signing in with GitHub (minimal scopes) and linking one or more wallets (SIWE signature) to that identity, plus account preferences such as default spending limit and chain.
- "Indexer: API and Envio both options" means the frontend reads through one `PineDataProvider` interface with three adapters: `mock` (fixtures), `rest` (against an OpenAPI contract defined here) and `envio` (against an Envio HyperIndex GraphQL schema defined here). The indexer contracts are documented. No indexer code is written.
- "Data for the AIs to consume" means agent-facing discovery: `llms.txt`, a well-known JSON descriptor, a versioned JSON agent API with a JSON Schema for claim manifests, an Atom feed, JSON-LD on claim pages, and a copyable "agent brief" in the UI.

**Success criteria:**

1. Three apps (`apps/console`, `apps/docket`, `apps/field`) each pass `typecheck`, `lint` and `next build`, and run in demo mode with `pnpm dev`.
2. Each covers the full customer journey of SPEC §3, steps 1–9, plus the release requirements of SPEC §8 that a frontend can own.
3. Each has a clearly distinct, non-templated design and UX paradigm, verified by screenshot review at desktop and mobile widths.
4. Shared packages are unit tested (vitest). Question/manifest hashing is deterministic.
5. The language rules in §8 are honored everywhere.

## 2. Stack (decided)

| Concern | Choice | Why |
|---|---|---|
| Monorepo | pnpm workspaces (pnpm 10) | Shared core across three apps; single lockfile |
| Framework | Next.js 16 (App Router, React 19.3) | SSR for agent-readable pages, route handlers for agent API and auth, one deployable per app |
| Language | TypeScript 5.9 (strict) | TS 7 (native) is too new for Next's toolchain |
| Styling | Tailwind CSS 4.3 + per-app CSS tokens | Each app owns its own design system |
| Data fetching | TanStack Query 5 | Caching, polling of live market state |
| Wallet | wagmi 2.19 + viem 2 + RainbowKit 2.2 | RainbowKit does not support wagmi 3 yet |
| Auth | Auth.js (`next-auth@5.0.0-beta.32`), GitHub provider, JWT sessions | No database required, minimal scope `read:user` (public repos only, per SPEC §2) |
| Wallet linking | SIWE (EIP-4361) via viem `verifyMessage` | Proves wallet ownership for the account |
| Validation | zod 4 | Shared form and manifest schemas |
| Hashing | canonical JSON (RFC 8785 via `canonicalize`) + keccak256 (viem) | Deterministic, chain-verifiable content hashes |
| Motion | `motion` 14 | Used sparingly; respects reduced motion |
| Charts | Recharts 3 or hand-rolled SVG (per app) | — |
| Tests | vitest 5 (packages); Playwright (screenshot QA) | — |

## 3. Repository layout

```
pine/
  package.json, pnpm-workspace.yaml, tsconfig.base.json
  packages/
    core/     @pine/core   pure TS: domain types, policy catalog, manifest + question builders,
                            hashing, zod schemas, lifecycle derivation, funding estimator,
                            chain config + Seer/Reality/Kleros ABIs, tx-plan builders,
                            agent artifact builders, copy/disclosure constants, formatters
    data/     @pine/data   PineDataProvider interface + adapters (mock | rest | envio),
                            GitHub source (live | mock), manifest storage (ipfs | mock),
                            draft store (local | rest), rich demo fixtures
    react/    @pine/react  headless React: providers (query, wagmi, RainbowKit, session),
                            hooks (claims, claim, market, evidence, activity, portfolio, policies,
                            github, drafts, account), tx runner state machine, demo wallet
    server/   @pine/server Next.js server helpers: Auth.js config, GitHub proxy handlers,
                            SIWE link handlers, agent API route handlers, llms.txt, feed, well-known
  apps/
    console/  v1 "Pine Console"  port 3001
    docket/   v2 "Pine Docket"   port 3002
    field/    v3 "Pine Field"    port 3003
  docs/
    indexer/  rest-api.openapi.yaml, envio/schema.graphql, envio/config.example.yaml, README.md
    agents/   agent-api.md, claim-manifest.schema.json
    frontend/ README per app, deployment.md, launch-gates.md
```

Apps consume packages as TS source (`transpilePackages`). There is no separate package build step.

## 4. Runtime modes and configuration

`NEXT_PUBLIC_PINE_DATA_SOURCE` = `mock` (default) | `rest` | `envio`

| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_PINE_API_URL` | REST indexer base URL (rest mode; also optional write API for drafts/accounts) |
| `NEXT_PUBLIC_ENVIO_GRAPHQL_URL` | Envio HyperIndex GraphQL endpoint (envio mode) |
| `NEXT_PUBLIC_IPFS_GATEWAY` | Gateway for reading manifests/evidence (default `https://cdn.kleros.link`) |
| `PINE_IPFS_UPLOAD_URL` / `PINE_IPFS_UPLOAD_TOKEN` | Server-side pinning endpoint |
| `NEXT_PUBLIC_CHAIN_ID` | Default chain (100 = Gnosis) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Optional; injected wallets work without it |
| `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | GitHub OAuth. When absent, "Demo sign-in" uses fixture identities |
| `NEXT_PUBLIC_PINE_DEMO_WALLET` | `1` enables the simulated wallet (auto-on in mock mode) |

In **mock mode** everything works offline: fixtures for claims, markets, oracle and evidence; mock GitHub (realistic repos, PRs and commits, including the gateway-balancer keeper example); a simulated wallet whose transactions advance with realistic delays and can be told to fail (to exercise recovery). A persistent, dismissible banner states that the app is in demo mode.

**Envio mode** reads on-chain state only. Claim manifests are hydrated from IPFS, and drafts and account preferences live in local storage. **REST mode** is the full backend: indexed chain state plus off-chain records (drafts, accounts, notifications).

## 5. Domain model (contract)

The authoritative definitions live in `packages/core/src/types.ts`; this section summarizes them.

- **PolicyVersion**: id (`FUNC-001`, `BOT-001`, `SC-001`), family, semver, status (`enabled`, or `gated` with a reason: SC-001 is gated by the disclosure process), content hash, URI, full text, a parameter spec used to render forms, evidence requirements, exclusions, outcome rules.
- **SourceRef**: GitHub owner/repo, optional PR, the exact commit (40-hex SHA), an optional base commit.
- **ClaimSpec**: what the customer authors. Title, one requirement, the violation phrase, scope, policy parameters, fault model, assumptions, exclusions, environment pin (runtime, lockfile hash, config hash, container digest, external state, reproduction command), regression-only flag, evidence (mechanism and absolute UTC deadline), oracle parameters.
- **ClaimManifest**: the immutable published record. The schema URL, claim id, source, spec, the policy reference with its hash, the question (text, outcomes, hash), and the creator. `manifestHash` = keccak256(canonical JSON).
- **Question text** follows SPEC §5 exactly: "Was a reproducible counterexample demonstrating {violation} against commit {sha}, under configuration/environment {envHash} and policy {policyId}@{version} ({policyHash}), submitted through {mechanism} before {UTC timestamp}?" The manifest URI and hash are appended in the market description.
- **ClaimStatus** (lifecycle phase): `draft`, `publishing` (partially created/funded; recoverable), `open` (evidence window open), `awaiting_answer` (deadline passed, oracle not yet answered), `answer_proposed`, `disputed` (answer challenged, bonds escalating), `arbitration` (Kleros), `resolved` (with `outcome`: `yes`, `no` or `invalid`), `settled` (the user has redeemed or withdrawn everything), `failed`.
- **MarketState**: chain, Seer market address, condition and question ids, collateral, outcomes (Yes, No, Invalid) with prices, liquidity, depth levels, volume, trader count, Seer URL.
- **OracleState**: Reality question id, opening time, timeout, min bond, current answer and bond, answer history, finalize timestamp, and arbitration (requested, dispute id, cost, ruling, Kleros URL).
- **Evidence**: submitter, tx hash, block time (the timestamp proof), URI, content hash, kind (`counterexample`, `rebuttal`, `clarification`, `commitment`), reproduction block, attachments, timeliness. Commitment mode (hash first, reveal later) mitigates front-running. It is shown as available but flagged as a launch gate.
- **FundingPlan**: liquidity amount, spending limit, cost lines classified as `spent`, `at_risk`, `reserved` or `withdrawable` (estimates are flagged), totals (max spend, exposed to loss, withdrawable, non-recoverable), and ordered **TxSteps** (`upload_manifest`, `create_market`, `approve_collateral`, `split_position`, `add_liquidity`, …) with persisted status for recovery.
- **Account**: GitHub identity and granted scopes, linked wallets (SIWE-verified), preferences.
- **ActivityItem**: typed history entries used for transaction history and funding/redemption reconciliation.
- **AgentClaimBrief**: the machine-readable investigation brief. It contains target, requirement, environment pins, reproduction command, evidence channel and deadline, admissibility rules, exclusions, market and oracle refs, and disclaimers.

## 6. Data layer

```ts
interface PineDataProvider {
  kind: 'mock' | 'rest' | 'envio'
  listClaims(q: ClaimQuery): Promise<Page<ClaimSummary>>
  getClaim(id: string): Promise<ClaimDetail | null>
  getPriceHistory(id: string, range: PriceRange): Promise<PricePoint[]>
  getDepth(id: string): Promise<DepthSnapshot | null>
  listEvidence(id: string): Promise<Evidence[]>
  listActivity(q: ActivityQuery): Promise<Page<ActivityItem>>
  getPortfolio(address: Hex): Promise<Portfolio>
  listPolicies(): Promise<PolicyVersion[]>
  getPolicy(id: string, version?: string): Promise<PolicyVersion | null>
  getStats(): Promise<PlatformStats>
}
```

Separate interfaces: `GitHubSource`, `ManifestStorage`, `DraftStore`, `AccountStore`. `createDataProvider(env)` picks the adapter. The REST and Envio adapters map wire formats to domain types. Mapping code is unit-tested against example payloads taken from the documented contracts.

## 7. Agent-facing data (served identically by all apps via `@pine/server`)

- `/llms.txt` and `/llms-full.txt`: what Pine is, how to find open claims, how to submit evidence, and the rules.
- `/.well-known/pine.json`: a discovery descriptor (API base, schema URLs, feed, supported chains, policy catalog).
- `/api/agent/v1/claims?status=open&policy=BOT-001`: a paginated JSON list of agent briefs.
- `/api/agent/v1/claims/{id}`: the full agent brief. Add `?format=md` for a Markdown prompt.
- `/api/agent/v1/claims/{id}/manifest.json`: the canonical manifest, with an `x-pine-manifest-hash` header.
- `/api/agent/v1/policies` and `/api/agent/v1/policies/{id}`: the policy text with its hash.
- `/api/agent/v1/schema/claim-manifest.json`: the JSON Schema.
- `/api/agent/v1/openapi.json`: the OpenAPI document for the agent API.
- `/api/agent/v1/feed.xml`: an Atom feed of newly opened claims.
- Claim pages embed JSON-LD (`schema.org/Question` + `Dataset`) and `<link rel="alternate" type="application/json">`.
- UI: "Agent brief" panel with copy-as-Markdown, copy-curl, and the manifest hash.

## 8. Language and safety rules (all apps)

- Never "safe", "secure", "certified", "verified correct" or "audited". Use "No qualifying counterexample submitted" for NO and "Counterexample demonstrated" for YES.
- A YES outcome is bad news for the code. Never color NO with a celebratory success green plus a checkmark meaning "safe". Use a neutral or "held" treatment.
- Market price is labeled "market-implied chance a qualifying counterexample is accepted". It is never "probability of bugs". Volume and trader counts get a caption saying they do not prove review depth.
- Liquidity is never called a bounty or a reward. No promised researcher payment, minimum return, refund or loss reimbursement. An invalid outcome is never a "refund".
- The evidence deadline is not a trading cutoff. Tokens may stay transferable.
- Show customer capital at risk, every fee, price impact and executable depth, withdrawability, oracle bonds and arbitration costs, and who pays each.
- Explicit spending limit. The wallet approves only the computed amount, never unlimited allowance.
- Treat all submitted content as untrusted: render evidence text as plain text or sanitized Markdown, never `dangerouslySetInnerHTML`, and keep external links `rel="noopener noreferrer nofollow"`.
- No merge, deploy or target-system actions anywhere in the UI.
- SC-001 (smart-contract) policies are displayed but gated ("Requires approved disclosure process").
- Unresolved launch gates (SPEC §10) are visible on a `/launch-gates` or `/risks` page and referenced from flows where they apply.

Canonical disclosure copy lives in `@pine/core/copy` so all three apps say the same thing.

## 9. The three versions

All three implement the same journey and the same pages. They differ deliberately in audience emphasis, IA, interaction model and visual identity. Each app's agent picks its own palette and typography following the `frontend-design` skill, and must avoid that skill's listed generic defaults. In particular, avoid near-black + acid green, cream + serif + terracotta, and broadsheet hairlines.

### v1 — Pine Console (`apps/console`): "the verification workbench"
- **Audience emphasis:** engineers who ship patches, and agent operators.
- **Paradigm:** keyboard-first workbench. A global command palette (⌘K) can jump to any claim, repo or policy. Pasting a GitHub PR/commit URL into the palette starts a claim. Split-pane composer: form on the left, live artifacts on the right (question text, `manifest.json`, hash chips that visibly change as inputs change). Dense sortable tables with inline price sparklines. j/k navigation and shortcut hints. The claim page is a tabbed workspace (Overview, Market, Evidence, Oracle, Agent, Activity).
- **Signature moment:** the composer's live artifact pane. You watch the immutable question and hashes form as you type.

### v2 — Pine Docket (`apps/docket`): "procedural clarity"
- **Audience emphasis:** team leads and risk-conscious customers who are new to prediction markets.
- **Paradigm:** guided filing. Claims are case files with docket numbers. Evidence items are exhibits. Each claim follows a procedural timeline (filed → evidence window → deadline → answer → challenge window → arbitration → final → settlement), and the claim page leads with "where are we and what happens next". A multi-step wizard pairs each field with plain-language guidance. Mandatory risk acknowledgement shows real numbers. A print stylesheet renders a claim as a filing document.
- **Signature moment:** the "read it as an investigator would" review step and the procedural timeline.

### v3 — Pine Field (`apps/field`): "the open challenge board"
- **Audience emphasis:** investigators, traders and agent operators discovering opportunities, plus customers who want vivid live tracking.
- **Paradigm:** visual, market-forward discovery. A live board of open claims with distinctive data glyphs: a tension bar between the two outcomes, time-remaining rings, depth bars and policy marks. A rich claim page with a large price chart, a depth chart and a price-impact simulator. An "Investigate" panel holds repro steps, pins and the agent brief. Composer: paste a PR, watch the commit get pinned, pick a policy from visual cards, then build the claim with a sentence-template editor that fills the question in place. A funding slider updates a live cost and risk breakdown.
- **Signature moment:** the sentence-template claim builder and the tension-bar data glyph.

### Shared page inventory (each app may name and arrange them its own way)
Landing · Explore claims (filters: status, policy, repo, chain; search; sort) · Claim detail (question, immutable refs, status and next step, market prices/depth/price impact, evidence, oracle/dispute, agent brief, activity, my position and redemption) · New verification composer (source → policy → claim → deadlines/oracle → funding → review → publish with resumable tx steps) · Drafts and in-progress publications (recovery) · Dashboard (my claims, positions, LP positions, alerts) · Account/settings (GitHub connection and scopes, wallets via SIWE, defaults, notifications, sign-out, data export) · Repositories browser (repos → PRs → commits) · Submit evidence · Policies catalog and version detail · Activity/transaction history with reconciliation · Agents (human-readable doc of the agent API) · Risks and launch gates · 404 / error boundaries.

Required states: loading (skeletons), empty, error (with retry), pending tx, disputed, arbitration, invalid, resolved YES, resolved NO, failed/partial publication.

Quality floor: responsive to 360px, keyboard accessible, visible focus, WCAG AA contrast, `prefers-reduced-motion`, dark and light themes where it fits the identity, metadata and OG tags.

## 10. Transaction flow and recovery

The tx runner (`@pine/react` `useTxRunner(plan)`) executes ordered steps. Each step persists `{status, txHash}` to local storage under the draft id. On reload it re-checks receipts and resumes from the first incomplete step. A failed step offers retry, edit (only before `create_market` is confirmed), or abandon with an explanation of what is already on-chain. After `create_market` confirms, the claim terms are frozen. Funding steps can be completed later from the dashboard ("Finish funding").

Approvals are exact-amount. Before every wallet prompt the user sees the cost against the remaining spending limit. A step that would exceed the limit is blocked.

## 11. Testing and verification

- `@pine/core`: vitest for hashing determinism, question builder, lifecycle derivation, funding estimator, zod schemas.
- `@pine/data`: vitest for REST and Envio mappers using contract example payloads, and mock provider query behavior.
- Apps: typecheck, lint, `next build`, plus Playwright screenshot passes of key routes at 1440px and 390px, reviewed by the building agent. A final cross-app smoke script hits every route and agent endpoint and expects HTTP 200.

## 12. Out of scope

The indexer implementation, smart contracts, the evidence relay backend, the IPFS pinning service, and deployment to hosting. Deployment *docs* (Vercel, Docker) are in scope. Legal review is a launch gate (SPEC §8).
