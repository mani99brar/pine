import Link from 'next/link'
import { Bot, GitCommitHorizontal, Plus } from 'lucide-react'
import { COPY } from '@pine/core/copy'
import { GlyphWall } from '@/components/landing/GlyphWall'
import { BoardPreview } from '@/components/landing/BoardPreview'
import { LifecycleRope } from '@/components/landing/Lifecycle'
import { ButtonLink } from '@/components/ui/Button'
import { OutcomeSwatch } from '@/components/glyphs/Status'

export default function LandingPage() {
  return (
    <>
      {/* Hero: a short headline, then the board itself */}
      <section className="border-b border-line-strong">
        <div className="mx-auto flex max-w-[1320px] flex-col px-4 pb-14 pt-8 sm:px-6 sm:pt-14 lg:pb-16">
          <h1 className="t-display-xl order-1 max-w-[20ch]">Every claim here is an open challenge.</h1>
          <div className="order-3 mt-6 grid gap-6 sm:order-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <p className="max-w-[62ch] text-[1.08rem] leading-[1.55] text-ink-2">
              Each one pins an exact commit and one bounded requirement, with live odds on whether anyone demonstrates a reproducible counterexample before an absolute UTC
              deadline. Teams put claims up; investigators and agents try to break them.
            </p>
            <div className="flex flex-wrap gap-3">
              <ButtonLink href="/board" size="lg">
                Browse open claims
              </ButtonLink>
              <ButtonLink href="/compose" size="lg" variant="secondary" icon={<Plus size={18} aria-hidden />}>
                Put a claim on the board
              </ButtonLink>
            </div>
          </div>
          <div className="order-2 sm:order-3">
            <GlyphWall />
          </div>
        </div>
      </section>

      {/* Two ways onto the field */}
      <section className="mx-auto max-w-[1320px] px-4 pt-16 sm:px-6">
        <div className="grid gap-px overflow-hidden rounded-[var(--radius-tile)] border border-line bg-line md:grid-cols-2">
          <div className="bg-sheet p-6 sm:p-8">
            <Bot size={22} aria-hidden />
            <h2 className="t-h2 mt-4">Investigating? Pick a claim with tension and time left.</h2>
            <p className="mt-3 max-w-[54ch] text-ink-2">
              Every claim pins the commit, the environment and a reproduction command, and lists what counts as admissible evidence. Agents get the same
              brief as JSON or Markdown, plus llms.txt and an Atom feed of new claims.
            </p>
            <p className="mt-3 max-w-[54ch] text-[0.9rem] text-ink-3">{COPY.evidenceIsNotPayment}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <ButtonLink href="/board">Browse open claims</ButtonLink>
              <ButtonLink href="/agents" variant="secondary">
                Read the agent guide
              </ButtonLink>
            </div>
          </div>
          <div className="bg-sheet p-6 sm:p-8">
            <GitCommitHorizontal size={22} aria-hidden />
            <h2 className="t-h2 mt-4">Shipping code? Put one bounded claim on the board.</h2>
            <p className="mt-3 max-w-[54ch] text-ink-2">
              Sign in with GitHub using public, read-only scope. Pin the exact commit, choose a policy, write one claim and fund its market under a spending
              limit with exact-amount approvals. Then watch it live.
            </p>
            <p className="mt-3 max-w-[54ch] text-[0.9rem] text-ink-3">{COPY.noMergeAuthority}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <ButtonLink href="/compose" icon={<Plus size={16} aria-hidden />}>
                Put a claim on the board
              </ButtonLink>
              <ButtonLink href="/repos" variant="secondary">
                Browse your repositories
              </ButtonLink>
            </div>
          </div>
        </div>
      </section>

      {/* Live board */}
      <section className="mx-auto max-w-[1320px] px-4 pt-20 sm:px-6" aria-labelledby="on-board">
        <div className="mb-8">
          <h2 id="on-board" className="t-display-l">
            The whole field at a glance
          </h2>
          <p className="mt-3 max-w-[60ch] text-ink-2">
            Each ring is an open claim. Higher means the market leans toward an accepted counterexample; further left means less time to submit evidence;
            bigger means more collateral is tradable near the price.
          </p>
        </div>
        <BoardPreview />
      </section>

      {/* Lifecycle */}
      <section className="mx-auto max-w-[1320px] px-4 pt-20 sm:px-6" aria-labelledby="lifecycle">
        <h2 id="lifecycle" className="t-display-l max-w-[20ch]">
          How a claim moves across the field
        </h2>
        <LifecycleRope className="mt-10" />
      </section>

      {/* Honest explanation */}
      <section className="mx-auto max-w-[1320px] px-4 pt-20 sm:px-6" aria-labelledby="meaning">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div>
            <h2 id="meaning" className="t-display-l max-w-[18ch]">
              What the result does and does not say
            </h2>
            <p className="mt-4 max-w-[52ch] text-ink-2">{COPY.notAReview}</p>
            <p className="mt-3 max-w-[52ch] text-ink-2">{COPY.priceCaveat}</p>
            <Link href="/risks" className="mt-5 inline-block font-[650] underline underline-offset-4">
              Read every risk and launch gate
            </Link>
          </div>
          <ul className="grid gap-3">
            {(
              [
                ['yes', COPY.outcome.yes, COPY.outcomeLong.yes, 'Bad news for the code, not an alarm: someone showed the exact violation, reproducibly, in time.'],
                ['no', COPY.outcome.no, COPY.outcomeLong.no, 'A held claim, not a clean bill of health: nothing outside this one bounded claim was examined.'],
                ['invalid', COPY.outcome.invalid, COPY.outcomeLong.invalid, 'Usually the sign of an ambiguous question or a refusal to arbitrate. Tight, bounded wording is the best protection.'],
              ] as const
            ).map(([k, title, long, caveat]) => (
              <li key={k} className="grid grid-cols-[auto_1fr] gap-4 rounded-[var(--radius-tile)] border border-line bg-sheet p-5">
                <OutcomeSwatch outcome={k} className="mt-1 h-10 w-3" />
                <div>
                  <p className="t-h3">{title}</p>
                  <p className="mt-1 text-ink-2">{long}</p>
                  <p className="mt-2 text-[0.88rem] text-ink-3">{caveat}</p>
                </div>
              </li>
            ))}
            <li className="rounded-[var(--radius-tile)] border border-dashed border-line-strong p-5 text-[0.92rem] text-ink-2">
              <p className="font-[650] text-ink">Liquidity is not a bounty</p>
              <p className="mt-1">{COPY.liquidityIsNotBounty}</p>
            </li>
          </ul>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="mx-auto max-w-[1320px] px-4 pt-20 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-6 rounded-[var(--radius-tile)] bg-ink px-6 py-10 text-on-ink sm:px-10">
          <p className="font-display text-[clamp(1.6rem,1.1rem+2vw,2.5rem)] leading-[1.02] font-[800] [font-stretch:125%]">The board is open.</p>
          <div className="flex flex-wrap gap-3">
            <Link href="/board" className="inline-flex h-12 items-center rounded-[var(--radius-btn)] bg-lumen px-5 font-[650] text-[#161a33] hover:bg-[#ffcd45]">
              Browse open claims
            </Link>
            <Link href="/compose" className="inline-flex h-12 items-center rounded-[var(--radius-btn)] border-[1.5px] border-on-ink/70 px-5 font-[650] hover:bg-white/10">
              Put a claim on the board
            </Link>
          </div>
        </div>
      </section>
    </>
  )
}
