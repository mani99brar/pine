# Pine Docket (`apps/docket`)

Version 2 of the Pine frontend: **procedural clarity**. It runs on port 3002.

Pine lets a team pin an exact commit, file one bounded, policy-versioned claim about it, and fund a Seer prediction market. The market gives independent investigators, human or AI, a reason to find a reproducible counterexample before an absolute UTC deadline. Reality.eth answers the question and Kleros arbitrates disputes. No counterexample is not proof of correctness.

Docket is written for engineering leads, founders and risk-conscious customers who are new to prediction markets and oracles. Every screen answers three questions, in this order:

1. Where does this stand?
2. What happens next, who has to act, and by when?
3. What does it cost me, and what can go wrong?

## Concept

Claims are **case files** with docket numbers (`PINE-0042`). Evidence comes in as **exhibits**, lettered A, B, C. Every claim moves through an eight-stage **procedure**:

Filed → Evidence window → Evidence deadline → Oracle answer → Challenge window → Arbitration (only if disputed) → Final answer → Settlement

The visual system expresses structure rather than decoration. Immutable, binding text (the question, the requirement, policy text) is set in a serif, as if entered into a register. Guidance about the record is set in sans. Values you compare character by character (SHAs, hashes, addresses) are in mono. Guidance sits in a margin beside what it explains. See [DESIGN.md](DESIGN.md) for the palette, type scale, wireframes and the defaults we revised away from.

## Signature interactions

- **The procedural timeline as navigation.** On a claim page, an eight-stage rail stays visible on desktop and becomes a swipeable strip on mobile. Each stage shows its state (done, current, not needed, failed) and its date, and links to the section that governs it: exhibits, oracle, outcome or position.
- **"Where this stands" first.** A claim page opens with a colored status band, a plain sentence about the current situation, and three cells: *What happens next*, *Who acts* and *By when* (from `nextStep`, absolute UTC first). Market numbers come after the procedure, always with their caveat.
- **"Read it as an investigator would."** The review step shows the exact immutable question with seven binding terms marked: the counterexample, the violation, the commit, the environment hash, the policy, the evidence channel and the deadline. Hovering or focusing a numbered note highlights its term in the question, and the reverse. Below that is a two-column checklist of what *would* and *would not* count, drawn from the policy and the claim's own terms, followed by every term on record and the manifest JSON.
- **Risk acknowledgement with real numbers.** Six mandatory acknowledgements quote the actual `FundingPlan`: capital exposed to loss, non-recoverable gas and fees, bonds and the ETH arbitration fee (who pays them), withdrawability, the bounty and correctness caveats, and frozen terms. They are tied to a signature of the plan, so changing an amount clears them.
- **Guided filing.** Eight steps (Source → Policy → Claim → Environment → Deadlines and oracle → Funding → Review → Publish) with an always-visible step register. You can revisit any step. On Continue, a step validates and shows an error summary that links to each field, in plain language. On mobile, the margin guidance folds into "What does this mean?" disclosures. Drafts autosave and can be resumed.
- **Printable filing.** "Print or save as PDF" on a claim opens every disclosure and prints a clean filing document. It has numbered sections, a procedure table and the manifest hash in the footer. Interactive widgets are left out.

## Routes

| Route | What it is |
|---|---|
| `/` | Landing. An annotated live docket entry; what you get and do not get; the procedure; how outcomes read; an itemized cost example (real `estimateFunding`); the live docket; investigators and agents |
| `/docket` | The docket: search and filters (stage, policy, repository, chain, order), grouped by procedural stage. Needs-attention groups come first. Also a single-list view |
| `/claims/[id]` | Case file: where this stands, procedure rail, the question on record (annotated), terms on record, exhibits, oracle and disputes, outcome, market (price with caveat, chart, impact calculator, depth), funding and your position (redeem), agent brief, the record. Covers every status, including "Finish filing" for partial publications |
| `/claims/[id]/evidence` | File an exhibit: kind, direct or sealed (commit-reveal, launch gate), reproduction fields, attachments, the policy's admissibility checklist, timeliness, and a notice that the wallet switches to Ethereum |
| `/file` | Before you file: what to have ready, the steps, continue a draft, start from the worked example |
| `/file/[draftId]?step=…` | The filing wizard |
| `/filings` | Drafts, filings started but not finished (resume), and filings from this browser |
| `/my-docket` | Dashboard: needs your attention, upcoming deadlines, claims you filed, outcome tokens, liquidity, redeemables |
| `/activity` | Ledger with reconciliation: deposited, fees, withdrawn, redeemable, still held, net, plus a running balance |
| `/account` | GitHub sign-in (minimal `read:user` scope, explained), linked wallets via SIWE, preferences, data export, delete, sign out |
| `/repositories`, `/repositories/[owner]/[repo]`, `/repositories/[owner]/[repo]/pull/[n]` | Repos, then PRs, then commits, with "File for this commit" on each |
| `/policies`, `/policies/[id]?version=` | Policy catalog and version detail: full text, hash, parameters, outcome rules. SC-001 is shown but gated |
| `/agents` | Human guide to the agent API, with live links and a real Markdown brief |
| `/risks` | Every disclosure (`COPY.disclosures`) and launch gate (`COPY.launchGates`) |
| `/how-it-works` | Plain-language guide: the procedure, who is involved, outcomes and an A–Z glossary |
| Agent and server routes | `/api/auth/*`, `/api/github/*`, `/api/account/*`, `/api/agent/*` (v1 claims, briefs, manifests, policies, schema, OpenAPI, Atom feed), `/api/ipfs`, `/llms.txt`, `/llms-full.txt`, `/.well-known/pine.json` |

Claim pages embed JSON-LD (`buildClaimJsonLd`) and `<link rel="alternate" type="application/json" href="/api/agent/v1/claims/{id}">`. Every route sets its own metadata and Open Graph tags.

## Running it

```bash
pnpm install
pnpm --filter @pine/app-docket dev        # http://localhost:3002, mock mode, no env needed
pnpm --filter @pine/app-docket typecheck
pnpm --filter @pine/app-docket lint
pnpm --filter @pine/app-docket build && pnpm --filter @pine/app-docket start
```

In **mock mode** (the default) everything works offline: fixture claims in every state, mock GitHub, a simulated wallet and demo sign-in. A dismissible banner says so and holds **reviewer controls**: *Simulate failure on next transaction* (`useDemoWallet().failNext()`), connect or disconnect the simulated wallet, and reset demo data. The same "make the next transaction fail" control appears beside the Publish and File exhibit actions.

## Configuration

All configuration is read by the shared packages. See `docs/frontend/integrating-an-app.md` for the full table.

| Variable | Effect |
|---|---|
| `NEXT_PUBLIC_PINE_DATA_SOURCE` | `mock` (default), `rest` or `envio` |
| `NEXT_PUBLIC_PINE_API_URL` / `NEXT_PUBLIC_ENVIO_GRAPHQL_URL` | Indexer endpoints for `rest` and `envio` |
| `NEXT_PUBLIC_CHAIN_ID` | Default chain (100, Gnosis) |
| `NEXT_PUBLIC_SITE_URL` | Absolute URL for metadata, JSON-LD and agent links (defaults to `http://localhost:3002`) |
| `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `NEXT_PUBLIC_PINE_GITHUB_OAUTH=1` | Real GitHub sign-in. Without them, a demo identity is used |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Optional. Injected wallets work without it |
| `PINE_IPFS_UPLOAD_URL`, `PINE_IPFS_UPLOAD_TOKEN` | Server-side pinning for manifests and exhibits |

## Screenshot QA

```bash
pnpm --filter @pine/app-docket dev &           # port 3002
node apps/docket/qa/screens.mjs                # every route, claim states, wizard steps, mobile nav, print → apps/docket/.qa/
node apps/docket/qa/screens.mjs claim mobile   # filter by shot name
node apps/docket/qa/peek.mjs /claims/pine-0009 1440 900 0,900   # viewport slices for close inspection
node apps/docket/qa/peek.mjs wizard:review 390 844 all          # any wizard step, from the worked example
```

Interaction checks, each runs a real flow in the browser against the dev server:

```bash
node apps/docket/qa/flow-publish.mjs    # worked example → validation → review acknowledgements → publish with a forced failure, retry, manual DEX steps, "Entered on the docket"
node apps/docket/qa/flow-evidence.mjs   # exhibit form: error summary, then a filed exhibit that appears on the claim
node apps/docket/qa/flow-finish.mjs     # finish a partially published claim (PINE-0015)
node apps/docket/qa/flow-redeem.mjs     # redeem a winning position on a resolved claim
node apps/docket/qa/flow-caret.mjs      # mid-text edits keep the caret in composer fields
node apps/docket/qa/flow-focus.mjs      # keyboard tab order and focus ring
node apps/docket/qa/errors.mjs / /docket  # console and page errors for given paths
```

The screenshot script runs at 1440×900 and 390×844 with reduced motion. It loads `?qa=1`, which makes simulated transactions near-instant via `setDemoTxDelays`. It reports page errors, console errors and any horizontal overflow.

## Design notes

- **Language rules** (spec §8) come from `@pine/core/copy` wherever possible. YES is "Counterexample demonstrated", in Exhibit red. NO is "No qualifying counterexample submitted", in neutral slate with a dash, never a green check. Invalid gets a hatched band, and its copy explains that only Invalid-result tokens redeem. Price is always labelled as the market-implied chance, with its caveat. Volume carries the review-depth caveat. Liquidity is never called a bounty.
- **Integration facts** are shown, not hidden:
  - The 3.5-day answer timeout is read-only.
  - Arbitration is on Ethereum, paid in ETH, and takes about two weeks plus 11 days per appeal.
  - Exhibits are Ethereum transactions, and the wallet switches.
  - Liquidity is a manual DEX step, with an "Open the DEX" link and "Mark done" with an optional tx hash.
- **Untrusted content** (exhibits, PR titles and bodies, commit messages) is plain text or `react-markdown` + `rehype-sanitize`. Raw HTML is skipped, images are dropped, non-http links are made inert, and external links are `noopener noreferrer nofollow`. Long strings are clamped and wrap. The only `dangerouslySetInnerHTML` is our own JSON-LD, with `<` escaped.
- **Accessibility.** There is a skip link. The focus ring is civic: a Flag-yellow ring with an ink outer ring, visible on any background. Native form controls are used throughout. Error summaries take focus. `aria-current` marks the current step and stage. Charts have a table view. `prefers-reduced-motion` is honored. Body text is at least 7:1 contrast (AAA), and secondary text is 7.6:1.
- **Motion** is limited to the current-stage marker settling once and the "Entered on the docket" stamp after filing.
- **Atkinson Hyperlegible's slashed zero** is kept on purpose. It disambiguates docket numbers, SHAs and amounts.
