# Pine Prism: design plan (v4)

Pine Prism is the fourth Pine frontend. The others are a light workbench, a light case file and a light survey board. Prism is the dark, luminous one. It is built around a single physical metaphor and uses motion to explain state.

## 1. Subject, audience, primary job

- **Subject.** Adversarial verification markets. One bounded claim about one pinned commit. A Seer market prices whether anyone demonstrates a reproducible counterexample before an absolute UTC deadline. Reality.eth answers, and Kleros arbitrates disputes.
- **Audience.** Customers who want to put a claim up for scrutiny. Investigators and agent operators looking for something to break. Reviewers judging whether the product earns trust.
- **Primary job.** Make one idea obvious at first sight and true on every screen: *a claim is held up to the light, and the market shows what the light does.*

## 2. Core metaphor

**A claim is a crystal. The market is light passing through it.**

| Product concept | Optical form |
|---|---|
| Composing a claim | Cutting a crystal. Each pinned input (commit SHA, policy and version, question, environment hash, deadline, oracle) cuts one facet. The input's hash seeds that facet's geometry and shading, so every crystal is unique and deterministic. |
| Publishing | Sealing the crystal. When `create_market` confirms, the terms freeze: the facets lock and a seal ring runs once. |
| Market price | A prism splitting one white beam into a **Yes beam** (Counterexample demonstrated), a **No beam** (No qualifying counterexample submitted) and a thin **Invalid result** sliver. Each beam's width is its price. |
| Discovery | A **light table**. Crystals sit around a vertical "now" slit. Size comes from liquidity, hue from policy family, and pulse rate from time left in the evidence window. |
| Resolved YES | The crystal **fractures**, with H-alpha light leaking through the crack. |
| Resolved NO | The crystal stays intact but **dims** to neutral Moonstone. It never brightens and never celebrates. |
| Resolved invalid | The crystal is **clouded**: frosted and milky. |
| Publishing (partial) | A partly cut crystal. Uncut facets are drawn as rough outline. |
| Failed | An unlit outline that was never cut. |

## 3. Palette: "Smoky quartz and emission lines"

The ground is a warm smoky-quartz umber, the color of a darkroom bench under a safelight. It is not near-black and not navy. The accent colors are named after **spectral emission lines**, which is what a spectrometer actually shows. They share one OKLCH lightness (about 0.78) and chroma (about 0.14), so they read as one family of light rather than a pile of accents.

Core base palette:

| Name | Hex | Role |
|---|---|---|
| **Umbra** | `#16110F` | Page ground. Warm smoky quartz. |
| **Lumen** | `#F5EDE4` | Text and white light. The primary action fill is "white light". |
| **H-alpha** | `#FF6B83` | YES / Counterexample demonstrated. Fracture light, blocking errors. |
| **Sodium** | `#FFB648` | Time pressure, "waiting for you", cautions. BOT family hue. |
| **H-beta** | `#5AD8FF` | Focus ring, links, live state. FUNC family hue. |
| **Moonstone** | `#A9B4C1` | NO / No qualifying counterexample submitted. Deliberately desaturated and dimmer than every other beam. |

Supporting tones:

| Name | Hex | Role |
|---|---|---|
| Void | `#0E0A09` | Hero well, footer, deepest wells |
| Smoke | `#201916` | Surfaces (smoked glass base) |
| Smoke 2 | `#2A211D` | Raised surfaces, inputs |
| Smoke 3 | `#352A25` | Hover / pressed |
| Lumen 2 | `#CDBFB3` | Secondary text |
| Lumen 3 | `#A69789` | Tertiary text (the lightest allowed text tone) |
| Calcium | `#B79AFF` | SC family hue (gated), commitments |
| Frost | `#DCD6E8` | Invalid result. Always rendered clouded (low alpha plus a noise fill), never as a solid beam. |
| Edge | `rgba(255,228,206,.11)` | 1px glass edges |
| Edge strong | `rgba(255,228,206,.22)` | Inputs and dividers that carry meaning |

**Spectrum** (used only where light is dispersed: the hero dispersion, the seal ring, the route-progress scan line and the active-nav glint): `#FF6B83 → #FF9A5C → #FFB648 → #E9DF75 → #7FE3A6 → #5AD8FF → #8FA2FF → #B79AFF`.

**Contrast.** Checked by script with WCAG relative luminance. On Umbra: Lumen 16.2, Lumen 2 10.4, Lumen 3 6.6, H-alpha 6.9, Sodium 10.7, H-beta 11.3, Calcium 8.1, Moonstone 8.9. On Smoke 3, the worst surface, Lumen 3 is 4.9 and H-alpha is 5.1. Umbra on a Lumen button is 16.2. Every text pairing passes AA.

**Outcome color rules (spec §8).** YES is H-alpha, because it is bad news for the code. NO is Moonstone: neutral, dim, no checkmark, no glow. Invalid is clouded Frost. No green appears in any outcome. The only green in the system is a single stop inside the dispersed spectrum.

**Material.**
- Smoked glass: a vertical lumen gradient at 5.5% to 2.5% over Smoke, a 1px Edge, and a top-edge highlight.
- `backdrop-filter` only on floating layers (header, dialogs, popovers).
- A static SVG grain covers the page at about 6% opacity.
- Two fixed "light leaks" sit at the page corners: a Sodium radial top-left and an H-alpha radial top-right, at 4–7% opacity. They never sit under body text at a strength that changes contrast.

## 4. Type

| Face | Role | Why |
|---|---|---|
| **Geologica** (variable: wght, SHRP, CRSV) | Display and headings, set **cut**: `SHRP 100`. Hero at wght 300, section heads at 400, card titles at 560. | Its *Sharpness* axis sharpens joins and terminals into cut spurs. The effect is subtle at text sizes and visible at display sizes. The composer animates the claim title's SHRP (and weight) as facets are cut. |
| **Instrument Sans** (variable: wght, wdth) | Body and UI at wdth 100. Condensed (wdth 82) only for dense figures in tables. | A refined, slightly narrow grotesque that stays crisp in light-on-dark. Its quiet texture contrasts with the cut display. |
| **Azeret Mono** | Only literal bytes: SHAs, hashes, addresses, commands, Markdown and curl. Never labels. | Clear 0/O and 1/l, with a slightly wide set that reads well light-on-dark. |

Scale (16px base, classical sizes, rem in CSS):

| Token | Size / leading | Face |
|---|---|---|
| display | clamp(44px, 7.4vw, 96px) / 0.98, tracking −0.035em | Geologica 300, SHRP 100 |
| h1 | clamp(36px, 4.6vw, 60px) / 1.02, −0.03em | Geologica 340 |
| h2 | clamp(28px, 3vw, 40px) / 1.08, −0.02em | Geologica 400 |
| h3 | 21px / 1.25 | Geologica 560 |
| lead | 19px / 1.55 | Instrument Sans 400 |
| body | 16px / 1.6, measure ≤ 68ch | Instrument Sans 400 |
| ui | 15px / 1.45 | Instrument Sans 500 |
| small | 13.5px / 1.45 | Instrument Sans 450 |
| figure | Geologica 300 tabular, sized per use (price numerals 44–72px) | |
| code | 13px / 1.55 | Azeret Mono 400 |

Rules:
- Sentence case everywhere and no all-caps eyebrows.
- No middle-dot meta strings. Metadata is laid out as separate small blocks.
- No arrows appended to links.
- Display sizes (≥ 44px) get a sub-pixel chromatic edge: H-beta −0.6px and H-alpha +0.6px text-shadows at 35%. It reads as glass, not as glitch.

## 5. Shape and layout language

- **Bevel cut.** Primary surfaces and buttons have two opposite corners cut (top-left and bottom-right), like a baguette-cut gem: `border-radius` plus `corner-shape: bevel`. Borders and focus outlines follow the bevel. Browsers without `corner-shape` fall back to small rounded corners, so nothing breaks.
- **Corner size follows hierarchy.** Hero and claim panels cut 18px, panels 12px, buttons 8px, chips 5px, inputs 6px (rounded, not cut).
- **Left-aligned content.** The only centered element is the "now" slit on the light table.
- **Wide margins.** A 1240px content column with a 16px gutter on phones.
- **No identical card grids.** Lists are rows of light, with a glyph, a title, a beam and the time left. Panels differ in size and cut by importance.

## 6. Motion system

Motion must answer the user or explain state. It is never ambient decoration, except for the single hero sequence.

| Token | Value | Use |
|---|---|---|
| `--dur-press` | 120ms | Button and chip press |
| `--dur-hover` | 200ms | Hover and focus glints |
| `--dur-panel` | 360ms | Panels, popovers, route content |
| `--dur-facet` | 640ms | One facet cut |
| `--dur-seal` | 1400ms | Publish seal |
| `--ease-refract` | `cubic-bezier(.16,1,.3,1)` | Entrances and beam growth |
| `--ease-glint` | `cubic-bezier(.65,0,.35,1)` | Sweeps and glints |
| `--ease-settle` | `cubic-bezier(.34,1.56,.64,1)` | Facet lock (small overshoot) |
| spring (motion) | stiffness 420, damping 32 | Toggles, chips, nav indicator |

**Orchestrated moments:**

1. **Landing hero** (WebGL, about 2.8s, once per visit):
   - 0–0.6s: a white beam draws in from the left.
   - 0.3–1.5s: the crystal assembles from its facets and settles.
   - 1.5–2.1s: the beam hits it and disperses into a full spectrum fan.
   - 2.1–2.8s: the fan resolves into the three outcome beams, sized from PINE-0009's live price.
   - Alongside: the headline is lit by one caustic sweep, and the readout numbers roll up.
   - Afterwards the crystal turns slowly (one revolution every 40s) and pauses when offscreen or when the tab is hidden.
2. **Scroll story** ("Follow the light through a claim"): a sticky optical diagram changes state as each of seven steps scrolls into view (commit → policy → question → market → evidence → oracle → outcome). A beam down the step column fills with scroll progress.
3. **Facet cut** (composer): when an input is pinned, its facet fills from outline, a glint crosses it, the matching hash chip flashes, and the crystal title gains sharpness.
4. **Seal** (publish): when `create_market` confirms, the facets lock with a small overshoot, a spectrum ring expands once, and the crystal brightens. "Terms frozen" appears alongside, so the motion is never the only signal.
5. **Fracture** (resolved YES): on first view, a crack draws across the crystal, the two halves part by about 3px, and H-alpha light leaks through.
6. **Price transitions:** beam widths morph and figures roll to new values when the market updates.
7. **Route transitions:** content fades in from a slight blur. A thin spectrum scan line runs across the header while a route loads.

Micro-interactions:
- Buttons compress on press, and the white-light button shows a glint on hover.
- The copy action morphs into a check.
- Chips spring into place.
- The nav indicator is a small dispersed beam that slides between items.
- Hovering or focusing a crystal on the light table opens a glass card.

**Reduced motion** (`prefers-reduced-motion: reduce`, checked in CSS and with `useReducedMotion`):
- Hero: WebGL is not loaded. The SVG poster of the final state is shown instead (same composition, same live beam widths).
- Story: steps switch instantly. The progress beam is static.
- Facet cut, seal and fracture: show the end state with no movement. Text says what happened.
- Numbers and beams update instantly.
- Pulses on the light table stop. Time left is still encoded by a dashed ring, so no information is lost.
- Route transitions and blur are disabled.
- No smooth-scroll library is used at all, so scrolling stays native.

## 7. 3D and asset plan

- **WebGL, hero only.** It uses three.js through @react-three/fiber and drei, loaded with `next/dynamic` (`ssr: false`) behind an SVG poster.
  - Before importing, it checks for WebGL2/WebGL support, runs only when there is no reduced-motion preference, and loads after the poster has painted (idle callback).
  - A `<Canvas>` error boundary falls back to the poster.
  - DPR is capped at 1.75, and `frameloop` is switched to `never` when the canvas is offscreen (IntersectionObserver) or the tab is hidden.
- **Crystal geometry.** `ConvexGeometry` is built from hash-seeded points arranged as an elongated hexagonal quartz point with a termination, so each seed gives a unique gem.
  - Facets fly in through a per-triangle vertex offset patched into the material (`onBeforeCompile`).
  - **Glass (revised during QA).** A transmission pass rendered opaque in software GL and is costly on low-end GPUs. The glass is faked instead:
    - a tinted back shell (the policy-family hue);
    - an additive, iridescent front shell that only adds reflections;
    - an additive inner core glow;
    - edge lines;
    - a breathing glow pooled behind the crystal.

    The result looks the same on every GPU.
  - The environment map is built from narrow drei `Lightformer` strips in Sodium, H-beta, H-alpha and white, so facets catch light as the crystal turns. No HDR files or external hosts are needed.
- **Beams.** Additive-blended planes with a custom shader: a soft gaussian falloff across the width, a fade along the length and a slow shimmer. One spectrum fan is used for the dispersion moment.
- **SVG crystal generator** (`lib/crystal.ts`). This deterministic 2D quartz silhouette powers the light table, lists, claim header, composer, OG images and the posters.
  - It has 8 facets, and per-facet shading comes from the bytes of the input hashes.
  - States: luminous, partial, dim, frosted, fractured (seeded crack polyline and shard offset) and unlit.
- **Custom icons.** Hand-drawn SVG icons in one style (1.5px stroke, faceted geometry):
  - three policy families: FUNC as a bracketed facet, BOT as a gear-cut facet, SC as a locked shard;
  - three outcomes: fractured, dimmed and clouded;
  - seven story steps.
- **Textures.** SVG `feTurbulence` grain as a data URI, a frost noise for invalid, and radial light leaks. Everything is in code.
- **OG images** (`next/og`):
  - a site card with the prism split;
  - a per-claim card with the claim's own crystal (from its manifest hash) and its live beam split, or its fractured, dimmed or clouded end state.
  - Static Geologica instances are committed in `src/assets/fonts`.
- **Favicon.** A small prism with one beam in and three beams out.

## 8. Wireframes

### Landing
```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◭ Pine Prism   Light table  Compose  Repos  Policies  Agents   ⌁wallet  [Compose a claim] │
│ ░ demo strip: sample data and a simulated wallet   [Fail the next tx] [×] │
├──────────────────────────────────────────────────────────────────────────┤
│                                   ┊                                      │
│  Hold your claim                  ┊         ╱╲                           │
│  up to the light.                 ┊  ━━━━━━╱  ╲━━━━━━━━  Yes beam (H-α)  │
│                                   ┊       ╱ ◇◇ ╲───────  No beam (Moon) │
│  Lead paragraph (≤ 60ch) on       ┊      ╱______╲·······  Invalid (frost)│
│  solid Umbra                      ┊   WebGL crystal (poster first)       │
│  [Compose a claim] [Open the light table]                                │
│  ┌ live readout: PINE-0009  title  Yes 31.0%  No 66.0%  Invalid 3.0%  2d 4h ┐ │
├──────────────────────────────────────────────────────────────────────────┤
│ Follow the light through a claim                                         │
│ ┌──────── sticky diagram ────────┐  │1 Commit   text panel               │
│ │ crystal / beams / lenses change │  │2 Policy                            │
│ │ state per step                  │  │3 Question  (exact template)        │
│ └─────────────────────────────────┘  │4 Market … 7 Outcome                │
├──────────────────────────────────────────────────────────────────────────┤
│ On the light table now: mini constellation of real claims  [Open]        │
├──────────────────────────────────────────────────────────────────────────┤
│ Three ways a claim ends: fractured / dimmed / clouded, exact wording     │
├──────────────────────────────────────────────────────────────────────────┤
│ Investigators and agents: curl + llms.txt + brief      What this is not  │
├──────────────────────────────────────────────────────────────────────────┤
│ footer                                                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

### Light table
```
┌──────────────────────────────────────────────────────────────────────────┐
│ Light table          [Search claims, repos, SHAs…]   (Constellation|List)│
│ Status: (Open)(Oracle)(Contested)(Resolved)(Unfinished)  Family: ◆FUNC ◆BOT ◆SC  Sort ▾ │
├──────────────────────────────────────────────────────────────────────────┤
│ 100% ┊ past the deadline            ┃ now ┃            deadline ahead    │
│      ┊   ◇ fractured                ┃     ┃   ✦ (pulses faster near now) │
│ Yes  ┊        ◇ clouded             ┃     ┃       ✦     ✦                │
│ price┊  ◇ dimmed       ◇ disputed   ┃     ┃  ✦              ✦  (size = liquidity)│
│   0% ┊ −30d                         ┃     ┃                         +30d │
│  [glass card on hover/focus: title, repo@sha, mini prism, time left]     │
├──────────────────────────────────────────────────────────────────────────┤
│ Rows (the accessible list, always available):                           │
│ ◇  PINE-0009  Reporter deposits never draw…   kleros/gateway… 3f2a1c9   │
│    BOT-001  ▬▬▬▬▬▬▬▬▬▬▬ Yes 31%  ────── No 66%   closes in 2d 4h         │
└──────────────────────────────────────────────────────────────────────────┘
```

### Claim
```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◇ crystal (state)   PINE-0009   BOT-001@0.1.0   Open for evidence         │
│                     Reporter deposits never draw principal from…         │
│                     kleros/gateway-balancer-bot  3f2a1c9  PR #47          │
├─────────────────────────────────────────────┬────────────────────────────┤
│ PRISM: white beam → prism → Yes / No / Inv.  │ What happens next          │
│ widths = price, labels at beam ends,         │ who acts, by when (live)   │
│ price label + caveat                         │ [Submit evidence] [Seer]   │
├─────────────────────────────────────────────┤ Your position / Redeem     │
│ ▸ Question ▸ Market ▸ Evidence ▸ Oracle ▸ Agent ▸ Activity (sticky glass)│
│ Question text (Instrument Sans 19px) + facet refs with copy              │
│ Market: price chart (range), depth (Yes|No), price impact                │
│ Evidence feed (inert)  Oracle path: answers, bonds, timeout, Kleros      │
│ Agent brief (Markdown, curl)   Activity                                  │
└─────────────────────────────────────────────┴────────────────────────────┘
```

### Composer
```
┌──────────────────────────────────────────────────────────────────────────┐
│ Compose a claim                                   Draft saved 14:02 UTC  │
├───────────────────────────┬──────────────────────────────────────────────┤
│ Cutting bench (sticky)    │  Stage 3 of 8: Claim                         │
│        ╱╲                 │  Title ______________________________        │
│       ╱◆◆╲   facets light │  Requirement ________________________        │
│      ╱◆◇◇◆╲  as inputs    │  Violation __________________________        │
│      ╲◆◇◇◆╱  are pinned   │  Live question preview (reads as the         │
│       ╲__╱                │  market will read it)                        │
│ ◆ Commit     3f2a1c9…     │                                              │
│ ◆ Policy     BOT-001@0.1.0│                                              │
│ ◇ Question   —            │                     [Back] [Continue]        │
│ ◇ Environment …           │                                              │
│ ◇ Deadline  ◇ Oracle      │                                              │
│ Facet rail: Source ◆ Policy ◆ Claim ◇ Env ◇ Deadlines ◇ Funding ◇ Review ◇ Publish │
└───────────────────────────┴──────────────────────────────────────────────┘
```
On phones the bench collapses into a sticky strip: a 56px crystal, the stage name and progress.

## 9. Principles

1. **One metaphor, used literally.** A crystal and a beam of light. Every visual device is a facet, a beam, a slit, a lens, a fracture, a cloud or a dim. Nothing is decoration without a referent.
2. **Light is information.**
   - Brightness means live.
   - Width means price.
   - Hue means policy family.
   - Pulse means time pressure.
   - A fracture means a counterexample.
   - Dimness means NO.
   - Cloudiness means invalid.
3. **Text never sits on moving light.** Copy lives on solid Umbra or smoked glass. Beams and WebGL sit beside text, never under it.
4. **Motion explains.** Every animation either answers an action or shows a state change. The hero is the one exception, and it plays once.
5. **Honest numbers.** Every price carries its exact label. Every amount says what is at risk, what is spent and who pays.
6. **Fully usable in the dark.** Everything works without WebGL, without JavaScript animation and with reduced motion. The SVG fallbacks are designed, not apologetic.

## 10. How this differs from Console, Docket and Field

| | Console (v1) | Docket (v2) | Field (v3) | **Prism (v4)** |
|---|---|---|---|---|
| Theme | Light frost, pine green | White sheets, stamp violet | Fog grey, indigo ink | **Dark-first warm smoky-quartz umber with emission-line spectral colors** |
| Material | Flat panes, 1px rules, tick marks | Paper sheets on a grey counter | Flat glyph tiles, hatching | **Smoked glass, bevel-cut gem corners, grain, light leaks, chromatic edges** |
| Type | Archivo + Martian Mono | Atkinson Hyperlegible + Source Serif | Anybody expanded + Archivo | **Geologica cut with its Sharpness axis, Instrument Sans, Azeret Mono** |
| Metaphor | Precision instrument graduations | Case file and exhibits | Field of play and data glyphs | **Crystal and light: cutting, sealing, dispersion, fracture** |
| Price glyph | Ruler ticks | Plain figures with caveats | Tension bar (rope and knot) | **Prism beam split, with beam widths equal to prices** |
| Discovery | Dense sortable table | Docket grouped by stage | Board of tiles, map | **Light table around a "now" slit: crystals by deadline and price** |
| Composer | Split pane with live artifacts | 8-step filing wizard | Sentence builder | **Cutting bench: each pinned input cuts a hash-seeded facet; publishing seals it** |
| Motion | Minimal | Minimal | Settle animations on glyphs | **WebGL hero, scroll story, facet cut, seal, fracture, beam morphs, route transitions** |
| Outcome NO | Neutral slate | Held grey band | Solid cobalt | **Dimmed Moonstone crystal, darker than any live state** |

The headline structures are also different. Prism does not use "Pin a commit…", "Put one claim…" or "Every claim here is an open challenge". Its hero is the idiom **"Hold your claim up to the light."**

## 11. Revised away from defaults

The first instincts and what replaced them:

- **Ground.** Near-black navy with neon cyan-magenta gradients is the crypto default and close to the brief's purple-to-blue warning. It was replaced by a warm smoky-quartz umber. All spectral colors sit at equal OKLCH lightness, and gradients appear only as actual light (beams and dispersion), never as washes behind content.
- **Hero.** Gradient-filled headline text was replaced by Lumen text with one caustic light sweep on load. The headline stays a solid color and readable.
- **Display face.** Syne, Unbounded and Space Grotesk all read as "creative tech" defaults. Geologica's Sharpness axis was chosen because the faceting means something here.
- **Layout.** A floating pill nav over a bento grid of identical rounded cards was replaced by a full-width glass header with a dispersed-beam indicator, bevel-cut panels sized by hierarchy, and rows of light for lists.
- **NO beam.** A cool cyan NO beam looked like a positive result. It became desaturated Moonstone, dimmer than every live beam.
- **Live price.** A big number with a small label and a gradient accent was replaced by the price as beam widths. The figure sits at the end of its beam.
- **3D.** WebGL on every page was cut back to the hero only. The SVG generator handles everything else, which is faster, accessible and crisp.
- **Smooth scrolling.** A Lenis smooth-scroll page was dropped. Native scroll plus sticky storytelling keeps scroll, anchors and assistive tech honest.
- **Labels.** Mono labels and all-caps eyebrows on every section were removed. Mono is only for literal bytes, labels are sentence case, and a label appears only when the value would otherwise be ambiguous.
