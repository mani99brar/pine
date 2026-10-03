# Pine Prism (v4)

The fourth Pine frontend, at `apps/prism` on port 3004. It is dark-first and luminous, and it is built around one metaphor: **a claim is a crystal, and the market is light passing through it.**

Pine lets a customer pin an exact commit, publish one bounded, policy-versioned claim about it, and fund a Seer prediction market. The market rewards independent investigators, human or agent, for demonstrating a reproducible counterexample before an absolute UTC deadline. Reality.eth answers the question and Kleros arbitrates disputes. NO is not proof of correctness.

The full design plan is in [DESIGN.md](DESIGN.md): palette, type, motion system, 3D and asset plan, wireframes, and how this version differs from Console, Docket and Field.

## Concept at a glance

| Product | Prism |
|---|---|
| Composing a claim | Cutting a crystal. Each pinned input cuts one facet, shaded by that input's hash. |
| Publishing | Sealing. When the market is created the terms freeze, the facets lock and a seal ring runs once. |
| Price | A prism splits one white beam into Yes (Counterexample demonstrated), No (No qualifying counterexample submitted) and a thin Invalid-result sliver. The beam widths are the prices. |
| Discovery | A light table. Crystals sit around a vertical "now" slit: height is the Yes price, size is liquidity, hue is the policy family, and the glow pulses faster as the deadline nears. |
| Outcomes | YES fractures the crystal. NO leaves it whole but dimmed. Invalid clouds it. |

Look and feel:
- **Ground and color.** A smoky-quartz umber ground, with accent colors named after spectral emission lines: H-alpha, Sodium, H-beta and Calcium, plus Moonstone and Frost.
- **Type.** Geologica, set "cut" with its Sharpness axis, for display. Instrument Sans for the interface. Azeret Mono only for literal bytes.
- **Materials.** Smoked-glass panels with bevel-cut corners (`corner-shape: bevel`, falling back to rounded corners), plus grain and light leaks.

## Signature interactions and motion

All motion respects `prefers-reduced-motion`. In reduced mode each moment shows its end state, and text always states what happened.

1. **Hero sequence (WebGL).**
   - A white beam draws in, a hash-seeded crystal assembles from its facets, and the light disperses into a spectrum fan. The fan resolves into three outcome beams sized from PINE-0009's live market.
   - Alongside: a single caustic sweep crosses the headline, and the readout numbers roll up.
   - Afterwards the crystal turns slowly and leans toward the pointer. It pauses when offscreen or when the tab is hidden.
2. **Scroll story.**
   - Seven steps run from commit, policy and question, through market, evidence and oracle, to the outcome.
   - A sticky optical diagram changes state as each step comes into view, and a progress beam fills with scroll.
   - On phones each step carries its own diagram.
3. **Facet cutting** (composer, `/compose`).
   - A cut facet fades in with a glint, and its hash shows in the facet list.
   - The claim title gains Sharpness and weight as facets are cut.
4. **Seal.** When `create_market` confirms, the crystal brightens, its edges lock and a spectrum ring expands once. "Sealed: terms frozen" is shown in text as well.
5. **Fracture.** A resolved-YES crystal cracks on first view: the halves part, and H-alpha light leaks through the crack.
6. **Price beams.** Beam widths morph and figures roll to new values when the market updates. Charts draw their Yes line in.
7. **Route transitions.** Content comes into focus from a slight blur, and a spectrum scan line runs across the top while a route loads.
8. **Micro-interactions.**
   - The white-light button has a hover glint, and buttons compress on press.
   - Segmented controls slide.
   - Copy morphs into a check.
   - The navigation indicator is a dispersed beam that slides between items.
   - Light-table crystals open a glass card on hover or focus.

## 3D and assets

- **WebGL.** It is used only in the hero, through three.js, @react-three/fiber and drei.
  - **Loading.** It loads with `next/dynamic` (`ssr: false`) only when WebGL is available and motion is allowed.
  - **Fallbacks.**
    - An error boundary or a lost WebGL context falls back to the SVG poster.
    - So does a 4.5 s timeout, after which the poster plays its own CSS reveal.
    - Without JavaScript, a `<noscript>` style reveals the poster.
  - **Performance.** DPR is capped at 1.75, and `frameloop` is set to `never` when the canvas is offscreen or the tab is hidden.
  - **Crystal.** The geometry is a `ConvexGeometry` built from hash-seeded points. Facets fly in through a vertex offset patched into the material.
  - **Glass.** The glass is faked, with no transmission pass: a tinted back shell, an additive iridescent front shell, an inner glow and edge lines. It looks the same on every GPU and stays cheap.
  - **Light.** Beams use a custom additive shader, and the floor uses a procedural caustic shader. The environment map is built from drei `Lightformer`s, so no HDR file is loaded.
- **SVG crystal generator** (`src/lib/crystal.ts`, `src/components/crystal/CrystalGlyph.tsx`). A deterministic double-terminated quartz point with nine facets, one per pinned input.
  - States: luminous, settling, partial, dim, frosted, fractured and unlit.
  - It powers the light table, rows, claim headers, the composer, the posters and the OG images.
- **Icons.** A hand-drawn set (`src/components/icons`) covers policy families, outcomes and story steps, plus the prism mark and favicon.
- **Textures.** Grain, frost noise and light leaks are inline SVG or CSS. There are no stock images and no external image hosts.
- **OG images** (`next/og`).
  - A site card.
  - A per-claim card showing the claim's own crystal and its beam split, or its fractured, dimmed or clouded ending.
  - Static Geologica and Instrument Sans instances are committed in `src/assets/fonts` (SIL Open Font License).

## Routes

| Route | Page |
|---|---|
| `/` | Landing: hero, scroll story, live light-table preview, endings, agents, what Pine is not |
| `/claims` | Light table (constellation and list), with filters, search and sort |
| `/claims/[id]` | Claim in every state. JSON-LD and an `application/json` alternate link |
| `/claims/[id]/evidence` | Submit evidence (direct or commit-reveal) |
| `/compose` | Composer: source, policy, claim, environment, deadlines and oracle, funding, review, publish |
| `/drafts` | Drafts and unfinished publications |
| `/dashboard` | Positions, liquidity positions, redeemables, alerts and your claims |
| `/account` | GitHub sign-in (`read:user`), SIWE wallet linking, preferences, export, delete and sign out |
| `/repos`, `/repos/[owner]/[repo]` | Repositories, then pull requests and commits, then start a claim |
| `/policies`, `/policies/[id]` | Policy catalog and detail (SC-001 shown, gated) |
| `/activity` | Activity ledger with reconciliation |
| `/agents` | Agent API guide with a live sample brief |
| `/risks` | Disclosures (`COPY.disclosures`) and launch gates (`COPY.launchGates`) |
| `/launch-gates`, `/table`, `/new` | Redirects to `/risks#gates`, `/claims` and `/compose` |

Server routes are mounted exactly as described in `docs/frontend/integrating-an-app.md`:
- `/api/auth/*`
- `/api/github/*`
- `/api/account/*`
- `/api/agent/*`
- `/api/ipfs`
- `/llms.txt` and `/llms-full.txt`
- `/.well-known/pine.json`

## Running

```bash
pnpm install
pnpm dev:prism                                 # http://localhost:3004 (mock data, demo wallet, demo sign-in)
pnpm --filter @pine/app-prism typecheck
pnpm --filter @pine/app-prism lint
pnpm --filter @pine/app-prism build && pnpm --filter @pine/app-prism start
node scripts/smoke.mjs http://localhost:3004   # crawl, agent endpoints, forbidden wording
```

Environment variables are listed in `.env.example`, and the shared ones are described in `docs/frontend/integrating-an-app.md`. With no variables set, the app runs entirely in demo mode:
- sample fixtures;
- a simulated wallet, with a "Fail the next transaction" control in the demo strip;
- a demo sign-in identity.

Add `?qa=1` to any URL to make simulated transactions near-instant for that browser session.

## QA scripts

QA uses Playwright with Chromium. Output goes to `.qa/`.

| Command | What it does |
|---|---|
| `node qa/screens.mjs [--mobile] [--reduced] [--nowebgl] [--only=name] [--skip-compose]` | Every route and key claim state, signed-in account and dashboard, the mobile nav, and the full composer journey. The journey covers every stage, a simulated failure, reload and resume, manual DEX steps and the seal. Writes a JSON report of console errors and horizontal overflow. |
| `node qa/motion.mjs hero\|story\|fracture` | Frame sequences of the motion moments. |
| `node qa/sheet.mjs <prefix> [cols] [out] [crop]` | Contact sheet of captured frames. |
| `node qa/peek.mjs /path name [--mobile] [--reduced] [--nowebgl] [--full]` | One-off capture. |
| `node qa/anchor.mjs /path sectionId name` | Captures a section of a page. |
