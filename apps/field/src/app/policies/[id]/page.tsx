import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { POLICIES, POLICY_FAMILIES, formatDate, getPolicy, shortHash } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { ChevronRight, Lock, Plus } from 'lucide-react'
import { PolicyShape } from '@/components/glyphs/PolicyMark'
import { OutcomeSwatch } from '@/components/glyphs/Status'
import { SafeMarkdown } from '@/components/ui/SafeMarkdown'
import { HashChip } from '@/components/ui/interactive'
import { ButtonLink } from '@/components/ui/Button'
import { KV, Note } from '@/components/ui/primitives'
import { PolicyClaims } from './PolicyClaims'

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }

export function generateStaticParams() {
  return POLICIES.map((p) => ({ id: p.id }))
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { id } = await params
  const { v } = await searchParams
  const p = getPolicy(id, v)
  if (!p) return { title: 'Policy not found' }
  return {
    title: `${p.id}@${p.version}: ${p.title}`,
    description: p.summary,
    alternates: { types: { 'application/json': `/api/agent/v1/policies/${p.id}` } },
  }
}

export default async function PolicyPage({ params, searchParams }: Props) {
  const { id } = await params
  const { v } = await searchParams
  const p = getPolicy(id, v)
  if (!p) notFound()
  const gated = p.status === 'gated'
  const fam = POLICY_FAMILIES.find((f) => f.id === p.family)
  const versions = POLICIES.filter((x) => x.id === p.id)

  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-6 sm:px-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[0.84rem] text-ink-3">
        <Link href="/policies" className="hover:text-ink hover:underline">
          Policies
        </Link>
        <ChevronRight size={13} aria-hidden />
        <span className="text-ink-2" aria-current="page">
          {p.id}
        </span>
      </nav>

      <header className="mt-6 grid gap-8 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-start">
        <span className={gated ? 'text-ink-3' : 'text-ink'}>
          <PolicyShape family={p.family} gated={gated} size={96} />
        </span>
        <div className="min-w-0">
          <p className="t-figure text-[1.1rem] text-ink-2">
            {p.id}@{p.version}
          </p>
          <h1 className="t-h1 mt-1">{p.title}</h1>
          {fam && <p className="mt-1 text-ink-3">{fam.name} family. {fam.tagline}</p>}
          <p className="mt-3 max-w-[70ch] text-[1.05rem] text-ink-2">{p.summary}</p>
        </div>
        {!gated ? (
          <ButtonLink href={`/compose?policy=${p.id}`} icon={<Plus size={16} aria-hidden />}>
            Put a {p.id} claim on the board
          </ButtonLink>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-fog-2 px-3 py-1.5 text-[0.84rem] font-[650]">
            <Lock size={13} aria-hidden /> Gated: not available for new claims
          </span>
        )}
      </header>

      {gated && (
        <Note tone="caution" className="mt-8" title="Requires an approved disclosure process">
          {p.gateReason ?? COPY.scGate}
        </Note>
      )}

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 content-start gap-10">
          <section aria-labelledby="ev">
            <h2 id="ev" className="t-h2">
              What counts as evidence
            </h2>
            <ol className="mt-3 grid gap-2">
              {p.evidenceRequirements.map((r, i) => (
                <li key={i} className="flex gap-3 text-ink-2">
                  <span aria-hidden className="t-figure mt-[0.1em] w-4 shrink-0 text-right text-[1rem] text-ink-3">
                    {i + 1}
                  </span>
                  {r}
                </li>
              ))}
            </ol>
          </section>
          <section aria-labelledby="ex">
            <h2 id="ex" className="t-h2">
              Exclusions
            </h2>
            <ul className="mt-3 grid gap-2">
              {p.exclusions.map((r, i) => (
                <li key={i} className="flex gap-3 text-ink-2">
                  <span aria-hidden className="mt-[0.7em] h-[3px] w-3 shrink-0 bg-ink-3" />
                  {r}
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="out">
            <h2 id="out" className="t-h2">
              Outcomes
            </h2>
            <ul className="mt-3 grid gap-3">
              {(['yes', 'no', 'invalid'] as const).map((k) => (
                <li key={k} className="grid grid-cols-[auto_1fr] gap-3 rounded-[var(--radius-tile)] border border-line bg-sheet p-4">
                  <OutcomeSwatch outcome={k} className="mt-1 h-8 w-2.5" />
                  <div>
                    <p className="font-[650]">{COPY.outcome[k]}</p>
                    <p className="mt-0.5 text-[0.9rem] text-ink-2">{p.outcomeRules[k]}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          {p.claimClasses.length > 0 && (
            <section aria-labelledby="cls">
              <h2 id="cls" className="t-h2">
                Claim classes
              </h2>
              <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                {p.claimClasses.map((c) => (
                  <li key={c.id} className="rounded-[var(--radius-tile)] border border-line bg-sheet p-4">
                    <p className="font-[650]">{c.label}</p>
                    <p className="mt-1 text-[0.88rem] text-ink-2">{c.description}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby="params">
            <h2 id="params" className="t-h2">
              Parameters a claim must set
            </h2>
            <div className="mt-3 relative overflow-x-auto rounded-[var(--radius-tile)] border border-line bg-sheet">
              <table className="w-full min-w-[36rem] text-[0.88rem]">
                <thead>
                  <tr className="border-b border-line text-left text-[0.78rem] text-ink-3">
                    <th className="px-4 py-2.5 font-[600]">Parameter</th>
                    <th className="px-4 py-2.5 font-[600]">Kind</th>
                    <th className="px-4 py-2.5 font-[600]">What it means</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {p.parameters.map((x) => (
                    <tr key={x.key}>
                      <td className="px-4 py-3 align-top">
                        <span className="font-[620]">{x.label}</span>
                        <span className="block text-[0.75rem] text-ink-3">{x.required ? 'required' : 'optional'}</span>
                      </td>
                      <td className="px-4 py-3 align-top text-ink-2">{x.kind}</td>
                      <td className="px-4 py-3 align-top text-ink-2">{x.help}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section aria-labelledby="full">
            <h2 id="full" className="t-h2">
              Full text
            </h2>
            <p className="mt-1 text-[0.84rem] text-ink-3">This exact text is what the hash commits to.</p>
            <div className="mt-4 rounded-[var(--radius-tile)] border border-line bg-sheet p-5 sm:p-7">
              <SafeMarkdown>{p.text}</SafeMarkdown>
            </div>
          </section>
        </div>

        <aside className="grid min-w-0 content-start gap-6">
          <section className="rounded-[var(--radius-tile)] border-[1.5px] border-ink bg-sheet p-5" aria-labelledby="ids">
            <h2 id="ids" className="t-h3">
              Identity
            </h2>
            <KV
              className="mt-2"
              rows={[
                { k: 'Version', v: p.version },
                { k: 'Status', v: p.status },
                { k: 'Text hash', v: <HashChip value={p.contentHash} display={shortHash(p.contentHash, 4)} label="keccak256" /> },
                { k: 'Location', v: <code className="t-code break-all text-[0.78rem]">{p.uri}</code> },
                { k: 'Published', v: formatDate(p.publishedAt, 'short') },
                ...(p.supersedes ? [{ k: 'Supersedes', v: p.supersedes }] : []),
              ]}
            />
            <p className="mt-3 text-[0.8rem]">
              <a href={`/api/agent/v1/policies/${p.id}`} className="underline underline-offset-2">
                Machine-readable JSON
              </a>
            </p>
          </section>
          {versions.length > 1 && (
            <section className="rounded-[var(--radius-tile)] border border-line bg-sheet p-5">
              <h2 className="t-h3">Versions</h2>
              <ul className="mt-2 grid gap-1 text-[0.88rem]">
                {versions.map((x) => (
                  <li key={x.version}>
                    <Link href={`/policies/${x.id}?v=${x.version}`} className="underline underline-offset-2">
                      {x.version}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby="use">
            <h2 id="use" className="t-h3">
              Intended use
            </h2>
            <ul className="mt-2 grid gap-1.5 text-[0.88rem] text-ink-2">
              {p.intendedUse.map((u, i) => (
                <li key={i}>{u}</li>
              ))}
            </ul>
            {p.examples.length > 0 && (
              <>
                <h3 className="mt-5 text-[0.88rem] font-[650]">Example claims</h3>
                <ul className="mt-2 grid gap-1.5 text-[0.88rem] text-ink-2">
                  {p.examples.map((u, i) => (
                    <li key={i}>{u}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <PolicyClaims policyId={p.id} />
        </aside>
      </div>
    </div>
  )
}
