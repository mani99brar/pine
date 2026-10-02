# The three Pine frontends compared

All three versions implement the same customer journey (SPEC §3, steps 1–9) on the same tested core. The core covers policies, hashing, validation, lifecycle, funding, transaction plans and agent data. The three versions differ in who they optimize for, how you move through them, and how they look.

| | v1 Pine Console | v2 Pine Docket | v3 Pine Field |
|---|---|---|---|
| App / port | `apps/console` · 3001 | `apps/docket` · 3002 | `apps/field` · 3003 |
| Optimized for | Engineers shipping patches; agent operators | Team leads and risk-conscious customers new to prediction markets | Investigators, traders and agents looking for claims to challenge; customers who want vivid live tracking |
| Core idea | **The verification workbench.** Keyboard-first: command palette, dense tables, tabbed claim workspace | **Procedural clarity.** Claims are case files, evidence is exhibits, and every claim has a procedural timeline | **The open challenge board.** A live board of claims rendered as custom data glyphs |
| Signature moment | The composer's live artifacts pane: the immutable question, `manifest.json` and five hash chips recompute and flash as you type. An IDE-style Problems panel shows what's blocking | "Read it as an investigator would": the exact question with every binding term annotated, plus "would count / would not count" checklists. A printable filing document | The sentence-template claim builder (edit the question in place), and the tension-bar glyph (YES/NO as a rope with a knot at the market-implied chance) |
| Creating a claim | Single-page split-pane composer with a progress gutter. Paste a GitHub URL into ⌘K to start | 8-step guided filing wizard with plain-language guidance beside each field and mandatory risk acknowledgement using real numbers | Visual composer: the SHA locks in as you pin a commit, policy cards, sentence builder, deadline timeline, funding sliders with a live budget bar |
| Exploring claims | Sortable table with sparklines, deadline bars, saved views, j/k navigation, preview pane | A docket grouped by procedural stage, needs-attention first | Board, list and map views with filter chips and sorts ("closing soon", "thin depth", "biggest move") |
| Claim page | Tabs: Overview · Market (price-impact calculator) · Evidence · Oracle · Agent · Activity | "Where this stands" first (next step, who acts, by when), then a sticky procedural timeline as navigation, exhibits, and the market with its caveats | Large tension chart with event pins, depth chart, price-impact simulator, Investigate panel, bond-ladder oracle view, Kleros track |
| Visual identity | "Bark & Resin". Cool frost, pine-green interactive elements, amber for "just changed". Archivo with its width axis, Martian Mono only for literal bytes. Light and dark | Institutional. White sheets on a cool counter, stamp violet, flag-yellow focus. Atkinson Hyperlegible for the interface, Source Serif 4 only for binding text. Light-first and print-ready | Vivid survey board. Fog ground, indigo ink, hatched flare for YES, cobalt for NO, lumen for time pressure. Anybody (expanded) for display, Archivo condensed for figures. Light and night |
| Color for outcomes | YES = alarm red (Flare); NO = neutral slate; invalid = violet | YES = exhibit red; NO = neutral slate "held" band; invalid = hatched | YES = hatched orange; NO = solid cobalt; invalid = cross-hatched sliver |

## Shared by all three

- **Accounts.** GitHub sign-in with `read:user` only (demo sign-in without credentials), wallet linking via SIWE, a default spending limit and chain, data export and account deletion.
- **Lifecycle coverage.** Every lifecycle state: open, awaiting answer, answer proposed, disputed, arbitration, resolved YES/NO/invalid, settled, publishing (resumable), and failed.
- **Resumable publishing.** Publishing runs these steps:
  1. Pin the manifest.
  2. Create the market. This freezes the terms.
  3. Approve exactly the collateral needed.
  4. Split the collateral into outcome tokens.
  5. Add liquidity on the DEX (manual step).

  Each step is checked against the spending limit, survives a reload, and can be retried or resumed from the dashboard.
- **Evidence.** Submission on Ethereum (ERC-1497) in direct or commit-reveal mode, with the policy's admissibility checklist.
- **Positions.** Redemption, LP positions, and an activity ledger with reconciliation.
- **Agent data.** `/llms.txt`, `/.well-known/pine.json`, `/api/agent/v1/*` (briefs as JSON or Markdown, manifests, policies, JSON Schema, OpenAPI, Atom feed), and JSON-LD on claim pages.
- **Reference pages.** Policies catalog (SC-001 visible but gated), risks and launch gates, a demo banner with a "fail next transaction" control for reviewers, and untrusted evidence rendered inert.

## How to choose

- **Console** if the first customers are engineering teams and agent operators who live in GitHub and terminals.
- **Docket** if trust and comprehension are the bottleneck: buyers who need to understand exactly what they pay for and what NO does *not* mean.
- **Field** if the bottleneck is attracting investigators. The board makes open claims, their odds, depth and deadlines legible at a glance.

The versions share every package, so features can move between them. Docket's investigator-reading review step, for example, could be added to Console's composer as a review tab.
