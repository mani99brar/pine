import type { Metadata } from 'next'
import Link from 'next/link'
import { Lock } from 'lucide-react'
import { POLICIES, POLICY_FAMILIES } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { HashChip } from '@/components/ui/hash-chip'
import { PageHeader } from '@/components/ui/page-header'

export const metadata: Metadata = {
  title: 'Policies',
  description: 'The reviewed catalog of versioned verification policies. Each defines what counts as an admissible counterexample.',
}

export default function PoliciesPage() {
  return (
    <div>
      <PageHeader
        title="Policies"
        description="A small reviewed catalog, not free-form court rules. You parameterize a policy, and its full text and hash are referenced in the immutable question. Revisions apply only to future claims."
      />
      <div className="divide-y divide-line bg-surface">
        {POLICY_FAMILIES.map((fam) => {
          const list = POLICIES.filter((p) => p.family === fam.id)
          return (
            <section key={fam.id} className="grid grid-cols-1 gap-4 px-4 py-6 sm:px-8 lg:grid-cols-[260px_minmax(0,1fr)]" aria-labelledby={`fam-${fam.id}`}>
              <div>
                <h2 id={`fam-${fam.id}`} className="stretch-wide text-[17px] font-[650]">
                  {fam.name}
                </h2>
                <p className="mt-1 text-[13px] text-muted">{fam.tagline}</p>
              </div>
              <ul className="space-y-3">
                {list.map((p) => (
                  <li key={p.id}>
                    <Link href={`/policies/${p.id}`} className="group block rounded-ctl border border-line px-4 py-3 hover:border-needle">
                      <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                        <span className="mono-cond text-[12.5px] font-semibold">{p.id}</span>
                        <span className="text-[15px] font-medium group-hover:text-needle">{p.title}</span>
                        <span className="mono-cond text-[11.5px] text-muted">v{p.version}</span>
                        {p.status === 'gated' ? (
                          <span className="flex items-center gap-1 text-[12px] font-medium text-violet">
                            <Lock size={12} aria-hidden /> gated
                          </span>
                        ) : (
                          <span className="text-[12px] text-needle">enabled</span>
                        )}
                        <span className="ml-auto">
                          <HashChip label="text" value={p.contentHash} />
                        </span>
                      </span>
                      <span className="mt-1 block max-w-[80ch] text-[13.5px] text-muted">{p.summary}</span>
                      {p.status === 'gated' ? <span className="mt-1 block text-[12.5px] text-violet">{p.gateReason ?? COPY.scGate}</span> : null}
                      <span className="mt-2 flex flex-wrap gap-x-4 text-[12px] text-muted">
                        <span>{p.parameters.length} parameters</span>
                        <span>{p.claimClasses.length} claim classes</span>
                        <span>{p.evidenceRequirements.length} evidence requirements</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}
