# Pine Docket: design plan

Version 2 of the Pine frontend. Theme: **procedural clarity**.

## Subject, audience, job

- **Subject.** A public registry of bounded claims about exact commits. Each claim is a case file. Evidence comes in as exhibits. A procedure (oracle answer, challenge window, arbitration) produces an outcome.
- **Audience.** Engineering leads, founders and risk-conscious customers. They are new to prediction markets and oracles, and they will not trust a black box with their money.
- **Primary job.** Answer three questions on every screen, in this order:
  1. Where does this stand?
  2. What happens next, who has to act, and by when?
  3. What does it cost me, and what can go wrong?

  Market numbers come after these, never before.

## Palette

Six named colors. Everything else in the system derives from them.

| Name | Hex | Role |
|---|---|---|
| **Registry ink** | `#1A1D2B` | Body text, headings, rules that carry meaning. A blue-black writing ink, not a stand-in for black. 16.9:1 on Sheet. |
| **Sheet** | `#FFFFFF` | The filing surface. Documents, forms and the record. |
| **Bond** | `#EEF0F4` | The cool grey counter that sheets rest on: page canvas, margins, the guidance column. |
| **Stamp violet** | `#4433A6` | The institution's color, after the violet ink of official rubber stamps. Links, primary actions, the "current stage" of a procedure. 9.4:1 on Sheet. |
| **Flag yellow** | `#FFD60A` | Attention: the focus ring, the demo banner tag, "needs attention now" flags. Never used for text. |
| **Exhibit red** | `#B42318` | Counterexample demonstrated (bad news for the code), blocking errors, money exposed to loss. 6.5:1 on Sheet. |

Supporting tones, derived and used sparingly:

- Graphite `#4B5263`: secondary text, 7.6:1 (AAA).
- Rule `#CDD2DC`: hairlines inside sheets.
- Ochre `#7A4B00` on Wheat `#FFF3CF`: waiting stages (awaiting answer, answer proposed, finish filing).
- Plum `#7D1D5A` on Mauve `#F7E6F0`: contested stages (disputed, arbitration).
- Slate `#3D4A5C` on Mist `#E6EAF0`: **held**, used for the NO outcome. It is deliberately neutral: NO means "no qualifying counterexample submitted", not "safe". There is never a green check.
- Invalid uses a hatched Mist band with Graphite text.

## Typefaces

- **Atkinson Hyperlegible Next** (variable 200–800) is the voice of the interface: headings, guidance, forms, navigation. The Braille Institute drew it for low-vision legibility, with distinct `Il1`, `O0` and open apertures. That suits an audience reading unfamiliar terms for the first time. Headings use weight 700–800 with tight tracking. Body text uses 400.
- **Source Serif 4** (optical sizes) is **the record**, and only the record. Text that is binding and immutable is set in serif, as if entered into the register: the market question, the requirement, the violation phrase, policy text and exhibit titles. Guidance about the record is in sans. The typeface tells you which is which.
- **Atkinson Hyperlegible Mono** is for values a person must compare character by character: SHAs, hashes, addresses and reproduction commands. Docket numbers stay in Atkinson Next with tabular figures. They are names, not code.

### Type scale

Base 17px, ratio roughly 1.25, snapped to classic sizes.

| Token | Size / leading | Use |
|---|---|---|
| `text-xs` | 13 / 18 | Fine print under figures, captions |
| `text-sm` | 15 / 22 | Metadata, guidance notes, table cells |
| `text-base` | 17 / 27 | Body |
| `text-lg` | 20 / 30 | Lead paragraphs, "where this stands" |
| `text-xl` | 24 / 31 | Section headings (h3) |
| `text-2xl` | 30 / 37 | Page sections (h2) |
| `text-3xl` | 38 / 44 | Page titles (h1) |
| `text-4xl` | 52 / 56 | Landing hero only |
| record | 19 / 31 serif | The question and requirement |

Line length is held at 68ch or less for prose and 62ch for record text.

## Layout concept: the filing sheet with a margin

Every main page is a **sheet** with a **margin**. The sheet holds the content and the margin holds guidance, the way an annotated statute or a marked-up filing keeps commentary out of the text but beside it. On mobile the margin folds into "What does this mean?" disclosures directly under the field or paragraph it explains.

Numbering appears only where content is truly sequential: procedure stages, wizard steps, and exhibits (lettered A, B, C by legal convention).

### Landing

```
┌ Demo ▮ Sample data, simulated wallet. Nothing touches a chain. [Reviewer controls] [×] ┐
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ⌂ Pine Docket   Docket  Policies  How it works  Risks       [Sign in] [File a verification] │
╞══════════════════ 4px stamp-violet rule ═════════════════════════════════════════════╡
│                                                                                      │
│  Put one claim about one commit on the record.        ┌ PINE-0042 ─ Evidence open ─┐ │
│  Anyone may try to disprove it before the deadline.   │ "Was a reproducible        │ │
│  An oracle and, if needed, Kleros decide.             │  counterexample ¹ against  │ │
│                                                       │  commit 9f3c2e1 ² under …" │ │
│  [File a verification]  How a claim proceeds          │ ¹ what counts  ² exact code│ │
│                                                       └────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  What you get                    │  What you do not get                               │
│  ▸ a public, immutable claim     │  ▸ an audit, certification or "safe" verdict       │
│  ▸ a paid incentive to look      │  ▸ guaranteed investigators or a fixed bounty      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  How a claim proceeds   1 Filed ─ 2 Evidence window ─ 3 Deadline ─ 4 Answer ─ 5 Challenge │
│                         ─ 6 Arbitration (only if disputed) ─ 7 Final ─ 8 Settlement  │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  How outcomes read   YES ▮ Counterexample demonstrated │ NO ▯ No qualifying … │ Invalid │
│  What it costs       itemized FundingPlan for a 25 sDAI filing (real estimator)       │
│  On the docket now   docket rows (5)                                [Open the docket] │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### Docket (explore)

Rows read like docket entries: number, filed date, title in serif, parties (repo @ commit), policy, next deadline, and a stage tag. The list is grouped by procedural stage, starting with what needs attention.

```
Docket                                                     [Search claims, repos, SHAs…]
Stage: [All ▾]  Policy: [All ▾]  Repository: [All ▾]  Chain: [All ▾]  Sort: [Next deadline ▾]

▍Needs attention now
  Closing within 72 hours ─────────────────────────────────────────────── 2 entries
  PINE-0042  Filed 1 Oct   Reporter deposits never draw on protected funds   Deadline 5 Oct 18:00 UTC
             kleros/gateway-balancer-bot @ 9f3c2e1 · BOT-001@0.1.0          in 2d 4h   14% ⓘ  2 exhibits
  Awaiting the oracle's answer ────────────────────────────────────────── 1 entry
  Answer challenged or in arbitration ─────────────────────────────────── 2 entries
▍Evidence window open ─────────────────────────────────────────────────── 6 entries
▍Decided ───────────────────────────────────────────────────────────────── 4 entries
▍Filing incomplete ─────────────────────────────────────────────────────── 1 entry
```

### Filing wizard

Three columns at desktop: the step register, the form sheet, and the guidance margin aligned with each field.

```
┌ Step register ──┐┌ Sheet ───────────────────────────────┐┌ Margin ─────────────────┐
│ ✓ 1 Source      ││ Step 3 of 8 · Claim                  ││ What is a requirement?  │
│ ✓ 2 Policy      ││ Requirement (the one thing that must ││ One sentence that would │
│ ● 3 Claim       ││ hold)                                ││ be true if the code     │
│   4 Environment ││ [________________________________]   ││ works. Investigators    │
│   5 Deadlines   ││ Violation phrase                     ││ try to make it false.   │
│   6 Funding     ││ [________________________________]   ││                         │
│   7 Review      ││ ⚠ Fix: use one requirement, not two  ││ Good: "…"   Too broad:  │
│   8 Publish     ││                    [Back] [Continue] ││ "the bot is secure"     │
│ Saved 14:02 UTC │└──────────────────────────────────────┘└─────────────────────────┘
└─────────────────┘
mobile: "Step 3 of 8: Claim [All steps ▾]" header; margin notes become disclosures under each field.
```

### Claim (case file)

The procedural timeline is the page's navigation. It sits as a sticky rail on desktop and a horizontal stage strip on mobile. Each stage links to the section that governs it.

```
Docket › PINE-0042                                         [Print / Save as PDF] [Agent brief]
PINE-0042  ▌Evidence window open
Reporter deposits never draw on arbitration or gas reserves            (serif title)
kleros/gateway-balancer-bot @ 9f3c2e1 (PR #118) · BOT-001@0.1.0 · Filed 1 Oct 2026

┌ Procedure ─────────┐ ┌ Where this stands ─────────────────────────────────────────┐
│ ✓ 1 Filed     1 Oct│ │ Investigators can file exhibits until 5 Oct 18:00 UTC.     │
│ ● 2 Evidence open  │ │ Next: Evidence deadline · Who acts: investigators ·        │
│   3 Deadline  5 Oct│ │ By: 5 Oct 2026 18:00 UTC (in 2d 4h)                        │
│   4 Answer         │ └────────────────────────────────────────────────────────────┘
│   5 Challenge      │  The question on record (serif, annotated)
│   6 Arbitration    │  Terms on record (commit, env hash, policy, deadline: mono + copy)
│   7 Final          │  Exhibits A, B, C (untrusted, plain text / sanitized markdown)
│   8 Settlement     │  Market (price with caveat, depth, impact)  │ margin: what price means
└────────────────────┘  Oracle & dispute · Funding & your position · Agent brief · Record
```

## Principles

1. **Status before numbers.** Every claim view leads with the stage and the next step: who acts and by when. Prices show only after the procedure is clear, and they always carry their caveat.
2. **The record looks like the record.** Immutable terms are set in serif and never editable in place. Guidance about them is in sans. Hashes are in mono with a copy action.
3. **Guidance lives in the margin, never in fine print.** Every field and every money figure has a plain-language note beside it. Risk numbers are itemized and placed where the decision is made.
4. **Structure is information.** Numbers are for sequences, letters are for exhibits, and colored bands are for stage. No decorative eyebrows, cards or gradients.
5. **Neutral outcomes stay neutral.** YES is Exhibit red. NO is held slate. Invalid is hatched. Nothing gets a celebratory green.
6. **One moment of motion.** On the claim page the current stage marker settles into place once. Everything else moves only in response to the person: annotations highlighting their term, disclosures opening, the "filed" stamp after publishing. All of it respects `prefers-reduced-motion`.

## What I revised away from my defaults

- **Navy + Inter + card grid → Stamp violet + Atkinson Hyperlegible + ruled sheets.** My first instinct for an "institutional" product was navy and Inter with rounded cards. That is the generic SaaS kit. Violet stamp ink comes from the actual world of filings, and Atkinson's legibility mandate fits newcomers better than a neutral grotesque.
- **Serif everywhere → serif only for binding text.** A serif display would have pulled toward the cream-and-serif look. Restricting serif to the immutable record turns the typeface into information.
- **Green "resolved" → slate "held".** Success-green for NO is the default status palette, and it is wrong here.
- **Uppercase stamps → sentence-case status bands.** Rubber-stamp caps read as skeuomorphic costume. A colored left band with a sentence-case label carries the same authority and reads better.
- **Big-stat hero → an annotated docket entry.** The hero shows a real filed question with numbered annotations, a preview of the "read it as an investigator would" moment. It does not show a headline number.
- **Mono labels everywhere → mono only for compare-by-character values.**
- **Focus ring.** Instead of a default blue glow, the focus ring is a Flag-yellow ring with an ink outer ring, a civic-design convention that stays visible on every background.

## Decisions made during screenshot QA

- **Slashed zero kept.** Atkinson Hyperlegible Next's slashed zero cannot be turned off through OpenType features in the Google Fonts build. I kept it on purpose: docket numbers, SHAs and amounts are exactly where a 0/O mix-up costs something.
- **The hero top-aligns.** The landing hero is top-aligned, and its annotated entry shows two binding-term notes, side by side, behind a "See all binding terms" expander. That way the first viewport holds the headline, the CTA and the record without one column floating in empty space.
- **The question stays visible.** On the claim page and in review, the annotated question is sticky at xl widths. It stays in view while the reader works down the seven notes.
- **Long sections fold.** Terms on record fold their long subsections (scope, environment) into disclosures with a one-line summary. Printing opens every disclosure.
- **"What happens next" names the next event.** It says "The evidence deadline passes" or "The answer becomes final, unless challenged". It never repeats the stage name the band already shows.
- **Mobile sheets run full width.** Below 640px the claim, wizard and exhibit sheets go full-bleed, so record text keeps about 36 characters a line on a 360px phone.
- **The header switches to a menu below 1380px**, so a signed-in header (wallet, account and the primary action) never collides with the navigation.
- **Hydration-safe client state.** Views that depend on browser-only state (session mirror, simulated wallet, local drafts) render a skeleton on the server. Relative times use one shared clock that starts after hydration.
