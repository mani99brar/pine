import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { formatDate, getPolicy, POLICY_FAMILIES } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { FamilyIcon } from '@/components/icons'
import { HashChip } from '@/components/ui/interactive'
import { Container, Notice } from '@/components/ui/primitives'
import { SafeMarkdown } from '@/components/ui/SafeMarkdown'
import { FAMILY_VAR } from '@/lib/crystal'
import { PolicyClaims } from './PolicyClaims'

type Params = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params
  const p = getPolicy(decodeURIComponent(id).split('@')[0] ?? id)
  if (!p) return { title: 'Policy not found', robots: { index: false } }
  return {
    title: `${p.id}@${p.version}: ${p.title}`,
    description: p.summary,
    alternates: { canonical: `/policies/${p.id}`, types: { 'application/json': `/api/agent/v1/policies/${p.id}` } },
  }
}

function Section({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <h2 className="t-h4">{title}</h2>
      <ul className="mt-3 grid gap-2 text-[0.9375rem] text-lumen-2">
        {items.map((x, i) => (
          <li key={i} className="flex gap-2.5">
            <span aria-hidden className="mt-[0.6em] h-1.5 w-1.5 shrink-0 rotate-45 bg-lumen-3" />
            <span>{x}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default async function PolicyPage({ params }: Params) {
  const { id } = await params
  const [pid, version] = decodeURIComponent(id).split('@')
  const p = getPolicy(pid ?? id, version)
  if (!p) notFound()
  const fam = POLICY_FAMILIES.find((f) => f.id === p.family)
  const gated = p.status !== 'enabled'
  return (
    <Container>
      <Link href="/policies" className="mt-6 inline-flex text-[0.875rem] text-lumen-3 hover:text-lumen">
        All policies
      </Link>
      <header className="pb-8 pt-6">
        <p className="flex flex-wrap items-center gap-2 text-[0.9375rem]" style={{ color: FAMILY_VAR[p.family] }}>
          <FamilyIcon family={p.family} size={20} />
          <span className="text-lumen-2">{fam?.name}</span>
          {gated ? <span className="tag border-[rgba(183,154,255,0.45)] text-ca">Gated</span> : <span className="tag text-lumen-2">Enabled</span>}
        </p>
        <h1 className="t-h1 chroma mt-3">
          {p.id}@{p.version}: {p.title}
        </h1>
        <p className="t-lead mt-4 max-w-[64ch]">{p.summary}</p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <HashChip value={p.contentHash} label="Content hash" />
          <span className="text-[0.84375rem] text-lumen-3">Published {formatDate(p.publishedAt, 'short')}</span>
          <span className="t-code text-[0.78rem] text-lumen-3">{p.uri}</span>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          {gated ? (
            <Notice tone="caution" title="Publishing is blocked for this policy">
              {p.gateReason ?? COPY.scGate}
            </Notice>
          ) : (
            <Link href={`/compose?policy=${p.id}`} className="btn btn-light">
              Compose a claim with {p.id}
            </Link>
          )}
        </div>
      </header>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Section title="Intended use" items={p.intendedUse} />
        <Section title="Examples" items={p.examples} />
        <Section title="Evidence a counterexample needs" items={p.evidenceRequirements} />
        <Section title="Exclusions" items={p.exclusions} />
      </div>

      <section className="mt-12">
        <h2 className="t-h3">How outcomes are read</h2>
        <dl className="mt-4 grid gap-3 md:grid-cols-3">
          {(
            [
              ['Yes', COPY.outcome.yes, p.outcomeRules.yes, 'var(--ha)'],
              ['No', COPY.outcome.no, p.outcomeRules.no, 'var(--moon)'],
              ['Invalid', COPY.outcome.invalid, p.outcomeRules.invalid, 'var(--frost)'],
            ] as const
          ).map(([k, label, rule, color]) => (
            <div key={k} className="glass cut-lg p-5">
              <dt className="font-semibold" style={{ color: k === 'Yes' ? color : 'var(--lumen)' }}>
                {label}
              </dt>
              <dd className="mt-2 text-[0.9rem] text-lumen-2">{rule}</dd>
            </div>
          ))}
        </dl>
      </section>

      {p.claimClasses.length > 0 && (
        <section className="mt-12">
          <h2 className="t-h3">Claim classes</h2>
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {p.claimClasses.map((c) => (
              <li key={c.id} className="glass cut-md p-4">
                <p className="font-semibold text-lumen">{c.label}</p>
                <p className="mt-1 text-[0.875rem] text-lumen-2">{c.description}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-12">
        <h2 className="t-h3">Parameters a claim must set</h2>
        <ul className="mt-4 grid gap-2">
          {p.parameters.map((x) => (
            <li key={x.key} className="grid gap-1 border-b border-edge pb-3 sm:grid-cols-[14rem_1fr]">
              <p className="font-medium text-lumen">
                {x.label} {!x.required && <span className="text-[0.8rem] font-normal text-lumen-3">optional</span>}
              </p>
              <p className="text-[0.875rem] text-lumen-2">{x.help}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-12">
        <h2 className="t-h3">Full policy text</h2>
        <div className="glass cut-xl mt-4 max-h-[36rem] overflow-y-auto p-6">
          <SafeMarkdown className="text-[0.9375rem]">{p.text}</SafeMarkdown>
        </div>
      </section>

      <section className="mt-12">
        <h2 className="t-h3 mb-4">Claims under {p.id}</h2>
        <PolicyClaims policyId={p.id} />
      </section>
    </Container>
  )
}
