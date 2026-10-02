# Pine Console

Version 1 of the Pine frontends: **the verification workbench**. It is built for engineers who ship patches (agent-generated PRs included) and for agent operators: people who live in GitHub, terminals, Linear and Raycast.

Pine lets a customer pin an exact commit, publish one bounded, policy-versioned claim about it, and fund a Seer prediction market. The market rewards independent investigators, human or agent, who demonstrate a reproducible counterexample before an absolute UTC deadline. Reality.eth answers the question and Kleros arbitrates disputes. A NO result is not proof of correctness, and the console never says otherwise.

## Concept

The console is a calm, dense precision instrument. A Pine claim is a measurement with bounds: one commit, one requirement, one absolute deadline, and one price on a 0–100 scale. The interface therefore uses one structural motif, **graduations** (tick marks), and every tick encodes something real:

- **Composer progress gutter:** one major tick per section and one minor tick per field. A tick fills when its field is done, a resin tick marks the section in view, and flare marks sections with problems.
- **Deadline bars:** each Explore row draws the evidence window as ticks filled up to now.
- **Price gauge:** the YES price as a needle on a 0–100 graduated scale, with yesterday's price shown as a ghost.
- **Lifecycle ruler:** a claim's whole life on one graduated UTC axis (publish, deadline, oracle opening, finalization, events), with a resin "now" needle.
- **Spending-limit meter:** the plan's maximum spend shown against your limit.

Panes sit flush and are separated by 1px rules, the way an editor lays them out. Only floating layers (palette, dialogs, menus) are elevated. See [DESIGN.md](DESIGN.md) for the palette ("Bark & Resin"), the type system (Archivo with its width axis, plus Martian Mono reserved for literal bytes), wireframes and principles.

## Signature interactions

1. **Command palette (⌘K / Ctrl+K).** Jump to any claim, policy or page, and run actions: new verification, submit evidence for the current claim, copy the agent brief, connect a wallet, simulate a wallet failure, cycle the theme. **Paste a GitHub PR or commit URL** into it and the palette resolves the PR title and head commit, then offers "Verify the head commit of this pull request". Choosing it opens the composer with that commit already pinned.
2. **Live artifacts pane in the composer.** The form sits on the left. The right pane renders the exact immutable `question.txt`, with every inserted value (violation, SHA, environment hash, policy and hash, evidence channel, UTC deadline) marked in place. It also renders a collapsible, syntax-colored `manifest.json` and hash chips for the manifest, question, policy, environment and config. When an input changes, the changed hash characters flash resin, a recompute log records which hashes changed, and the changed JSON leaves flash too. An IDE-style **Problems** panel lists every validation issue, and clicking one scrolls to and focuses its field.
3. **Terminal-style publish log.** Publishing runs pin manifest → create market → approve exact collateral → split → add liquidity, with a status glyph, cost estimate, explorer link and inline retry for each step. A **terms frozen** marker appears once `create_market` confirms. The DEX liquidity steps are manual: "Open DEX", then "Mark done" with an optional tx hash. Progress persists, so a reload resumes the run.
4. **Dense Explore table.** Saved views appear as tabs (Open, Closing soon, Awaiting oracle, Disputed, Resolved, Recovery, Mine, plus your own saved filters). Columns are sortable, rows carry inline YES sparklines and deadline graduation bars, and `j`/`k`/`↵`/`Space` drive the keyboard. A preview pane shows the question, gauge and next step for the selected row.
5. **Claim workspace.** Six tabs, switched with `1`–`6`:
   - **Overview:** the question, lifecycle ruler, terms, reproduction environment and copyable immutable references.
   - **Market:** price chart, depth chart and a price-impact calculator that walks the book.
   - **Evidence:** untrusted content rendered inert, plus submission.
   - **Oracle:** answers, bonds, finalization, and Kleros costs and timing.
   - **Agent:** brief Markdown, curl commands, manifest and JSON-LD.
   - **Activity:** the transaction log.

   The side rail shows the next step, your position and redeem. Partially published claims get a **Finish publishing** panel that resumes from the first incomplete step.

## Routes

| Route | What it is |
|---|---|
| `/` | Landing: an honest explanation, a paste-to-verify box, a live specimen claim, the resolution sequence, open claims, outcome semantics and agent entry points |
| `/claims` | Explore: saved views, filters (`?view=open&policy=BOT-001&repo=owner/name&q=…&sort=yes&dir=desc`), keyboard table and preview pane |
| `/claims/[id]` | Claim workspace (`?tab=overview\|market\|evidence\|oracle\|agent\|activity`), with JSON-LD and `<link rel="alternate" type="application/json">` |
| `/claims/[id]/evidence/new` | Submit evidence: direct or commit-reveal, reproduction fields and the policy's admissibility checklist (`/claims/[id]/evidence` redirects here) |
| `/new` | New verification composer (`?source=<GitHub URL>`, `?draft=<id>`, `?policy=BOT-001`) |
| `/drafts` | Drafts, publications in progress, and claims that need recovery |
| `/dashboard` | My claims, outcome positions, LP positions, redeemables, alerts and funding reconciliation |
| `/settings` | GitHub sign-in (read:user only), SIWE wallet linking, preferences, theme, demo failure control, data export and delete |
| `/repos`, `/repos/[owner]/[repo]`, `/repos/[owner]/[repo]/pull/[n]` | Repository browser: repos → PRs or branch → commits → "Verify this commit" |
| `/policies`, `/policies/[id]` | Policy catalog, and version detail with the full text, hash, parameters and gated SC-001 |
| `/activity` | Transaction history with reconciliation: deposited, withdrawn, fees and gas, redeemable, still at stake, realized |
| `/agents` | Human guide to the agent API, with live links and an example brief |
| `/risks` | All disclosures (`COPY.disclosures`), launch gates (`COPY.launchGates`) and chain integration status |
| `/llms.txt`, `/llms-full.txt`, `/.well-known/pine.json` | Agent discovery (from `@pine/server`) |
| `/api/agent/v1/*` | Agent API: claims, briefs (`?format=md`), manifest.json, policies, schema, OpenAPI, Atom feed |
| `/api/auth/*`, `/api/github/*`, `/api/account/*`, `/api/ipfs` | Shared server routes, mounted per `docs/frontend/integrating-an-app.md` |

The app also ships a 404 page, a route error boundary, a global error boundary and loading skeletons.

## Keyboard

| Keys | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Command palette (paste a GitHub URL here to start a claim) |
| `/` | Focus the page filter (Explore, Repositories), or open the palette |
| `?` | Shortcuts sheet |
| `n` | New verification |
| `g d` / `g c` / `g f` / `g r` / `g p` / `g a` / `g h` / `g s` / `g x` | Dashboard / Claims / Drafts / Repositories / Policies / Agents / Activity / Settings / Risks |
| `t` | Cycle theme: system, light, dark |
| `j` / `k` / `↵` / `Space` | Table: next / previous / open / toggle preview |
| `1`–`6`, `e`, `b` | Claim: switch tab, submit evidence, copy agent brief |
| `[` / `]` / `⌘↵` / `a` | Composer: previous / next section, jump to review, toggle the artifacts sheet (mobile) |
| `Esc` | Close the palette, a dialog or a sheet |

Shortcuts pause while you type in a field. Every shortcut also has a visible control.

## Running

```bash
pnpm install
pnpm --filter @pine/app-console dev        # http://localhost:3001
pnpm --filter @pine/app-console typecheck
pnpm --filter @pine/app-console lint
pnpm --filter @pine/app-console build && pnpm --filter @pine/app-console start
```

With no environment variables the console runs in **demo mode**. It uses fixture claims, mock GitHub data, a demo GitHub identity and a simulated wallet whose transactions advance with realistic delays. A dismissible banner says so and offers **Simulate failure on next transaction**. The same control is in the wallet menu, the palette and Settings, and it exercises retry and recovery in publishing, evidence and redemption.

## Configuration

| Var | Effect |
|---|---|
| `NEXT_PUBLIC_PINE_DATA_SOURCE` | `mock` (default), `rest` or `envio` |
| `NEXT_PUBLIC_PINE_API_URL` | REST indexer, and the optional write API for drafts and accounts |
| `NEXT_PUBLIC_ENVIO_GRAPHQL_URL` | Envio HyperIndex GraphQL endpoint |
| `NEXT_PUBLIC_IPFS_GATEWAY` | Gateway for manifests and evidence (default `https://cdn.kleros.link`) |
| `PINE_IPFS_UPLOAD_URL`, `PINE_IPFS_UPLOAD_TOKEN` | Server-side pinning for `/api/ipfs` |
| `NEXT_PUBLIC_CHAIN_ID` | Default chain (100 = Gnosis) |
| `NEXT_PUBLIC_PINE_DEMO_WALLET` | `1` forces the simulated wallet; it is automatic in mock mode |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Optional; injected wallets work without it |
| `NEXT_PUBLIC_SITE_URL` | Absolute origin for agent links; defaults to the request host |
| `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `NEXT_PUBLIC_PINE_GITHUB_OAUTH=1` | GitHub sign-in (scope `read:user`) |

The theme preference is stored in a cookie, so the server renders the right theme with no inline script. `next.config.ts` aliases the optional `@x402/*` modules that RainbowKit's dependency graph imports lazily to a stub (`src/lib/shims/x402.js`). This is the documented shared workaround.

## Screenshot QA

```bash
node qa/screens.mjs                                # every route, desktop 1440×900 and mobile 390×844 → .qa/
node qa/screens.mjs claim,composer --only=desktop  # comma-separated name filters
node qa/screens.mjs landing,claims --dark          # dark color scheme
```

The script covers every route, every claim state (open, awaiting answer, answer proposed, disputed, arbitration, resolved YES, NO and invalid, settled, publishing recovery, failed, not found), every composer section, the palette with a pasted PR URL, the shortcuts sheet, the mobile nav drawer and signed-in settings. It also runs three real publish flows from a seeded draft: paused at the manual DEX step, completed, and failed then ready for retry. Publish shots use `?qa=1`, which calls `setDemoTxDelays` so simulated transactions are near-instant.

## Language and safety

- Outcome words come from `@pine/core/copy`. YES is "Counterexample demonstrated" in flare, the alarm color. NO is "No qualifying counterexample submitted" in a neutral slate, with no check mark. Invalid is violet, with "Only the Invalid result token redeems … not a refund".
- The price is always labeled as the market-implied chance that a qualifying counterexample is accepted. Volume always carries its caveat, and liquidity is never called a bounty.
- Untrusted text (evidence, PR bodies, commit messages) renders as plain text or through `react-markdown` + `rehype-sanitize`, inside clipped, wrapping containers. Only `http(s)` links render, always with `rel="noopener noreferrer nofollow"`. The only `dangerouslySetInnerHTML` in the app is the claim JSON-LD, built from our own data with `<` escaped.
- Approvals are for the exact amount. Nothing in the UI merges, deploys or acts on a repository.
