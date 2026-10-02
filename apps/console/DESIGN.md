# Pine Console: design plan

Pine Console is the verification workbench, built for engineers who ship patches (agent-generated PRs included) and for agent operators. These people work in GitHub, terminals, Linear and Raycast, and they expect keyboard speed, dense truthful data and no marketing fog. The console should feel like a **precision instrument**: calm, exact and graduated. It does not look like a trading terminal or a SaaS dashboard.

The subject supplies the visual language. A Pine claim is a *measurement with bounds*: one commit, one requirement, one absolute deadline, one price on a 0–100 scale. Instruments show bounds with **graduations**, the tick marks on a caliper or survey rod. Graduations are the console's single structural motif. They are never decoration: every tick encodes a time, a price or a completion state.

## 1. Color: "Bark & Resin"

Six named base values. Light theme first. Dark values follow the same roles.

| Name | Light | Dark | Role |
|---|---|---|---|
| **Frost** | `#F2F4F1` | `#0D1615` | App background. A cool, green-tinted grey that is not cream. Dark is a deep pine, never neutral #111. |
| **Bark** | `#16231F` | `#E2EAE6` | Ink: text, rules at full strength, primary data. |
| **Needle** | `#1C5D50` | `#73C6B1` | Interactive: links, primary buttons, focus ring, selection. Pine green, deep and muted. |
| **Resin** | `#935600` (text) / `#F4BC4E` (fill) | `#F2B851` | *Change and liveness*: hash recompute flash, live countdowns, the "now" tick, unsaved state. Resin is how the console says "this just changed". |
| **Flare** | `#B02A42` | `#FF7088` | Counterexample demonstrated (YES), critical failures. YES is bad news for the code, so it gets the alarm color. |
| **Slate** | `#56677F` | `#9DAEC6` | Held / NO ("No qualifying counterexample submitted"). Neutral and steady, never a celebratory green check. |

Support tones come from these: surface (`#FFFFFF` / `#132120`), sunken (`#E8ECE8` / `#0A1211`), lines (`#D3DBD6` / `#24342F`), muted text (`#55635E` / `#93A49E`). Invalid outcomes use a desaturated violet (`#6E5E8A` / `#B3A3D1`) so they read as "neither" and never as resin or slate.

Contrast: every text pairing is ≥ 4.5:1 (muted on frost 5.9:1 light, 6.4:1 dark). The resin *fill* is only a background behind bark text (≥ 9:1). Resin as text uses the darker `#935600` (5.3:1 on frost).

## 2. Type

- **Archivo** (variable, wdth 62–125, wght 100–900) for all UI and prose. The width axis does real work:
  - *Expanded* (wdth 112–125, wght 650–800) for display and page titles. It reads like an engraved instrument plate.
  - *Normal* (wdth 100) for body and controls.
  - *Condensed* (wdth 75–85, wght 550) for table headers, field labels and the rail. Dense, but still sentence case.
- **Martian Mono** (variable, wdth 75–112.5) **only for data that is literally code or bytes**: SHAs, hashes, addresses, commands, JSON, question text inside the artifact pane, and keyboard keys. It is condensed (wdth 87.5) inside chips so a 0x…10-char hash fits. It never appears in decorative labels.

Scale (classic typographic scale, px): 11 · 12 · 14 (UI base) · 16 (prose base) · 18 · 21 · 24 · 36 · 48 · 60.
Line height: 1.45 for UI, 1.6 for prose, 1.05 for expanded display. Prose measure is capped at 68ch.
No all-caps eyebrows. Labels are sentence case, condensed and muted. A label appears only when the value would be ambiguous without it.

## 3. Layout concept

The workbench is a set of **panes**, not cards. Panes sit flush against each other and are separated by 1px rules, like an editor. Elevation exists only for things that float above the workbench (palette, dialogs, menus). Corner radius follows hierarchy: 0 for panes, 6px for controls, 4px for chips, 10px for floating layers.

### Shell (desktop ≥ 1024)
```
┌──────────┬──────────────────────────────────────────────────────────┐
│ ▲ Pine   │ claims / PINE-0042            [⌘K  Search or paste URL] ◐ ▣ wallet │
│ Console  ├──────────────────────────────────────────────────────────┤
│          │ demo banner (dismissible) — mock data · simulated wallet │
│ ⌂ Dash  g d                                                          │
│ ≣ Claims g c│                     page                                │
│ ＋ New    n │                                                         │
│ ◫ Drafts   │                                                          │
│ ⑂ Repos g r│                                                          │
│ § Policies │                                                          │
│ ⚙ Agents   │                                                          │
│ ! Risks    │                                                          │
│ ─────────  │                                                          │
│ Activity   │                                                          │
│ Settings   │                                                          │
├──────────┴──────────────────────────────────────────────────────────┤
│ ● mock data   Gnosis 100   demo wallet 0xD3m0…   UTC 14:02:11   ? shortcuts │  ← status bar
└─────────────────────────────────────────────────────────────────────┘
```
The status bar carries the UTC clock. Every deadline in Pine is absolute UTC, so the reference time is always on screen.

Mobile (< 768): rail becomes a bottom bar (Dashboard · Claims · ＋New · ⌘K · More). "More" opens a drawer with the remaining routes. The status bar folds into the drawer.

### Explore
```
┌ views ─────┬ filter: [status▾][policy▾][repo▾][search……]  sort: deadline ▾ ┐
│ Open    12 │ St  Claim                repo@sha     Pol   YES ~~~  Liq  Due │ preview pane │
│ Closing  3 │ ●   PINE-0042 Reporter…  kleros/…@3f9 BOT   14% ╱╲_  420  2d4h│ question     │
│ Disputed 2 │ ●   PINE-0039 …                                         …     │ refs, gauge  │
│ Resolved 5 │ j/k move · ↵ open · space preview                             │ [Open ↵]     │
│ Mine     4 │                                                               │              │
└────────────┴────────────────────────────────────────────────────────────┴──────────────┘
```
Each row has a deadline **graduation bar**: the evidence window drawn as ticks, filled up to now, with a resin "now" tick.

### Composer (signature)
```
┌gutter┬ form (sectioned, one page) ───────────┬ LIVE ARTIFACTS ────────────────┐
│ ┬ 1  │ Source   paste URL / pick repo→PR→sha │ hash chips: manifest policy env │
│ ┼    │ Policy   FUNC / BOT / SC(gated)       │   config question  (flash+diff) │
│ ┼ 2  │ Claim    requirement, violation…      │ ── question.txt ──────────────  │
│ ┼    │ Environment  runtime, lock, cmd       │ "Was a reproducible counter…"   │
│ ┼ 3  │ Deadlines & oracle   UTC deadline     │ ── manifest.json (folding) ──   │
│ ┼    │ Funding  liquidity, limit, costs      │ { "claim": { … } }              │
│ ┴ 7  │ Review   disclosures, ack, Publish    │ ── problems (3) ────────────    │
└──────┴───────────────────────────────────────┴─────────────────────────────────┘
```
The gutter is a vertical rule with a major tick per section and a minor tick per field. Ticks fill as fields become valid, and a resin tick marks the section in view. Publishing replaces the problems panel with a **tx log**, a terminal-like list of steps with per-step status, retry and resume. After `create_market` confirms, a frozen-terms indicator appears.
Below 1024: the artifacts pane becomes a sticky bottom sheet ("Artifacts · 5 hashes · 2 problems") that expands on tap.

### Claim workspace
```
PINE-0042  ● open · evidence closes in 2d 4h        [Submit evidence] [Copy agent brief]
Reporter-deposit principal must not consume protected funds   kleros/gateway-balancer-bot@3f9a1c2
┌ Overview 1 │ Market 2 │ Evidence 3 │ Oracle 4 │ Agent 5 │ Activity 6 ┐───────────────┐
│ question (mono, quoted, copy)                                        │ next step     │
│ lifecycle graduation: created ─┼── deadline ─┼ opening ─┼ finalize   │ my position   │
│ immutable refs table (copy buttons)                                  │ refs          │
└──────────────────────────────────────────────────────────────────────┴───────────────┘
```

## 4. Principles

1. **Every mark is a measurement.** Ticks, rules and numbers encode time, price or completeness. Anything that encodes nothing is cut.
2. **Show the bytes.** Hashes, SHAs and the question text are the product. They are always visible, monospace, copyable and never paraphrased.
3. **Resin means "changed".** Amber appears only when something just changed or is live. It is never a brand splash.
4. **Outcomes are reported, not celebrated.** YES uses flare (alarm), NO uses slate (held), invalid uses violet (neither). There are no green check marks for outcomes anywhere.
5. **The keyboard is the fast path, never the only path.** Every shortcut has a visible button and a visible hint. `?` lists them all.
6. **Untrusted text stays inert.** Evidence, PR titles and commit messages render as plain text or sanitized Markdown in a clipped, wrapping container. It never touches the layout of trusted chrome.

## 5. Motion

One signature motion: **hash recompute**. When an input changes, each affected hash chip briefly shows the characters that changed on a resin fill, then settles over 900ms. Tx log steps tick from `·` to `◐` to `✓`/`✕`. Everything else is instant or a 120ms fade for floating layers. `prefers-reduced-motion` turns the flash into a static resin outline that clears on the next change.

## 6. Revised away from defaults

The first draft of this plan went where any "developer tool" brief goes: a near-black canvas, one bright green accent, JetBrains Mono everywhere and rounded cards with soft shadows. Review against the brief changed four things:

- **Canvas:** near-black plus acid green became the *Bark & Resin* palette. The darks are a colored pine, the accent is a muted pine-green needle, and amber is reserved for "changed". Light theme is first-class and is the default when the system is light.
- **Mono everywhere** became **mono only for literal bytes**. Labels use condensed Archivo in sentence case. The tell of "monospace for small data labels" is avoided on purpose: mono means "you could paste this into a terminal".
- **Card grid** became **flush panes with 1px rules**, the editor vernacular these users live in. Radius encodes elevation, not style.
- **Generic progress dots and step pills** became **graduations**, one motif reused across the composer gutter, deadline bars, price gauges and the lifecycle ruler. It gives the console one memorable idea instead of many small ones.

Also avoided: ALL-CAPS eyebrows, `A · B · C` meta strings in headings, arrows appended to button text, gradient washes and celebratory success styling for NO.
