import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getPolicy, formatDate, POLICY_FAMILIES } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { Lock } from 'lucide-react'
import { Page, PageHeader, DefinitionList } from '@/components/ui/layout'
import { HashValue } from '@/components/ui/copy'
import { SafeMarkdown } from '@/components/ui/safe-markdown'
import { MarginNote } from '@/components/ui/field'
import { serverData, safely } from '@/lib/server-data'

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ version?: string }> }

async function load(id: string, version?: string) {
  const fromData = await safely(() => serverData().getPolicy(id.toUpperCase(), version), null)
  return fromData ?? getPolicy(id.toUpperCase(), version) ?? null
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { id } = await params
  const { version } = await searchParams
  const p = await load(id, version)
  if (!p) return { title: 'Policy not found' }
  return {
    title: `${p.id}@${p.version}: ${p.title}`,
    description: p.summary,
    alternates: { canonical: `/policies/${p.id}`, types: { 'application/json': `/api/agent/v1/policies/${p.id}` } },
  }
}

const KIND: Record<string, string> = {
  text: 'Short text',
  longtext: 'Paragraph',
  select: 'One choice',
  multiselect: 'Several choices',
  list: 'List',
  boolean: 'Yes or no',
  address: 'Address',
  hash: 'Hash',
  url: 'Link',
}

export default async function PolicyPage({ params, searchParams }: Props) {
  const { id } = await params
  const { version } = await searchParams
  const p = await load(id, version)
  if (!p) notFound()
  const fam = POLICY_FAMILIES.find((f) => f.id === p.family)
  const gated = p.status !== 'enabled'
  return (
    <Page>
      <PageHeader
        crumbs={[{ href: '/policies', label: 'Policies' }, { label: `${p.id}@${p.version}` }]}
        title={<span className="record-title">{p.title}</span>}
        lead={p.summary}
        meta={
          <p className="flex flex-wrap items-center gap-3 text-[15px]">
            <span className="font-[800] text-violet tabular">
              {p.id}@{p.version}
            </span>
            <span className="text-graphite">{fam?.name}</span>
            <span className="text-graphite">Published {formatDate(p.publishedAt, 'short')}</span>
          </p>
        }
      />
      {gated ? (
        <div className="mb-8 flex gap-3 border-l-8 border-plum bg-mauve px-5 py-4">
          <Lock aria-hidden className="mt-1 size-5 shrink-0 text-plum" />
          <div>
            <p className="text-lg font-bold text-plum">Gated: shown for reference, not available for new claims</p>
            <p className="mt-1 measure">{p.gateReason ?? COPY.scGate}</p>
          </div>
        </div>
      ) : null}
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <article className="min-w-0 space-y-10 border border-rule bg-sheet px-5 py-7 sm:px-9" data-print="flat">
          <DefinitionList
            items={[
              { term: 'Text hash', value: <HashValue value={p.contentHash} wrap label="policy text hash" />, note: 'keccak256 of the exact policy text below. Markets cite this hash.' },
              p.uri.startsWith('ipfs://pending')
                ? {
                    term: 'Durable location',
                    value: 'Not pinned yet',
                    note: 'The text is not on IPFS yet. Until it is, the hash above is what identifies it. Pinning policy text is an open launch gate.',
                  }
                : { term: 'Durable location', value: <code className="font-mono text-[14px] break-all">{p.uri}</code> },
              { term: 'Status', value: gated ? 'Gated' : 'Enabled for new claims' },
              ...(p.supersedes ? [{ term: 'Supersedes', value: p.supersedes }] : []),
            ]}
          />
          <section>
            <h2 className="text-2xl">Intended use</h2>
            <ul className="mt-3 list-disc space-y-1.5 pl-5 measure">
              {p.intendedUse.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
            {p.examples.length ? (
              <>
                <h3 className="mt-6 text-lg font-bold">Example claims</h3>
                <ul className="mt-2 space-y-2">
                  {p.examples.map((e) => (
                    <li key={e} className="record border-l-4 border-rule pl-4 text-[17px] leading-7">
                      {e}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
          {p.claimClasses.length ? (
            <section>
              <h2 className="text-2xl">Kinds of claim</h2>
              <dl className="mt-3 divide-y divide-rule border-y border-rule">
                {p.claimClasses.map((c) => (
                  <div key={c.id} className="py-3">
                    <dt className="font-bold">{c.label}</dt>
                    <dd className="text-[15px] text-graphite">{c.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          <section>
            <h2 className="text-2xl">What a filer must specify</h2>
            <div tabIndex={0} role="region" aria-label="Policy parameters" className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-[15px]">
                <thead className="border-b-2 border-ink text-sm text-graphite">
                  <tr>
                    <th scope="col" className="py-2 pr-4">Field</th>
                    <th scope="col" className="py-2 pr-4">Form</th>
                    <th scope="col" className="py-2">What it means</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {p.parameters.map((x) => (
                    <tr key={x.key} className="align-top">
                      <td className="py-2.5 pr-4 font-bold">
                        {x.label}
                        {!x.required ? <span className="block text-sm font-normal text-graphite">Optional</span> : null}
                      </td>
                      <td className="py-2.5 pr-4 whitespace-nowrap text-graphite">{KIND[x.kind] ?? x.kind}</td>
                      <td className="py-2.5">{x.help}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="grid gap-8 md:grid-cols-2">
            <div>
              <h2 className="text-2xl">What evidence must show</h2>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                {p.evidenceRequirements.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className="text-2xl">Excluded</h2>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                {p.exclusions.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          </section>
          <section>
            <h2 className="text-2xl">How outcomes read under this policy</h2>
            <dl className="mt-3 space-y-3">
              <div className="border-l-8 border-red bg-red-wash px-4 py-3">
                <dt className="font-bold text-red">Yes: {COPY.outcome.yes}</dt>
                <dd className="mt-1">{p.outcomeRules.yes}</dd>
              </div>
              <div className="border-l-8 border-slate bg-mist px-4 py-3">
                <dt className="font-bold text-slate">No: {COPY.outcome.no}</dt>
                <dd className="mt-1">{p.outcomeRules.no}</dd>
              </div>
              <div className="hatch border-l-8 border-graphite px-4 py-3">
                <dt className="font-bold text-graphite">Invalid</dt>
                <dd className="mt-1">{p.outcomeRules.invalid}</dd>
              </div>
            </dl>
          </section>
          <section>
            <h2 className="text-2xl">Full text</h2>
            <p className="mt-1 text-[15px] text-graphite">This is the exact text the hash above is computed from.</p>
            <details className="mt-3" open>
              <summary className="font-bold text-violet underline underline-offset-4">Show or hide the full text</summary>
              <div className="record mt-4 max-w-none border-l-4 border-ink pl-5 text-[17px] leading-7">
                <SafeMarkdown>{p.text}</SafeMarkdown>
              </div>
            </details>
          </section>
        </article>
        <aside className="space-y-6">
          <MarginNote title="Using this policy">
            {gated ? <p>This policy cannot be selected for new claims yet.</p> : <p>Choose it in step 2 of a filing. Its parameters appear on the same step.</p>}
            <p>
              <Link href={`/docket?policy=${p.id}`} className="link">
                See claims filed under {p.id}
              </Link>
            </p>
          </MarginNote>
          <MarginNote title="For agents">
            <p>
              The same text and hash are served at <a className="link break-all" href={`/api/agent/v1/policies/${p.id}`}>/api/agent/v1/policies/{p.id}</a>.
            </p>
          </MarginNote>
        </aside>
      </div>
    </Page>
  )
}
