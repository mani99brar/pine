import type { Metadata } from 'next'
import { COPY } from '@pine/core/copy'
import { cn } from '@/lib/cn'
import { Page, PageHeader } from '@/components/ui/layout'
import { MarginNote } from '@/components/ui/field'

export const metadata: Metadata = {
  title: 'Risks and launch gates',
  description: 'Every risk you accept when filing or trading, and the open decisions that must be resolved before launch.',
  alternates: { canonical: '/risks' },
}

export default function RisksPage() {
  const open = COPY.launchGates.filter((g) => g.status === 'open').length
  return (
    <Page>
      <PageHeader
        title="Risks and launch gates"
        lead="What can go wrong for you, in plain words, and what is still undecided about Pine itself. Nothing here is hidden in a footnote elsewhere."
      />
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-14">
          <section aria-labelledby="risks">
            <h2 id="risks" className="text-2xl">
              Risks you accept
            </h2>
            <p className="mt-1 text-graphite">These are the same statements the filing review asks you to acknowledge, with your real numbers.</p>
            <dl className="mt-5 divide-y divide-rule border-y border-rule bg-sheet">
              {COPY.disclosures.map((d) => (
                <div key={d.id} id={d.id} className="grid scroll-mt-6 gap-2 px-5 py-5 md:grid-cols-[16rem_minmax(0,1fr)] md:gap-8">
                  <dt className="font-bold">{d.title}</dt>
                  <dd className="measure leading-7">{d.body}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="gates">
            <h2 id="gates" className="text-2xl">
              Launch gates
            </h2>
            <p className="mt-1 text-graphite measure">
              Open decisions from the specification (section 10). {open} of {COPY.launchGates.length} are still open. Until they close, treat this
              release as a working demonstration, not a service to commit real funds to.
            </p>
            <ol className="mt-5 space-y-3">
              {COPY.launchGates.map((g) => (
                <li key={g.id} id={`gate-${g.id}`} className="grid scroll-mt-6 border border-rule bg-sheet sm:grid-cols-[4.5rem_minmax(0,1fr)]">
                  <div className="flex items-center gap-2 border-b border-rule bg-bond px-4 py-2 sm:flex-col sm:justify-center sm:border-r sm:border-b-0">
                    <span className="text-sm text-graphite">Gate</span>
                    <span className="text-2xl font-[800] tabular">{g.id}</span>
                  </div>
                  <div className="px-5 py-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="text-lg font-bold">{g.title}</h3>
                      <span
                        className={cn(
                          'rounded-xs border px-1.5 py-0.5 text-xs font-bold',
                          g.status === 'open' ? 'border-wheat-line bg-wheat text-ochre' : 'border-violet-line bg-violet-wash text-violet',
                        )}
                      >
                        {g.status === 'open' ? 'Open' : 'Partly addressed'}
                      </span>
                    </div>
                    <p className="mt-1 text-[15px] text-graphite">{g.body}</p>
                    {'note' in g && g.note ? <p className="mt-2 border-l-4 border-rule pl-3 text-[15px]">{g.note}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
        <aside className="space-y-6">
          <MarginNote title="The short version">
            <p>Liquidity is capital at risk, not a bounty.</p>
            <p>No counterexample does not mean the code is correct.</p>
            <p>Invalid is not a refund.</p>
            <p>Arbitration is paid in ETH on Ethereum and can take weeks.</p>
          </MarginNote>
          <MarginNote title="What Pine never does">
            <p>{COPY.noMergeAuthority}</p>
          </MarginNote>
        </aside>
      </div>
    </Page>
  )
}
