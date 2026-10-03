import type { Metadata } from 'next'
import { COPY } from '@pine/core/copy'
import { Container, PageHeader } from '@/components/ui/primitives'

export const metadata: Metadata = {
  title: 'Risks and launch gates',
  description: 'What can go wrong with your capital, what each outcome means and does not mean, and the launch decisions that are still open.',
}

export default function RisksPage() {
  return (
    <Container>
      <PageHeader title="Risks and launch gates" lead="Read this before you fund a market. Every disclosure here is shown again, with your real numbers, before anything is signed." />
      <nav aria-label="On this page" className="mb-10 flex flex-wrap gap-2">
        <a href="#disclosures" className="chip">
          Disclosures
        </a>
        <a href="#gates" className="chip">
          Launch gates
        </a>
      </nav>
      <section id="disclosures" aria-labelledby="disclosures-title" className="scroll-mt-28">
        <h2 id="disclosures-title" className="t-h2 mb-6">
          Disclosures
        </h2>
        <ol className="grid gap-4 md:grid-cols-2">
          {COPY.disclosures.map((d) => (
            <li key={d.id} id={d.id} className="glass cut-lg scroll-mt-28 p-5">
              <h3 className="t-h4">{d.title}</h3>
              <p className="mt-2 text-[0.9375rem] leading-[1.6] text-lumen-2">{d.body}</p>
            </li>
          ))}
        </ol>
      </section>
      <section id="gates" aria-labelledby="gates-title" className="mt-16 scroll-mt-28">
        <h2 id="gates-title" className="t-h2">
          Launch gates
        </h2>
        <p className="t-lead mt-3 max-w-[64ch]">Decisions from the product specification that are not settled. None of them is presented as closed.</p>
        <ol className="mt-6 grid gap-3">
          {COPY.launchGates.map((g) => (
            <li key={g.id} className="glass cut-md grid gap-2 p-5 sm:grid-cols-[3rem_minmax(0,1fr)_auto] sm:items-start">
              <span className="t-figure text-[1.6rem] leading-none text-lumen-3">{g.id}</span>
              <div className="min-w-0">
                <h3 className="t-h4">{g.title}</h3>
                <p className="mt-1 text-[0.9rem] text-lumen-2">{g.body}</p>
                {g.note && <p className="mt-2 text-[0.84375rem] text-lumen-3">{g.note}</p>}
              </div>
              <span className={g.status === 'open' ? 'tag border-[rgba(255,182,72,0.45)] text-na' : 'tag text-lumen-2'}>{g.status === 'open' ? 'Open' : 'Partly addressed'}</span>
            </li>
          ))}
        </ol>
      </section>
    </Container>
  )
}
