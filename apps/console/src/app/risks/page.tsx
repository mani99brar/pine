import type { Metadata } from 'next'
import { COPY } from '@pine/core/copy'
import { CHAINS, SUPPORTED_CHAIN_IDS } from '@pine/core/chains'
import { cn } from '@/lib/cn'
import { PageHeader } from '@/components/ui/page-header'

export const metadata: Metadata = {
  title: 'Risks and launch gates',
  description: 'What you can lose, what the outcomes mean, and which launch decisions are still open.',
}

export default function RisksPage() {
  return (
    <div>
      <PageHeader
        title="Risks and launch gates"
        description="Read this before funding a claim. These are the same disclosures you acknowledge in the composer, plus the decisions that must be resolved before Pine handles real funds."
      />
      <div className="bg-surface">
        <section className="border-b border-line px-4 py-6 sm:px-8" aria-labelledby="disc-h">
          <h2 id="disc-h" className="stretch-wide text-[18px] font-[650]">
            Disclosures
          </h2>
          <dl className="mt-4 grid gap-x-10 gap-y-5 md:grid-cols-2 2xl:grid-cols-3">
            {COPY.disclosures.map((d) => (
              <div key={d.id} id={d.id} className="scroll-mt-16 border-t border-line pt-3">
                <dt className="text-[14.5px] font-semibold">{d.title}</dt>
                <dd className="mt-1 text-[13.5px] leading-[1.55] text-muted">{d.body}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="border-b border-line px-4 py-6 sm:px-8" aria-labelledby="gates-h">
          <h2 id="gates-h" className="stretch-wide text-[18px] font-[650]">
            Launch gates
          </h2>
          <p className="mt-1 max-w-[72ch] text-[13.5px] text-muted">Open decisions from the product specification. None of them is closed by this frontend release.</p>
          <ol className="mt-4 divide-y divide-line rounded-ctl border border-line">
            {COPY.launchGates.map((g) => (
              <li key={g.id} className="grid grid-cols-1 gap-x-4 gap-y-1 px-4 py-3 md:grid-cols-[3rem_minmax(0,1fr)_10rem]">
                <span className="mono-cond tnum text-[12px] text-faint">{String(g.id).padStart(2, '0')}</span>
                <div>
                  <p className="text-[14px] font-semibold">{g.title}</p>
                  <p className="mt-0.5 text-[13px] text-muted">{g.body}</p>
                  {g.note ? <p className="mt-1 text-[12.5px] text-bark">This release: {g.note}</p> : null}
                </div>
                <span className={cn('h-fit w-fit rounded-chip border px-1.5 text-[12px] font-medium', g.status === 'open' ? 'border-resin/50 text-resin' : 'border-slate/40 text-slate')}>
                  {g.status === 'open' ? 'Open' : 'Partially addressed'}
                </span>
              </li>
            ))}
          </ol>
        </section>
        <section className="px-4 py-6 sm:px-8" aria-labelledby="chains-h">
          <h2 id="chains-h" className="stretch-wide text-[18px] font-[650]">
            Chain integration status
          </h2>
          <div className="scrollbar-thin mt-4 relative overflow-x-auto rounded-ctl border border-line">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead>
                <tr className="stretch-cond border-b border-line bg-sunken text-left text-[12px] text-muted">
                  <th className="px-3 py-2 font-medium">Chain</th>
                  <th className="px-3 py-2 font-medium">Collateral</th>
                  <th className="px-3 py-2 font-medium">Arbitration</th>
                  <th className="px-3 py-2 font-medium">Addresses</th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {SUPPORTED_CHAIN_IDS.map((id) => {
                  const c = CHAINS[id]!
                  return (
                    <tr key={id} className="border-b border-line align-top last:border-0">
                      <td className="px-3 py-2.5 font-medium">
                        {c.name} <span className="mono-cond text-[11px] text-muted">{id}</span>
                      </td>
                      <td className="px-3 py-2.5">{c.collateral.symbol}</td>
                      <td className="px-3 py-2.5 text-muted">
                        {c.arbitration.courtName}, about {c.arbitration.feeEstimate} {c.arbitration.feeCurrency}
                      </td>
                      <td className={cn('px-3 py-2.5', c.verified ? 'text-needle' : 'text-resin')}>{c.verified ? `checked ${c.verifiedAt ?? ''}` : 'unverified'}</td>
                      <td className="px-3 py-2.5 text-[12.5px] text-muted">{c.notes.join(' ')}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}
