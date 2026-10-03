'use client'

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useScroll, useSpring } from 'motion/react'
import { COPY } from '@pine/core/copy'
import { CrystalGlyph } from '@/components/crystal/CrystalGlyph'
import { CommitIcon, EvidenceIcon, MarketIcon, OracleIcon, OutcomeStepIcon, PolicyIcon, QuestionIcon } from '@/components/icons'
import { FAMILY_HEX, OUTCOME_HEX, type FacetId } from '@/lib/crystal'
import { cn } from '@/lib/cn'
import { useReduceMotion } from '@/lib/hooks'

const SEED = 'story:kleros/gateway-balancer-bot:7c1e4b9'
const SHA = '7c1e4b9d02f6a83e51c0b7d94e2a6f13c58b0e4d'

interface Step {
  id: string
  name: string
  title: string
  body: React.ReactNode
  icon: React.ReactNode
}

const STEPS: Step[] = [
  {
    id: 'commit',
    name: 'Commit',
    title: 'Pin the exact commit',
    icon: <CommitIcon size={20} />,
    body: (
      <>
        A claim names one public GitHub repository and one full 40-character commit SHA, plus a base commit when only regressions count. New commits on the pull request never change it. They need a new claim.
      </>
    ),
  },
  {
    id: 'policy',
    name: 'Policy',
    title: 'Choose a versioned policy',
    icon: <PolicyIcon size={20} />,
    body: (
      <>
        FUNC-001 covers functional correctness and BOT-001 covers automation and keeper invariants. SC-001, for smart contracts, is visible but gated until a disclosure process is approved. The policy&apos;s version and hash go into the question.
      </>
    ),
  },
  {
    id: 'question',
    name: 'Question',
    title: 'Freeze one bounded question',
    icon: <QuestionIcon size={20} />,
    body: (
      <>
        <span className="block">The market asks exactly this, with every slot pinned:</span>
        <span className="cut-md mt-3 block border border-edge bg-void px-4 py-3 text-[0.9375rem] leading-[1.6] text-lumen">
          Was a reproducible counterexample demonstrating <Slot>the violation</Slot> against commit <Slot>SHA</Slot>, under configuration/environment <Slot>hash</Slot> and policy <Slot>id@version (hash)</Slot>, submitted through <Slot>mechanism</Slot> before <Slot>UTC timestamp</Slot>?
        </span>
      </>
    ),
  },
  {
    id: 'market',
    name: 'Market',
    title: 'Let light into the market',
    icon: <MarketIcon size={20} />,
    body: (
      <>
        Publishing creates a Seer market with Yes, No and Invalid-result outcomes. Its price is the {COPY.priceLabel.toLowerCase()}. {COPY.liquidityIsNotBounty}
      </>
    ),
  },
  {
    id: 'evidence',
    name: 'Evidence',
    title: 'Investigators look for the flaw',
    icon: <EvidenceIcon size={20} />,
    body: (
      <>
        Anyone can file evidence on Ethereum through the Kleros arbitration contract before the deadline. The block timestamp proves timeliness. {COPY.deadlineIsNotTradingCutoff}
      </>
    ),
  },
  {
    id: 'oracle',
    name: 'Oracle',
    title: 'Reality.eth answers and Kleros settles disputes',
    icon: <OracleIcon size={20} />,
    body: (
      <>
        After the deadline anyone can answer on Reality.eth with a bond. Each answer restarts a fixed 3.5-day timeout and can be challenged by doubling the bond. Arbitration runs on Kleros on Ethereum and is paid in ETH. A first ruling takes about 14.5 days, plus about 11 days per appeal.
      </>
    ),
  },
  {
    id: 'outcome',
    name: 'Outcome',
    title: 'Fractured, dimmed or clouded',
    icon: <OutcomeStepIcon size={20} />,
    body: (
      <>
        A demonstrated counterexample fractures the claim. If none qualifies, the crystal stays whole but dims, and that is not proof the code is correct. An invalid result clouds it, and it is not a refund.
      </>
    ),
  },
]

function Slot({ children }: { children: React.ReactNode }) {
  return <span className="rounded-[3px] border border-dashed border-[rgba(90,216,255,0.5)] px-1 text-hb">{children}</span>
}

/** The pinned inputs, one facet each (the composer's cutting bench in miniature). */
const PINS: { id: FacetId; label: string; value: string; mono?: boolean }[] = [
  { id: 'commit', label: 'Commit', value: SHA.slice(0, 7), mono: true },
  { id: 'policy', label: 'Policy', value: 'BOT-001@0.1.0' },
  { id: 'question', label: 'Question', value: '0x9c41…e07b', mono: true },
  { id: 'environment', label: 'Environment', value: '0x3fd2…81aa', mono: true },
  { id: 'deadline', label: 'Deadline', value: 'UTC, fixed' },
  { id: 'oracle', label: 'Oracle', value: 'Reality.eth' },
]

const CUTS: FacetId[][] = [
  ['commit'],
  ['commit', 'policy'],
  ['commit', 'policy', 'question', 'environment', 'deadline', 'oracle', 'manifest'],
]

/** The sticky optical diagram for a step. */
export function StoryDiagram({ step, className }: { step: number; className?: string }) {
  const reduce = useReduceMotion()
  const hue = FAMILY_HEX.BOT
  const cut = step < 3 ? CUTS[step] : undefined
  const showBeams = step >= 3 && step <= 5
  const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: reduce ? 0 : 0.5 } }
  return (
    <div className={cn('cut-xl well relative aspect-square w-full overflow-hidden', className)} aria-hidden>
      <svg viewBox="0 0 520 520" className="absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id="st-in" x1="0" x2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="1" stopColor="#fff" stopOpacity="0.95" />
          </linearGradient>
          <filter id="st-blur" x="-20%" y="-60%" width="140%" height="220%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
        </defs>
        <g stroke="#F5EDE4" strokeOpacity="0.045">
          {Array.from({ length: 12 }, (_, i) => (
            <line key={`v${i}`} x1={i * 44 + 18} x2={i * 44 + 18} y1="0" y2="520" />
          ))}
          {Array.from({ length: 12 }, (_, i) => (
            <line key={`h${i}`} y1={i * 44 + 18} y2={i * 44 + 18} x1="0" x2="520" />
          ))}
        </g>
        <AnimatePresence>
          {showBeams && (
            <motion.g key="beams" {...fade}>
              <rect x="0" y="252" width="200" height="14" fill="url(#st-in)" filter="url(#st-blur)" opacity="0.6" />
              <rect x="0" y="257.5" width="200" height="3" fill="url(#st-in)" />
              {step < 5 && (
                <>
                  <polygon points="236,255 520,166 520,206 236,261" fill={OUTCOME_HEX.yes} opacity="0.85" />
                  <polygon points="236,257 520,236 520,316 236,265" fill={OUTCOME_HEX.no} opacity="0.55" />
                  <polygon points="236,262 520,348 520,353 236,264" fill={OUTCOME_HEX.invalid} opacity="0.55" />
                </>
              )}
              {step === 5 && (
                <>
                  <polygon points="236,255 380,240 380,280 236,265" fill="#FFF6EC" opacity="0.5" />
                  <ellipse cx="392" cy="260" rx="14" ry="62" fill="rgba(90,216,255,0.08)" stroke="#5AD8FF" strokeOpacity="0.75" />
                  {[22, 34, 48].map((r, i) => (
                    <motion.ellipse
                      key={r}
                      cx="392"
                      cy="260"
                      rx={r * 0.32}
                      ry={r * 1.6}
                      fill="none"
                      stroke="#FFB648"
                      strokeOpacity={0.55 - i * 0.12}
                      initial={reduce ? false : { scale: 0.6, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ delay: reduce ? 0 : 0.2 + i * 0.25, duration: reduce ? 0 : 0.6 }}
                      style={{ transformOrigin: '392px 260px' }}
                    />
                  ))}
                  <polygon points="406,256 466,252 466,268 406,264" fill="#FFF6EC" opacity="0.4" />
                  <ellipse cx="478" cy="260" rx="10" ry="44" fill="rgba(183,154,255,0.08)" stroke="#B79AFF" strokeOpacity="0.6" strokeDasharray="4 3" />
                </>
              )}
            </motion.g>
          )}
          {step === 4 && (
            <motion.g key="sparks" {...fade}>
              <line x1="440" y1="70" x2="440" y2="450" stroke="#FFB648" strokeOpacity="0.7" strokeDasharray="5 5" />
              {[
                [90, 60, 196, 210],
                [40, 140, 186, 238],
                [140, 470, 200, 312],
              ].map(([x1, y1, x2, y2], i) => (
                <g key={i}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#5AD8FF" strokeOpacity="0.35" strokeDasharray="2 4" />
                  <motion.circle
                    r="4"
                    fill="#5AD8FF"
                    initial={reduce ? { cx: x2, cy: y2 } : { cx: x1, cy: y1 }}
                    animate={{ cx: x2, cy: y2 }}
                    transition={{ duration: reduce ? 0 : 1.1, delay: reduce ? 0 : 0.25 * i, ease: [0.16, 1, 0.3, 1] }}
                  />
                </g>
              ))}
            </motion.g>
          )}
        </AnimatePresence>
      </svg>

      {step < 3 && (
        <ul className="absolute right-5 top-5 hidden w-[10.5rem] gap-1 text-[0.72rem] sm:grid">
          {PINS.map((pin) => {
            const isCut = (cut ?? []).includes(pin.id)
            return (
              <li key={pin.id} className={cn('flex items-center gap-2 transition-colors duration-500', isCut ? 'text-lumen-2' : 'text-lumen-3')}>
                <span
                  className={cn('h-2 w-2 shrink-0 rotate-45 border transition-all duration-500', isCut ? 'border-lumen bg-lumen' : 'border-edge-strong')}
                  style={isCut ? { boxShadow: `0 0 8px ${hue}` } : undefined}
                />
                <span className="w-[4.6rem] shrink-0">{pin.label}</span>
                <span className={cn('truncate', isCut && pin.mono && 't-code text-[0.68rem]')}>{isCut ? pin.value : '…'}</span>
              </li>
            )
          })}
        </ul>
      )}

      {step < 6 ? (
        <div className="absolute left-[38.5%] top-1/2 -translate-x-1/2 -translate-y-1/2">
          <CrystalGlyph seed={SEED} hue={hue} cut={cut} state={step < 3 ? 'partial' : 'luminous'} size={250} animateCut sealed={step === 2} decorative />
        </div>
      ) : (
        <motion.div className="absolute inset-0 grid grid-cols-3 items-center px-4" initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }}>
          {(
            [
              ['fractured', OUTCOME_HEX.yes, 'Yes: fractured'],
              ['dim', OUTCOME_HEX.no, 'No: dimmed'],
              ['frosted', OUTCOME_HEX.invalid, 'Invalid: clouded'],
            ] as const
          ).map(([state, color, label], i) => (
            <div key={state} className="flex flex-col items-center gap-3 text-center">
              <CrystalGlyph seed={`${SEED}:${i}`} hue={FAMILY_HEX.BOT} state={state} size={170} animateFracture decorative />
              <span className="max-w-[9rem] text-[0.78rem] leading-[1.3]" style={{ color: state === 'fractured' ? color : 'var(--lumen-2)' }}>
                {label}
              </span>
            </div>
          ))}
        </motion.div>
      )}

      {/* Labels (decorative; the step text carries the meaning) */}
      <div className="pointer-events-none absolute inset-x-5 bottom-4 flex flex-wrap items-end justify-between gap-2 text-[0.75rem] text-lumen-3">
        <span className={step === 0 ? 't-code' : undefined}>
          {step === 0 && `commit ${SHA.slice(0, 12)}…`}
          {step === 1 && 'policy pinned with its hash'}
          {step === 2 && 'every input cut, question frozen'}
          {step === 3 && 'Yes, No and Invalid result'}
          {step === 4 && 'evidence before the deadline'}
          {step === 5 && 'Reality.eth, then Kleros'}
          {step === 6 && 'three endings'}
        </span>
        <span className="tnum">
          {step + 1} of {STEPS.length}
        </span>
      </div>
    </div>
  )
}

export function Story() {
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLOListElement | null>(null)
  const refs = useRef<(HTMLLIElement | null)[]>([])
  const { scrollYProgress } = useScroll({ target: listRef, offset: ['start 60%', 'end 60%'] })
  const progress = useSpring(scrollYProgress, { stiffness: 160, damping: 30, mass: 0.4 })

  useEffect(() => {
    const els = refs.current.filter(Boolean) as HTMLLIElement[]
    if (!els.length || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.step))
        }
      },
      { rootMargin: '-45% 0px -45% 0px' },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])

  return (
    <section className="relative py-20 sm:py-28" aria-labelledby="story-title">
      <div className="mx-auto w-full max-w-[1240px] px-4 sm:px-6 lg:px-8">
        <div className="max-w-[46rem]">
          <h2 id="story-title" className="t-h1 chroma">
            Follow the light through a claim
          </h2>
          <p className="t-lead mt-4 max-w-[60ch]">Seven steps, from one commit to one of three endings. Nothing in a published claim can change once its market exists.</p>
        </div>

        <div className="mt-14 grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)] lg:gap-16">
          <div className="hidden lg:block">
            <div className="sticky top-28">
              <StoryDiagram step={active} />
            </div>
          </div>
          <div className="relative">
            <div aria-hidden className="absolute bottom-6 left-[19px] top-6 w-px bg-edge" />
            <motion.div aria-hidden className="absolute left-[18px] top-6 w-[3px] origin-top rounded-full" style={{ scaleY: progress, bottom: 24, background: 'linear-gradient(180deg,#5ad8ff,#ffb648 50%,#ff6b83)' }} />
            <ol ref={listRef} className="grid gap-6 lg:gap-[20vh] lg:pb-[16vh]">
              {STEPS.map((s, i) => (
                <li
                  key={s.id}
                  ref={(el) => {
                    refs.current[i] = el
                  }}
                  data-step={i}
                  className="relative pl-14"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'cut-sm absolute left-0 top-0.5 flex h-10 w-10 items-center justify-center border transition-colors duration-300',
                      active === i ? 'border-[rgba(255,236,220,0.5)] bg-lumen text-umbra' : 'border-edge bg-smoke text-lumen-2',
                    )}
                  >
                    {s.icon}
                  </span>
                  <p className="text-[0.84375rem] font-semibold text-lumen-3">
                    <span className="tnum">{i + 1}</span> {s.name}
                  </p>
                  <h3 className="t-h3 mt-1">{s.title}</h3>
                  <div className="mt-3 max-w-[56ch] text-[1rem] leading-[1.65] text-lumen-2">{s.body}</div>
                  <div className="mt-6 lg:hidden">
                    <StoryDiagram step={i} className="max-w-[26rem]" />
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  )
}
