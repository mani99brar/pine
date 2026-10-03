# Pine Frontend Implementation Plan

> **Historical note (2026-10-03):** executed as written. Of the apps it produced, only Pine Prism (added afterwards) is kept; Console, Docket and Field were removed. Paths below predate the move into `frontend/`.

> **For agentic workers:** this plan runs as **parallel work packages** (WP), one subagent per WP, all in the same working tree on branch `feat/frontend`. Each WP lists its files, the interfaces it consumes and produces, and its acceptance checks. Steps use checkbox (`- [ ]`) syntax.

**Goal:** three production-grade Next.js frontends (Console, Docket, Field) for Pine GitHub claim verification, on a shared, tested domain/data core with mock, REST and Envio data sources and agent-facing data.

**Architecture:** a pnpm monorepo. `@pine/core` (pure domain), `@pine/data` (adapters and fixtures), `@pine/react` (headless hooks and providers) and `@pine/server` (route handlers) are consumed as TS source by three apps with independent design systems.

**Tech Stack:** Next.js 16.3 · React 19.3 · TypeScript 5.9.3 · Tailwind 4.3 · TanStack Query 5 · wagmi 2.19 · viem 2 · RainbowKit 2.2 · next-auth 5.0.0-beta.32 · zod 4 · vitest 5 · motion 14 · Playwright 1.63 (QA).

**Spec:** `docs/superpowers/specs/2026-10-03-frontend-design.md`. Shared API contract: `docs/frontend/package-api.md`. Domain contract: `packages/core/src/types.ts`, `packages/data/src/types.ts`.

## Global Constraints

- Node 22, pnpm 11. TypeScript `strict` + `noUncheckedIndexedAccess`, with no `any` in exported signatures.
- Do not rename or remove fields in `packages/core/src/types.ts` or `packages/data/src/types.ts`. Additive changes only, and record each one in `docs/frontend/STATUS.md`.
- Language rules (spec §8) apply verbatim. Never "safe/secure/certified/audited/verified correct". YES is "Counterexample demonstrated", NO is "No qualifying counterexample submitted". Price is "market-implied chance a qualifying counterexample is accepted". Liquidity is never "bounty/reward". Invalid is never "refund".
- Amount math uses bigint (viem `parseUnits`/`formatUnits`), never float addition of money.
- Approvals are exact-amount. Never `maxUint256`.
- Untrusted content (evidence, PR titles/bodies, commit messages) renders as text or through `react-markdown` + `rehype-sanitize`. No `dangerouslySetInnerHTML` except JSON-LD built from our own data via `JSON.stringify` with `<` escaped.
- Every app runs with zero env vars (mock mode) and shows a demo banner.
- **Coordination:** agents do **not** run `git commit`; the orchestrator commits. Agents edit only their own WP paths. Adding a dependency requires the install mutex: `until mkdir /tmp/pine-pnpm.lock 2>/dev/null; do sleep 5; done; pnpm add <pkg> --filter <pkg-name>; rmdir /tmp/pine-pnpm.lock`. Dev ports: console 3001, docket 3002, field 3003.
- `docs/frontend/STATUS.md` is the readiness board. Package agents append a line when an export group lands, and app agents read it.

## Review Focus

1. **GitHub input variety**: PR URLs with `/files` or `/commits/<sha>`, `owner/repo#12`, short SHAs, trailing slashes, uppercase hex. A person expects a paste to resolve or to give a clear reason. Pinned in WP-A `parseGitHubRef` tests.
2. **Deadline and timezone confusion**: a local datetime input versus UTC, or a deadline in the past or within 24h, or an oracle opening before the deadline. Expect explicit UTC display and blocking validation. Pinned in WP-A `validateClaimDraft` tests.
3. **Money precision and limits**: decimal inputs like `0.1`, `5`, `1e-7` and empty values. A spending limit lower than the costs must block publishing. Pinned in WP-A `estimateFunding` tests.
4. **Interrupted publication**: a page reload while a tx is pending, a wallet rejection, or a failed liquidity step after the market was created. Expect the flow to resume from the first incomplete step, with terms frozen after `create_market`. Pinned in WP-C tx runner tests, and in the mock fixture `publishing` claim exercised by every app.
5. **Hostile evidence content**: `<script>`, 10k-char unbroken strings, `javascript:` links. Expect inert rendering, wrapping and no layout break. Pinned in WP-B fixtures (one hostile evidence item), which every app must render.

---

### WP-A: @pine/core (agent: core)

**Files:** `packages/core/src/**` (`policies.ts`, `hash.ts`, `question.ts`, `manifest.ts`, `validation.ts`, `github-ref.ts`, `lifecycle.ts`, `funding.ts`, `tx.ts`, `chains.ts`, `abis/*.ts`, `copy.ts`, `format.ts`, `agent/*.ts`, `index.ts`), `packages/core/test/**`.
**Consumes:** `docs/research/seer-integration.md` (written by the research agent; may land mid-task, so use it for chains/abis when present and mark `verified:false` otherwise).
**Produces:** every `@pine/core` export in `docs/frontend/package-api.md`.

- [ ] Task A1: canonical JSON, hashing, formatting (`hash.ts`, `format.ts`). Tests: key order independence (`hashJson({b:1,a:2}) === hashJson({a:2,b:1})`), nested arrays keep order, `canonicalJson(NaN)` throws, `formatPrice(0.153) === '15.3%'`, `shortSha` returns 7 chars.
- [ ] Task A2: policy catalog (`policies.ts`). FUNC-001, BOT-001 and SC-001 at 0.1.0, with text taken from `policies/README.md`, parameter specs, claim classes (BOT-001 gets the five candidate classes), SC-001 `status:'gated'`, and `contentHash = hashText(text)`. Test: every policy hash matches its text, and SC-001 is gated.
- [ ] Task A3: GitHub ref parsing and validation (`github-ref.ts`, `validation.ts`). Tests cover every Review Focus #1 form and #2 (the deadline must be ≥ now+24h and in UTC, `oracle.openingTime ≥ evidence.deadline`, the SHA must be 40 hex, and a regression-only claim needs a base commit).
- [ ] Task A4: question, manifest and lifecycle (`question.ts`, `manifest.ts`, `lifecycle.ts`, `copy.ts`). The question text matches spec §5 exactly. The manifest hash is deterministic and stable across key order. `deriveStatus` covers every `ClaimStatus`. `nextStep` returns a sensible step per status. Tests include a snapshot of the keeper example question.
- [ ] Task A5: funding (`funding.ts`), covering `estimateFunding` with bigint math, every cost line classified, `withinLimit`, warnings, and `priceImpact`. Tests cover Review Focus #3 and walking a depth book.
- [ ] Task A6: chains, ABIs and tx builders (`chains.ts`, `abis/`, `tx.ts`). Calldata is encoded with viem. Gnosis (100) is the default, plus Ethereum (1) and Sepolia (11155111) where known. `verified:false` plus notes wherever the research is not confirmed. Tests: `buildPublishSteps` order and `freezesTerms` on `create_market`, and an approve amount that equals the liquidity exactly.
- [ ] Task A7: agent artifacts (`agent/*.ts`): briefs, Markdown, llms.txt, well-known, Atom, JSON-LD, the manifest JSON Schema (draft 2020-12) and OpenAPI 3.1. Tests: the brief from a sample claim validates its required keys, and the Atom feed is well-formed XML (contains `<feed`, escapes `&<>`).
- [ ] Acceptance: `pnpm --filter @pine/core typecheck && pnpm --filter @pine/core test` pass. Append "core: ready" to STATUS.md.

### WP-B: @pine/data + indexer contracts (agent: data)

**Files:** `packages/data/src/**`, `packages/data/test/**`, `docs/indexer/**`.
**Consumes:** `@pine/core` (in progress, so import only the names in package-api.md; if a function is missing when you need it, write against its signature and re-run once STATUS shows core ready).
**Produces:** every `@pine/data` export, plus `@pine/data/fixtures`.

- [ ] Task B1 (**first, fast; apps are waiting**): mock fixtures and `MockDataProvider` (≥14 claims covering every status/outcome, a flagship keeper claim, a hostile evidence item, seeded price history, depth, activity, a portfolio for the demo wallet `0xD3m0…`, mock GitHub repos/PRs/commits, demo accounts). Post "data: mock ready" to STATUS.md as soon as `createDataProvider()` returns the mock provider.
- [ ] Task B2: `createGitHubSource` live (fetch `api.github.com`, optional token, rate-limit → `PineDataError('rate_limited')`) and mock.
- [ ] Task B3: `ManifestStorage` (ipfs via `PINE_IPFS_UPLOAD_URL` server-side or the `/api/ipfs` route, plus gateway read) and mock. `DraftStore` and `AccountStore` in local (localStorage with an in-memory fallback) and REST variants.
- [ ] Task B4: REST contract `docs/indexer/rest-api.openapi.yaml` (OpenAPI 3.1, every read endpoint plus drafts/accounts writes) and `RestDataProvider` with wire-to-domain mappers. Tests use example payloads from the OpenAPI examples.
- [ ] Task B5: Envio contract `docs/indexer/envio/schema.graphql`, `config.example.yaml` (events to index: Seer MarketFactory NewMarket, ConditionalTokens, Reality LogNewQuestion/LogNewAnswer/LogNotifyOfArbitrationRequest/LogFinalize, arbitrator Evidence/Ruling, pool Swap/Mint/Burn), plus `docs/indexer/README.md` (which entities and fields the frontend reads and how manifests hydrate from IPFS). Then `EnvioDataProvider` using Hasura-style queries via `fetch`. Tests run the mappers against sample GraphQL responses.
- [ ] Acceptance: typecheck and tests pass. Append "data: ready".

### WP-C: @pine/react + @pine/server + agent docs (agent: platform)

**Files:** `packages/react/src/**`, `packages/server/src/**`, their tests, `docs/agents/**`.
**Consumes:** `@pine/core`, `@pine/data` (in progress, same rule as WP-B).
**Produces:** every `@pine/react` and `@pine/server` export in package-api.md.

- [ ] Task C1 (**first**): `PineProviders`, `usePine` and all query hooks over the data provider. Post "react: queries ready".
- [ ] Task C2: the demo wallet. It is a wagmi `mock` connector or a custom connector in demo mode, with a simulated receipt delay of 1.2–3s and `failNext`. Then `useTxRunner`, with local storage persistence, resume on reload, the spending-limit guard and retry/skip. Tests: the resume-after-reload state machine, and a limit breach blocking start (Review Focus #4).
- [ ] Task C3: `useClaimComposer`, `useDrafts`, `usePublishClaim`, `useSubmitEvidence`, `useRedeem`, `useNow`, `useCopy`, `useHotkeys`.
- [ ] Task C4: the `@pine/server` auth (GitHub `read:user`; a demo credentials provider when GitHub is not configured), the GitHub proxy, account and SIWE handlers, the agent handler (all v1 routes), llms/well-known handlers, and an `/api/ipfs` upload handler (mock in mock mode). Then `useAccount`, `useLinkWallet` and the GitHub hooks against those routes.
- [ ] Task C5: `docs/agents/agent-api.md` and `docs/agents/claim-manifest.schema.json` (generated from core). Also `docs/frontend/integrating-an-app.md`: the exact route files an app must add (copy-paste block).
- [ ] Acceptance: typecheck and tests pass. Append "react: ready" and "server: ready" with the mount snippet.

### WP-D/E/F: apps (agents: console, docket, field)

**Files:** `apps/<name>/**` only.
**Consumes:** `@pine/react`, `@pine/server`, `@pine/core`, `@pine/core/copy`. Until STATUS shows readiness, build the design system, layout and presentational components against `@pine/core` types with local sample props, then wire the hooks in.
**Produces:** a complete app per spec §9, with its own creative brief (v1 Console, v2 Docket, v3 Field).

- [ ] Task 1: run the `frontend-design:frontend-design` skill. Write `apps/<name>/DESIGN.md` (tokens: 4–6 named colors, typefaces, layout concept with ASCII wireframes, principles, and what was revised away from the generic defaults).
- [ ] Task 2: the design system in `src/components/ui` (tokens in `globals.css` via Tailwind 4 `@theme`, light/dark if fitting), plus the app shell (nav, account menu, wallet button, demo banner, footer with risk links).
- [ ] Task 3: Landing, Explore and Claim detail (all states, including the hostile-evidence and publishing-recovery fixtures).
- [ ] Task 4: the new-verification composer (source → policy → claim → deadlines/oracle → funding → review → publish), with drafts and resume.
- [ ] Task 5: Dashboard, Account/settings (GitHub, wallets via SIWE, preferences, export, sign-out), Repositories browser, Evidence submission, Policies, Activity/reconciliation, Agents page, Risks and launch gates, 404/error/loading.
- [ ] Task 6: mount the `@pine/server` routes (auth, github, account, agent, llms, well-known, ipfs), add JSON-LD and alternate links on claim pages, and add metadata/OG.
- [ ] Task 7: QA. `pnpm --filter @pine/app-<name> typecheck lint build` pass. Write a Playwright script in `apps/<name>/qa/screens.mjs` that screenshots every route at 1440 and 390 widths into `apps/<name>/.qa/` (gitignored). Review the screenshots (Read the PNGs), fix visual defects, and repeat until clean. Then check that every route and agent endpoint returns 200.
- [ ] Task 8: `apps/<name>/README.md` covering concept, routes, env, how to run, and design notes.

### WP-G: integration (orchestrator)

- [ ] Merge readiness: commit after each WP lands. Run root `pnpm typecheck`, `pnpm test` and `pnpm build`.
- [ ] Cross-app smoke: start all three apps and curl every route and agent endpoint.
- [ ] Independent review: one fresh reviewer agent per app (UX, copy rules, accessibility, states), with fixes applied.
- [ ] Root `README.md`, `docs/frontend/deployment.md` (Vercel + Docker), `docs/frontend/launch-gates.md`, and a comparison page of the three versions.
