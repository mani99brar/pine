import type { Metadata } from 'next'
import Link from 'next/link'
import { POLICIES, POLICY_FAMILIES, formatDate, shortHash } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { Lock } from 'lucide-react'
import { PolicyShape } from '@/components/glyphs/PolicyMark'
import { SectionHeading } from '@/components/ui/primitives'

export const metadata: Metadata = {
  title: 'Policy catalog',
  description: 'The reviewed policy templates that define what counts as a counterexample: FUNC-001, BOT-001 and SC-001 (gated).',
}

export default function PoliciesPage() {
  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-8 sm:px-6 sm:pt-10">
      <SectionHeading
        as="h1"
        title="Policy catalog"
        description="Every claim selects one bounded requirement inside a reviewed, versioned policy. The policy text is hashed into the market question, and a new version never changes claims already published."
      />
      <ul className="mt-10 grid gap-4 lg:grid-cols-3">
        {POLICIES.map((p) => {
          const fam = POLICY_FAMILIES.find((f) => f.id === p.family)
          const gated = p.status === 'gated'
          return (
            <li key={p.id} className="flex">
              <Link
                href={`/policies/${p.id}`}
                className={`group flex w-full flex-col rounded-[var(--radius-tile)] bg-sheet p-6 transition-colors ${gated ? 'border-[1.5px] border-dashed border-line-strong hover:border-ink' : 'border border-line hover:border-ink'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className={gated ? 'text-ink-3' : 'text-ink'}>
                    <PolicyShape family={p.family} gated={gated} size={64} />
                  </span>
                  {gated ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-fog-2 px-2.5 py-1 text-[0.75rem] font-[650]">
                      <Lock size={12} aria-hidden /> Gated
                    </span>
                  ) : (
                    <span className="rounded-full bg-ink px-2.5 py-1 text-[0.75rem] font-[650] text-on-ink">Enabled</span>
                  )}
                </div>
                <p className="t-figure mt-5 text-[2rem]">{p.id}</p>
                <p className="mt-1 text-[1.05rem] font-[650]">{p.title}</p>
                {fam && <p className="mt-0.5 text-[0.84rem] text-ink-3">{fam.name} family</p>}
                <p className="mt-3 text-[0.92rem] text-ink-2">{p.summary}</p>
                {gated && <p className="mt-3 text-[0.84rem] font-[600]">{(p.gateReason ?? COPY.scGate).split('. ')[0]}.</p>}
                <dl className="mt-auto grid grid-cols-3 gap-3 border-t border-line pt-4 text-[0.78rem]">
                  <div>
                    <dt className="text-ink-3">Version</dt>
                    <dd className="t-figure text-[1rem]">{p.version}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-3">Text hash</dt>
                    <dd className="t-code text-[0.78rem]">{shortHash(p.contentHash)}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-3">Published</dt>
                    <dd>{formatDate(p.publishedAt, 'short')}</dd>
                  </div>
                </dl>
              </Link>
            </li>
          )
        })}
      </ul>
      <section className="mt-14 grid gap-6 md:grid-cols-2" aria-labelledby="gov">
        <div>
          <h2 id="gov" className="t-h2">
            How policies change
          </h2>
          <p className="mt-3 max-w-[60ch] text-ink-2">
            The catalog is small and reviewed; customers parameterize a template rather than writing their own court rules. Revisions only affect future markets. Published claims
            keep the exact text they pinned, by hash, and no label, documentation update or administrator preference can change funded market terms.
          </p>
        </div>
        <div>
          <h2 className="t-h2">What a policy is not</h2>
          <p className="mt-3 max-w-[60ch] text-ink-2">
            A family name such as &ldquo;smart-contract security&rdquo; is not a resolvable claim. Each market selects one bounded proposition. {COPY.notAReview}
          </p>
        </div>
      </section>
    </div>
  )
}
