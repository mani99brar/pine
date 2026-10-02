import type { Metadata } from 'next'
import { COPY } from '@pine/core/copy'
import { CircleDashed, CircleDot } from 'lucide-react'
import { SectionHeading } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'

export const metadata: Metadata = {
  title: 'Risks and launch gates',
  description: 'Every risk you accept when you fund or trade a Pine market, and the open decisions that must close before launch.',
}

export default function RisksPage() {
  const open = COPY.launchGates.filter((g) => g.status === 'open').length
  const partial = COPY.launchGates.length - open
  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-8 sm:px-6 sm:pt-10">
      <SectionHeading
        as="h1"
        title="Risks and launch gates"
        description="Read this before you fund a market or trade on one. Nothing here is hidden behind a click elsewhere in the app; the same text appears where each risk applies."
      />

      <section className="mt-12" aria-labelledby="risks">
        <h2 id="risks" className="t-h2">
          What you are accepting
        </h2>
        <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {COPY.disclosures.map((d) => (
            <li key={d.id} id={d.id} className="rounded-[var(--radius-tile)] border border-line bg-sheet p-5">
              <h3 className="t-h3 text-[1.02rem]">{d.title}</h3>
              <p className="mt-2 text-[0.9rem] text-ink-2">{d.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-16" aria-labelledby="gates">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="gates" className="t-h2">
              Launch gates
            </h2>
            <p className="mt-1.5 max-w-[66ch] text-ink-2">
              Decisions from the product specification that are not closed. This release runs as a demonstration until every gate is resolved; none is presented as done.
            </p>
          </div>
          <dl className="flex gap-8">
            <div>
              <dt className="text-[0.78rem] text-ink-3">Open</dt>
              <dd className="t-figure text-[2rem]">{open}</dd>
            </div>
            <div>
              <dt className="text-[0.78rem] text-ink-3">Partly addressed</dt>
              <dd className="t-figure text-[2rem]">{partial}</dd>
            </div>
          </dl>
        </div>
        {/* gate strip: one post per gate */}
        <div className="mt-6 flex gap-1" aria-hidden>
          {COPY.launchGates.map((g) => (
            <span key={g.id} className={cn('h-3 flex-1 rounded-[1px]', g.status === 'open' ? 'border-[1.5px] border-dashed border-ink-3' : 'bg-ink/70')} />
          ))}
        </div>
        <ol className="mt-6 grid gap-3 lg:grid-cols-2">
          {COPY.launchGates.map((g) => (
            <li key={g.id} className="grid grid-cols-[2.5rem_1fr] gap-3 rounded-[var(--radius-tile)] border border-line bg-sheet p-4">
              <span className="t-figure text-[1.5rem] leading-none text-ink-3">{g.id}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-[650]">{g.title}</h3>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.72rem] font-[700]',
                      g.status === 'open' ? 'bg-fog-2 text-ink shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'bg-ink text-on-ink',
                    )}
                  >
                    {g.status === 'open' ? <CircleDashed size={11} aria-hidden /> : <CircleDot size={11} aria-hidden />}
                    {g.status === 'open' ? 'Open' : 'Partly addressed'}
                  </span>
                </div>
                <p className="mt-1 text-[0.9rem] text-ink-2">{g.body}</p>
                {g.note && <p className="mt-2 border-l-[3px] border-line-strong pl-3 text-[0.84rem] text-ink-2">{g.note}</p>}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
