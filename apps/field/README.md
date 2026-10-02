# Pine Field

Version 3 of the Pine frontend: **the open challenge board.** Runs on port 3003.

Pine lets a team pin an exact GitHub commit, publish one bounded, policy-versioned claim about it, and fund a Seer prediction market. Investigators, human or agent, then try to demonstrate a reproducible counterexample before an absolute UTC deadline. Reality.eth answers the market question and Kleros arbitrates disputes. A No outcome is never proof of correctness.

Field is for people discovering claims worth challenging (investigators, traders, agent operators) and for teams who want vivid live tracking of their own claims. Its paradigm is a market-forward board built from custom SVG data glyphs. See [DESIGN.md](DESIGN.md) for the full design system.

## Concept

- **The board is the hero.** Every open claim is a tile of four glyphs:
  - **Tension bar:** the Yes/No split as a rope between two anchors. The knot sits at the market-implied chance a qualifying counterexample is accepted. The Invalid-result token is a thin cross-hatched third segment. A dashed "was here" post and a trail under the bar show the 24-hour move.
  - **Time ring:** the evidence window draining clockwise. It turns yellow in the last 24 hours.
  - **Depth bars:** collateral you could actually trade within 1, 2, 5, 10 and 20 points of the price. Hollow bars mean thin depth.
  - **Policy mark:** a shape per family (FUNC circle, BOT hexagon, SC diamond), drawn dashed when gated.
- **Colour without moral judgement.** Yes is hatched orange and No is solid ultramarine: a colour-blind-safe pair that never implies safe or unsafe. Every hue is backed by a hatch, a shape or a label.
- **Type as voice.** Expanded Anybody headlines and condensed Archivo figures inside the glyphs. JetBrains Mono is used only for real code (SHAs, hashes, commands).

## Signature interactions

| Where | What |
|---|---|
| Landing | A short investigator-first headline, then a live glyph wall of the claims closing soonest (a swipeable strip on phones), plus a field map that places every open claim by time left (x), implied chance (y) and depth (ring size). |
| Board (`/board`) | Board, list and map views. Filter chips, search and sorts (closing soon, thin depth, biggest 24h move, newest) live in the URL. One orchestrated "settle" on load, where each knot slides from 50% to its price in a diagonal wave. |
| Claim page | A large tension chart (the bar unrolled over time) with evidence, deadline, answer and ruling pins; fit or full scale; ranges 24h/7d/30d/all. Also a depth chart and a price-impact simulator: slide a size and watch where the knot would move, with average price, slippage and fill. Investigate panel: requirement, reproduction, environment pins, scope, admissibility, and "Copy agent brief" / "Copy curl". Oracle and dispute: bond ladder on a doubling scale, challenge countdown, and the Kleros track with ETH fees and timings. |
| Composer (`/compose`) | Paste a PR or commit URL and watch the SHA lock in character by character. Policy cards (SC-001 visibly gated). **Sentence-template builder:** the exact market question as a sentence with inline slots (violation, environment, mechanism, deadline), side drawers for scope, environment and fault model, and a live board-tile preview. Schematic deadline timeline (fixed 3.5-day challenge window). Funding sliders with a live budget bar (spent / at risk / reserved / withdrawable against the spending limit) and a depth preview. Review with risk acknowledgement, then a step tracker that resumes after reload, including manual DEX liquidity steps. |
| Recovery | A partially published claim (`/claims/pine-0015`) shows what is already on-chain and runs only the outstanding steps ("Finish publishing"). A failed claim can be re-filed from the same terms. |
| Demo | A dismissible demo strip, plus a "Simulate a failure on the next transaction" control in the strip and beside every transaction run. |

## Routes

| Route | Page |
|---|---|
| `/` | Landing |
| `/board` | Explore: board, list and map (`?view=list\|map`, `status`, `family`, `repo`, `q`, `sort`, `sponsored`) |
| `/claims/[id]` | Claim detail, all states. JSON-LD and `<link rel="alternate" type="application/json">` to the agent brief, plus a dynamic OG image. |
| `/claims/[id]/evidence` | Submit evidence: direct or commit-reveal, reproduction fields, admissibility checklist from the policy, switch to Ethereum |
| `/compose` | Composer (`?draft=`, `?source=owner/repo@sha`, `?from=<claimId>`, `?policy=BOT-001`) |
| `/drafts` | Drafts and in-progress publications |
| `/dashboard` | Your claims, alerts, outcome positions, LP positions (in or out of range), redeemables |
| `/account` | GitHub sign-in (`read:user`) explained, SIWE wallet linking, defaults, notifications, theme, export, sign-out, delete |
| `/repos`, `/repos/[owner]/[repo]` | Repositories, then pull requests, then commits, then "Put this commit on the board" |
| `/policies`, `/policies/[id]` | Catalog and version detail (full text, hash, parameters, outcomes, gated SC-001) |
| `/activity` | Transaction history with funding and redemption reconciliation |
| `/agents` | Human guide to the agent API, with live links and a generated example brief |
| `/risks` (`/launch-gates` redirects here) | `COPY.disclosures` and `COPY.launchGates` |
| `/api/*`, `/llms.txt`, `/llms-full.txt`, `/.well-known/pine.json` | Shared `@pine/server` routes, mounted per `docs/frontend/integrating-an-app.md` |

## Running

```bash
pnpm install                         # at the repo root
pnpm --filter @pine/app-field dev    # http://localhost:3003
pnpm --filter @pine/app-field typecheck && pnpm --filter @pine/app-field lint && pnpm --filter @pine/app-field build
```

The app runs with zero env vars in mock mode: fixture data, a simulated wallet and a demo GitHub identity.

### Configuration

| Var | Effect |
|---|---|
| `NEXT_PUBLIC_PINE_DATA_SOURCE` | `mock` (default), `rest` or `envio` |
| `NEXT_PUBLIC_PINE_API_URL` / `NEXT_PUBLIC_ENVIO_GRAPHQL_URL` | Indexer endpoints for `rest` / `envio` |
| `NEXT_PUBLIC_SITE_URL` | Absolute URL for JSON-LD, agent briefs and OG tags (default `http://localhost:3003`) |
| `NEXT_PUBLIC_CHAIN_ID` | Default chain (100, Gnosis) |
| `NEXT_PUBLIC_PINE_DEMO_WALLET` | `1` forces the simulated wallet (on by default in mock mode) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Optional WalletConnect |
| `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `NEXT_PUBLIC_PINE_GITHUB_OAUTH=1` | GitHub OAuth. Without them, sign-in uses the demo identity. |
| `PINE_IPFS_UPLOAD_URL`, `PINE_IPFS_UPLOAD_TOKEN` | Server-side manifest pinning |

`next.config.ts` aliases the optional `@x402/*` modules (pulled in by RainbowKit's Base Account connector) to a stub so Turbopack can bundle.

## Screenshot QA

```bash
node qa/screens.mjs http://localhost:3003            # every route at 1440x900 and 390x844, saved to .qa/
node qa/screens.mjs http://localhost:3003 claim      # only routes whose name contains "claim"
```

The script appends `?qa=1`, which makes simulated transactions near-instant (`setDemoTxDelays`). It walks the composer (paste, pin, policy, then each stage, then publish to the manual liquidity step) and saves long pages in readable chunks. If the pinned Playwright browser build is missing, it falls back to any installed headless shell.

## Design notes

- Tokens live on `:root` in `src/app/globals.css` and are exposed to Tailwind 4 through `@theme inline`. A night theme follows `prefers-color-scheme`; Account offers a System/Light/Night override.
- The tension bar is driven by one registered CSS number, `--p` (`@property`), so it transitions on live ticks and "settles" on load with a CSS keyframe and no JavaScript. `prefers-reduced-motion` renders the final state.
- Countdown text uses a shared, hydration-safe clock (`src/lib/now.ts`), so server HTML never disagrees with the client.
- Untrusted content (evidence, PR titles, commit messages) renders as text or through `react-markdown` + `rehype-sanitize`. `javascript:` and `data:` links are dropped and long payloads collapse. The only `dangerouslySetInnerHTML` is the claim JSON-LD, built from our own data with `<` escaped.
- Language rules come from `@pine/core/copy`. There is no merge or deploy action anywhere, and approvals are exact-amount.
