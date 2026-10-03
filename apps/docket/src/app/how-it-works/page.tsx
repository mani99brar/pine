import type { Metadata } from 'next'
import Link from 'next/link'
import { COPY } from '@pine/core/copy'
import { cn } from '@/lib/cn'
import { Page, PageHeader } from '@/components/ui/layout'
import { MarginNote } from '@/components/ui/field'
import { PROCEDURE } from '@/lib/procedure'

export const metadata: Metadata = {
  title: 'How it works',
  description: 'Oracles, bonds, arbitration, outcome tokens and liquidity, explained in plain language for people new to prediction markets.',
  alternates: { canonical: '/how-it-works' },
}

const PARTIES = [
  { who: 'The filer', what: 'Pins a commit, writes one bounded claim, and funds the market. Usually the team that wrote the code.' },
  { who: 'Investigators', what: 'People or AI agents who try to break the claim and file reproducible counterexamples as exhibits.' },
  { who: 'Traders', what: 'Buy Yes or No tokens. Someone who finds a counterexample can buy Yes before others know. That is the incentive.' },
  { who: 'Liquidity providers', what: 'Supply both sides of the market so trades can happen. The filer is usually the first one.' },
  { who: 'Answerers', what: 'Anyone who posts the answer on Reality.eth after the deadline, backed by a bond.' },
  { who: 'Kleros jurors', what: 'Decide disputed answers if someone pays for arbitration. They read the timely exhibits.' },
]

const GLOSSARY: { term: string; def: string }[] = [
  { term: 'Arbitration', def: 'Escalating a disputed answer to the Kleros court. Whoever requests it pays a fee in ETH on Ethereum. A first ruling takes about two weeks, plus about 11 days for each appeal.' },
  { term: 'Bond', def: 'Money an answerer puts up with an answer. If the answer is overturned, the bond goes to whoever ends up with the right answer. Each new answer must at least double the previous bond.' },
  { term: 'Challenge window', def: 'The 3.5 days after each answer during which anyone can post a different answer with a bigger bond. If nobody does, the answer becomes final.' },
  { term: 'Claim', def: 'One bounded statement about one exact commit: a requirement, and the violation that would break it. Filed under a policy.' },
  { term: 'Collateral', def: 'The token the market is denominated in. On Gnosis this is sDAI, a dollar-pegged savings token.' },
  { term: 'Commit', def: 'One exact version of the code, identified by a 40-character SHA. A claim is about one commit, not a branch or a pull request.' },
  { term: 'Counterexample', def: 'A reproducible demonstration that the violation happens. Not an opinion, a screenshot or a log on its own.' },
  { term: 'Docket number', def: 'The claim’s public number, like PINE-0042. It never changes.' },
  { term: 'Environment hash', def: 'A fingerprint of the runtime, dependencies, configuration and reproduction command. Exhibits must reproduce under it.' },
  { term: 'Evidence deadline', def: 'The absolute UTC time after which exhibits are not timely. It is not a trading cutoff.' },
  { term: 'Gas', def: 'The network fee for every transaction you sign. It is paid in the chain’s own token (xDAI on Gnosis, ETH on Ethereum) and is gone whatever the outcome.' },
  { term: 'Gnosis', def: 'The blockchain Pine markets use by default. Fees there are a fraction of a cent. Exhibits and arbitration still happen on Ethereum.' },
  { term: 'Exhibit', def: 'Something filed against a claim: a counterexample, a rebuttal or a clarification. Lettered A, B, C in filing order.' },
  { term: 'Invalid result', def: 'A third outcome Seer adds to every market, used when the question cannot be answered. Only Invalid-result tokens redeem then; it is not a refund.' },
  { term: 'Kleros', def: 'A decentralized court. Its jurors rule on a disputed answer when someone pays for arbitration.' },
  { term: 'Liquidity', def: 'Collateral placed in the market’s pools so trades can happen. It is capital at risk, not a bounty or a reward.' },
  { term: 'Manifest', def: 'The complete, hashed record of a claim: source, policy, requirement, environment, deadline and question. Stored durably and referenced by the market.' },
  { term: 'Market-implied chance', def: 'The Yes price, read as the market’s estimate that a qualifying counterexample is accepted. It is not the probability that the code has bugs.' },
  { term: 'Oracle', def: 'The mechanism that answers the market question. Pine uses Reality.eth: anyone answers with a bond, anyone can challenge.' },
  { term: 'Outcome tokens', def: 'Yes, No and Invalid-result tokens. When the market resolves, the winning token redeems for one unit of collateral; the others pay nothing.' },
  { term: 'Policy', def: 'A reviewed, versioned rulebook that says what evidence counts and what is excluded. Its hash is part of the question.' },
  { term: 'Price impact', def: 'How much a trade moves the price. A big trade in a thin market gets a much worse average price than the headline.' },
  { term: 'Redeem', def: 'Exchanging winning outcome tokens for collateral after the market resolves.' },
  { term: 'Reality.eth', def: 'The oracle Pine uses. Anyone can post the answer to the market question with a bond, and anyone can challenge it with a bigger one.' },
  { term: 'Sealed exhibit', def: 'An exhibit filed as a hash first and revealed later, so nobody can copy it before it is timestamped. Its rules are still a launch gate.' },
  { term: 'Seer', def: 'The prediction-market protocol Pine uses to create markets and outcome tokens.' },
  { term: 'Spending limit', def: 'The most a filing may spend, set by you. Every step is checked against it, and approvals are for the exact amount only.' },
  { term: 'Wallet', def: 'The app that holds your funds and signs transactions, such as a browser extension. Pine asks it to sign; it never holds your keys.' },
  { term: 'xDAI', def: 'The token that pays gas on Gnosis, worth about one US dollar. Oracle bonds on Gnosis are also posted in xDAI.' },
].sort((a, b) => a.term.localeCompare(b.term, 'en', { sensitivity: 'base' }))

const DURATION: Record<string, string> = {
  evidence: 'Set by the filer, at least 24 hours',
  challenge: '3.5 days after each answer',
  arbitration: 'About 2 weeks, plus 11 days per appeal',
}

export default function HowItWorksPage() {
  const letters = [...new Set(GLOSSARY.map((g) => g.term[0]!.toUpperCase()))]
  return (
    <Page>
      <PageHeader
        title="How it works"
        lead="Pine turns “we think this code does X” into a public, bounded question, and lets a market give independent people a reason to try to prove it wrong."
      />
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-16">
          <section aria-labelledby="idea" className="border border-rule bg-sheet px-6 py-7 sm:px-9">
            <h2 id="idea" className="text-2xl">
              The idea, in one paragraph
            </h2>
            <p className="mt-3 text-lg leading-8 measure">
              You pin one commit and state one thing it must never do. A prediction market then asks: will someone demonstrate that it does, before
              the deadline? If the code does fail, an investigator who finds the counterexample can buy Yes while it is cheap and profit when the market
              resolves. That possibility, not a fee from you, is what draws people to look. If nobody demonstrates it in time, the market resolves No,
              which means only that: no qualifying counterexample was submitted. An oracle answers the question, and Kleros settles disputes about
              the answer.
            </p>
            <p className="mt-4 text-[15px] text-graphite measure">{COPY.notAReview}</p>
          </section>

          <section aria-labelledby="proc">
            <h2 id="proc" className="text-2xl">
              The procedure, stage by stage
            </h2>
            <ol className="mt-6 border-l-2 border-ink">
              {PROCEDURE.map((p, i) => (
                <li key={p.id} className="relative pb-8 pl-8 last:pb-0">
                  <span
                    aria-hidden
                    className={cn(
                      'absolute top-0 -left-[15px] flex size-7 items-center justify-center rounded-full text-[13px] font-[800]',
                      p.optional ? 'border-2 border-dashed border-ink bg-bond' : 'bg-ink text-white',
                    )}
                  >
                    {i + 1}
                  </span>
                  <h3 className="text-xl">
                    {p.title}
                    {p.optional ? <span className="font-normal text-graphite"> (only if disputed)</span> : null}
                  </h3>
                  <p className="mt-1 measure">{p.summary}</p>
                  <p className="mt-1 text-[15px] text-graphite">
                    <strong className="text-ink">Who acts:</strong> {p.who}
                    {DURATION[p.id] ? (
                      <>
                        . <strong className="text-ink">How long:</strong> {DURATION[p.id]}
                      </>
                    ) : null}
                  </p>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="parties">
            <h2 id="parties" className="text-2xl">
              Who is involved
            </h2>
            <dl className="mt-4 grid gap-x-8 sm:grid-cols-2">
              {PARTIES.map((p) => (
                <div key={p.who} className="border-t-2 border-ink py-3">
                  <dt className="font-bold">{p.who}</dt>
                  <dd className="mt-1 text-[15px] text-graphite">{p.what}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="outcomes">
            <h2 id="outcomes" className="text-2xl">
              What the outcomes mean
            </h2>
            <dl className="mt-4 space-y-3">
              <div className="border-l-8 border-red bg-red-wash px-5 py-4">
                <dt className="font-bold text-red">{COPY.outcome.yes}</dt>
                <dd className="mt-1">{COPY.outcomeLong.yes} This is bad news for the code, and useful news for you.</dd>
              </div>
              <div className="border-l-8 border-slate bg-mist px-5 py-4">
                <dt className="font-bold text-slate">{COPY.outcome.no}</dt>
                <dd className="mt-1">{COPY.noIsNotSafety}</dd>
              </div>
              <div className="hatch border-l-8 border-graphite px-5 py-4">
                <dt className="font-bold text-graphite">{COPY.outcome.invalid}</dt>
                <dd className="mt-1">{COPY.invalidIsNotRefund}</dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="glossary">
            <h2 id="glossary" className="text-2xl">
              Glossary
            </h2>
            <nav aria-label="Glossary letters" className="mt-3 flex flex-wrap gap-1.5">
              {letters.map((l) => (
                <a key={l} href={`#g-${l}`} className="flex size-9 items-center justify-center border border-rule bg-sheet font-bold no-underline hover:border-violet hover:text-violet">
                  {l}
                </a>
              ))}
            </nav>
            <dl className="mt-5 divide-y divide-rule border-y border-rule bg-sheet">
              {GLOSSARY.map((g, i) => {
                const first = i === 0 || GLOSSARY[i - 1]!.term[0] !== g.term[0]
                return (
                  <div
                    key={g.term}
                    id={first ? `g-${g.term[0]!.toUpperCase()}` : undefined}
                    className="grid scroll-mt-6 gap-1 px-5 py-4 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-8"
                  >
                    <dt className="font-bold">{g.term}</dt>
                    <dd className="measure">{g.def}</dd>
                  </div>
                )
              })}
            </dl>
          </section>
        </div>
        <aside className="space-y-6">
          <div className="sticky top-6 space-y-6">
            <MarginNote title="On this page">
              <ul className="space-y-1.5">
                <li>
                  <a href="#idea" className="link">The idea</a>
                </li>
                <li>
                  <a href="#proc" className="link">The procedure</a>
                </li>
                <li>
                  <a href="#parties" className="link">Who is involved</a>
                </li>
                <li>
                  <a href="#outcomes" className="link">Outcomes</a>
                </li>
                <li>
                  <a href="#glossary" className="link">Glossary</a>
                </li>
              </ul>
            </MarginNote>
            <MarginNote title="Next">
              <p>
                <Link href="/risks" className="link">Risks and launch gates</Link> lists what can go wrong. <Link href="/policies" className="link">The policy catalog</Link> shows the rules a claim can use.
              </p>
            </MarginNote>
          </div>
        </aside>
      </div>
    </Page>
  )
}
