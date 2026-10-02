# Pine Field — design system

Version 3 of the Pine frontend. **"The open challenge board."**

Pine Field treats every published claim as a live position on a field of play. Investigators, traders and
agent operators scan the board to see which claims are under the most market tension, which evidence windows
close soonest and where depth is thin. Customers pin a claim to that board and watch it live. The data
glyphs are the hero. Everything around them stays quiet.

## 1. Subject, audience, primary job

- **Subject:** adversarial verification markets. One bounded claim about one pinned commit, and a market
  that prices whether anyone will demonstrate a reproducible counterexample before an absolute UTC deadline.
- **Audience:** investigators (human and agent) and traders who want to find claims worth examining.
  Customers who want glanceable live tracking.
- **Primary job:** make the state of each claim legible at a glance (tension, time, depth, policy), then
  get out of the way so people can investigate, trade or publish.

## 2. Palette

Light "survey sheet" ground with two saturated data hues chosen as a colour-blind-safe pair (orange vs
ultramarine stay distinct under deuteranopia, protanopia and tritanopia, and differ in luminance too).
Neither hue means good or bad. A YES (counterexample) is bad news for the code but is not an alarm. A NO is
a neutral "held" result, never a success state.

| Token | Hex | Role |
|---|---|---|
| **Fog** | `#ECEEF2` | Page ground. Cool survey paper, never cream. |
| **Sheet** | `#FFFFFF` | Surfaces that hold content (tiles, panels, inputs). |
| **Ink** | `#161A33` | Text, strokes, primary buttons. A deep indigo ink rather than tinted black. |
| **Flare** | `#FF5A1F` (fill) / `#B93A0A` (text) | YES: *Counterexample demonstrated*. Always paired with a 45° hatch so it reads without colour. |
| **Cobalt** | `#2B44FF` (fill and text) | NO: *No qualifying counterexample submitted*. Solid fill: "held", neutral. |
| **Lumen** | `#FFC21A` (fill) / `#7A5100` (text) | Time pressure: evidence window under 24 h, the demo banner, focus halo. |

Supporting neutrals are derived from Ink (`ink-2 #474D6B`, `ink-3 #5F6582`, `line rgba(22,26,51,.14)`).
**Invalid** uses `slate #737891` with a cross-hatch. All text pairs meet WCAG AA on Sheet and Fog (checked by
script; ink-3 is the lightest text colour allowed on Fog).

A dark "night field" theme mirrors the tokens (`ground #0E1330` deep indigo, sheet `#161C43`, ink `#EEF0FF`,
Flare `#FF7A45`, Cobalt `#8C9BFF`). It follows `prefers-color-scheme`, and a toggle in Settings overrides it.

## 3. Type

| Face | Role | Why |
|---|---|---|
| **Anybody** (variable: wdth 50–150, wght) | Display only. Headlines are set *expanded* (wdth 120–140, wght 750–850). | The width axis makes headlines feel like stadium signage stretched across the field. It is the brand's voice. |
| **Archivo** (variable: wdth 62–125, wght) | UI and body at wdth 100. Figures set *condensed* (wdth 72, wght 700, tabular) inside glyphs. | Sturdy grotesque with real tabular figures. Condensed numerals fit long prices into small glyphs without shrinking. |
| **JetBrains Mono** | Only for actual code: SHAs, hashes, commands, curl. | Unambiguous 0/O and 1/l for values people copy into terminals. Never used for labels. |

Scale (16 px base, ~1.25 ratio, line-heights per Bringhurst: tighter for display, 1.55 for body):

| Step | Size / line | Face |
|---|---|---|
| display-xl | 72/0.92 (mobile 42) | Anybody 820, wdth 135, tracking −0.02em |
| display-l | 48/0.98 (mobile 32) | Anybody 780, wdth 125 |
| h1 | 34/1.05 | Anybody 760, wdth 118 |
| h2 | 24/1.15 | Anybody 720, wdth 112 |
| h3 | 18/1.3 | Archivo 650 |
| body | 16/1.55 | Archivo 400, measure ≤ 72ch |
| small | 14/1.45 | Archivo 450 |
| micro | 12.5/1.35 | Archivo 550, sentence case |
| figure-l | 44/1 | Archivo 760, wdth 72, tnum |
| figure | 22/1 | Archivo 720, wdth 75, tnum |
| code | 13.5/1.5 | JetBrains Mono 450 |

No all-caps eyebrows. Labels are sentence case. Meta strings are separated by space and weight, not middle dots.

## 4. Glyphs (the hero)

### Tension bar

The YES/NO split as a rope held between two anchors. The knot sits at the market-implied chance.

```
  15.3%                                  84.7%
  ┃▨▨▨▨▨▨▨ ┃ ███████████████████████████████┃
  ┃        ╹▲ +2.1 pts (24h)                ┃
  anchor   knot   ghost┆                   anchor
```

- Left anchor to knot: **Flare** with a white 45° hatch (YES, counterexample demonstrated).
- Knot to right anchor: **Cobalt** solid (NO, none submitted).
- **Knot**: a 3 px Ink post that overshoots the bar by 4 px above and below, flanked by 2 px Sheet gaps, so
  the two sides look pulled apart.
- **24 h move**: a dashed Ink ghost post at the price 24 h ago, plus a chevron trail from ghost to knot.
  The delta is labelled in percentage points ("+2.1 pts in 24 h").
- Sizes: `sm` (8 px bar, list rows), `md` (14 px, tiles), `lg` (28 px with in-bar labels, claim header).
- States: no market (dashed outline, "No market yet"); resolved YES/NO collapses to the final side with the
  canonical outcome copy; invalid uses a slate cross-hatch labelled "Resolved invalid".
- Motion: on board load the knot travels from the 50 % mark to its price (700 ms, ease-out, staggered in
  one diagonal wave across the grid). On a live price change it glides (400 ms) and emits a single pulse
  ring. Under `prefers-reduced-motion` it renders in place.
- a11y: `role="img"` and `aria-label="Market-implied chance a qualifying counterexample is accepted: 15.3%, up
  2.1 points in 24 hours"`.

### Time ring

The evidence window as a draining dial.

```
   ╭───╮     arc = remaining / total window, clockwise from 12 o'clock
  │ 2d │     one tick per day of the window (up to 14)
  │ 4h │     Ink arc; Lumen arc and Lumen-ink label under 24 h
   ╰───╯     dashed and empty once the window has closed ("closed")
```

It is reused for the oracle challenge window, with a Cobalt dotted arc labelled "answer finalizes".
Its `aria-label` gives the remaining time and the absolute UTC close.

### Depth bars

Executable liquidity, shown as signal-strength bars rather than a headline TVL figure.

```
  ▁ ▂ ▄ ▆ █   ≈ 340 sDAI within 5 pts
  1 2 5 10 20  (price bands, in points from mid)
```

- Five bars give the collateral executable within ±1, ±2, ±5, ±10 and ±20 points of mid, read from the
  depth book. Height is log-scaled against a 2,000-unit reference.
- Bars under 50 units are drawn as outlines only: thin depth is visible as hollowness.
- The caption names the ±5 pt figure, which is what a modest trade can actually move through.

### Policy marks

Shape plus code, so they never depend on colour: FUNC is a **circle** (input/output), BOT is a **hexagon**
(machinery), SC is a **diamond** (contract). A gated policy (SC-001) is drawn as a dashed diamond with a
padlock bar and the gate copy.

## 5. Layout concept

Left-aligned throughout. A 12-column fluid grid, 1280 px max content width, 24 px gutters (16 px at 360 px).
Tiles are flat Sheet rectangles with a 3 px radius, a 1 px line and **no shadow**. Hierarchy comes from the
glyphs and type weight, not elevation. Radius follows hierarchy: chips are pills, buttons 6 px, tiles 3 px,
page sections 0.

### Board (Explore)

```
┌ Pine Field   Board  Repos  Policies  Agents         [Put a claim on the board] [wallet] ┐
├ demo strip (Lumen): fixture data, simulated wallet   [fail next tx ○]            [×]   ┤
│ The board                                   14 open  3 close in 24 h  2,140 sDAI ≤5pts │
│ [⌕ search claims, repos, SHAs      ] (Open ×)(BOT ×)(+ policy)(+ repo)   Sort ▾  ▦ ☰   │
├───────────────────┬───────────────────┬───────────────────┬───────────────────┤
│ PINE-0042    ⬡BOT │ PINE-0039   ◯FUNC │ …                 │                   │
│ Reporter deposit  │ Parser rejects…   │                   │                   │
│ never uses arb…   │                   │                   │                   │
│ ┃▨▨▨┃██████████┃  │ ┃▨▨▨▨▨▨▨┃█████┃   │                   │                   │
│ 15.3%   ▲2.1      │ 41.0%  ▼0.6       │                   │                   │
│ ◔ 2d 4h  ▁▂▄▆█ 340│ ◔ 19h   ▁▂▃▅▆ 90  │                   │                   │
│ kleros/gateway…   │ acme-labs/fast…   │                   │                   │
└───────────────────┴───────────────────┴───────────────────┴───────────────────┘
mobile: single column stack; filters in a horizontal scroll strip; glyphs keep full width.
```

### Claim page

```
┌ PINE-0042  ⬡ BOT-001@0.1.0  [Open: evidence window]                                 ┐
│ Reporter-deposit principal never uses arbitration or gas reserves   (Anybody h1)      │
│ "Was a reproducible counterexample demonstrating … against commit a1b2c3d …?"         │
│ ┃▨▨▨▨▨▨┃████████████████████████████████████┃   (tension lg)   ◔ 2d 4h   ▁▂▄▆█        │
├──────────────────────────────────────────────┬──────────────────────────────────────┤
│ Price chart  [24h 7d 30d all]                │ Next: investigators submit evidence  │
│  ⎺⎺⎺\__/⎺⎺ ●E1 ●E2 ┆deadline                   │ Price-impact simulator  ──●───────   │
│ Depth chart (bids | asks)                    │ Your position / redeem               │
├──────────────────────────────────────────────┴──────────────────────────────────────┤
│ [Investigate] [Evidence 3] [Oracle & dispute] [Activity] [Terms]                    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### Composer

```
 source ── policy ── claim ── deadlines ── funding ── review ── publish   (step rail, top)
┌──────────────────────────────────────────────────────────────┬─────────────────────┐
│ Was a reproducible counterexample demonstrating               │ Drawer: Scope       │
│ [ reporter-deposit principal can consume… ✎ ] against commit  │  in / out of scope  │
│ [a1b2c3d 🔒] under environment [0x91…ab ✎] and policy         │ Drawer: Environment │
│ [BOT-001@0.1.0], submitted through [ERC-1497 ▾] before        │ Drawer: Fault model │
│ [Oct 10 2026 18:00 UTC ✎]?                                     │                     │
└──────────────────────────────────────────────────────────────┴─────────────────────┘
 funding: liquidity slider ────●──────  [stacked bar: spent | at risk | reserved | withdrawable]
          headroom vs spending limit, plus a depth preview of what that liquidity buys
```

## 6. Principles

1. **Glyphs carry the meaning; type carries the voice.** Every number on the board belongs to a glyph that
   has a text alternative. Nothing is colour-only: hatch, shape and labels back up every hue.
2. **Tension, not verdicts.** Orange and ultramarine are two pulls on one rope. Neither is "good". A NO is
   never celebrated, and a YES is never a siren.
3. **One orchestrated moment per surface.** The board settles once on load. After that, motion only
   answers data (a live tick) or a person's action (a drawer opening, a SHA locking in).
4. **Flat sheets, real hierarchy.** No drop shadows, no gradient washes, no identical card kit. Weight,
   width and the glyphs make the hierarchy.
5. **Honest numbers.** Depth over TVL, impact over headline price, and "pts" for price moves. Every money
   figure says who pays and whether it comes back.

## 7. Revised away from defaults

- *First instinct:* a dark navy "trading terminal" board with neon tiles. **Rejected.** It is cliché 2
  (near-black plus neon) and would collide with Console. It became a light survey-sheet ground with a
  two-hue data pair.
- *First instinct:* green for NO and red for YES. **Rejected** because it implies safe and unsafe. It became
  orange plus hatch against ultramarine: colour-blind-safe and morally neutral.
- *First instinct:* white rounded cards with soft shadows for the board. **Rejected** as cliché 4. It became
  flat 3 px sheets whose top band *is* the data glyph, with hierarchy carried by type width.
- *First instinct:* uppercase tracked eyebrows ("OPEN CLAIMS"), mono labels and "→" links. **Rejected.**
  Labels are sentence case, mono is reserved for real code, and links name their destination.
- *First instinct:* one neutral grotesque everywhere. **Revised** to use the width axis actively: expanded
  Anybody for the voice and condensed Archivo figures inside glyphs, so the type itself feels like a
  stretched field and a compact scoreboard.
