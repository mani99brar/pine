import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Lock } from 'lucide-react'
import { POLICIES, getPolicy, getPolicyFamily } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { CopyButton } from '@/components/ui/copy-button'
import { HashChip } from '@/components/ui/hash-chip'
import { PageHeader } from '@/components/ui/page-header'
import { Pane } from '@/components/ui/pane'
import { SafeMarkdown } from '@/components/ui/safe-markdown'

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }

export function generateStaticParams() {
  return POLICIES.map((p) => ({ id: p.id }))
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { id } = await params
  const sp = await searchParams
  const p = getPolicy(id.toUpperCase(), typeof sp.version === 'string' ? sp.version : undefined)
  if (!p) return { title: 'Policy not found' }
  return {
    title: `${p.id}@${p.version} ${p.title}`,
    description: p.summary,
    alternates: { types: { 'application/json': `/api/agent/v1/policies/${p.id}` } },
  }
}

export default async function PolicyPage({ params, searchParams }: Props) {
  const { id } = await params
  const sp = await searchParams
  const p = getPolicy(id.toUpperCase(), typeof sp.version === 'string' ? sp.version : undefined)
  if (!p) notFound()
  const family = getPolicyFamily(p.family)
  const versions = POLICIES.filter((x) => x.id === p.id)
  const gated = p.status !== 'enabled'
  return (
    <div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-baseline gap-x-3">
            <span className="mono-cond text-[22px] font-semibold sm:text-[26px]">{p.id}</span>
            <span>{p.title}</span>
          </span>
        }
        description={p.summary}
        actions={
          gated ? (
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-violet">
              <Lock size={14} aria-hidden /> Gated: not available for new claims
            </span>
          ) : (
            <Button asChild variant="primary">
              <Link href={`/new?policy=${p.id}`}>Verify a commit with {p.id}</Link>
            </Button>
          )
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
          <span>{family?.name}</span>
          <span className="text-faint">/</span>
          <span>
            Version{' '}
            {versions.map((v) => (
              <Link key={v.version} href={`/policies/${p.id}?version=${v.version}`} className={v.version === p.version ? 'mono-cond font-semibold text-bark' : 'mono-cond text-needle'}>
                {v.version}
              </Link>
            ))}
          </span>
          <span className="text-faint">/</span>
          <span>published {p.publishedAt.slice(0, 10)}</span>
          <HashChip label="keccak256(text)" value={p.contentHash} head={10} tail={6} />
          <span className="mono-cond text-[11.5px]">{p.uri}</span>
        </div>
      </PageHeader>

      {gated ? (
        <div className="border-b border-line bg-surface px-4 py-4 sm:px-8">
          <Callout tone="gate" title="Requires approved disclosure process">
            {p.gateReason ?? COPY.scGate}
          </Callout>
        </div>
      ) : null}

      <div className="grid grid-cols-1 bg-surface xl:grid-cols-[minmax(0,1fr)_420px] xl:divide-x xl:divide-line">
        <Pane title="Full policy text" className="border-0" actions={<CopyButton value={p.text} label="policy text" />} description="This exact text is hashed and referenced by every claim that uses this version">
          <div className="px-4 py-5 sm:px-8">
            <SafeMarkdown>{p.text}</SafeMarkdown>
          </div>
        </Pane>
        <div className="divide-y divide-line border-t border-line xl:border-t-0">
          <Pane title="Parameters a claim must set" className="border-0">
            <dl className="divide-y divide-line">
              {p.parameters.map((x) => (
                <div key={x.key} className="px-4 py-2.5">
                  <dt className="flex flex-wrap items-baseline gap-2 text-[13.5px] font-medium">
                    {x.label}
                    <span className="mono-cond text-[11px] text-muted">
                      {x.key}: {x.kind}
                    </span>
                    {x.required ? <span className="text-[11px] text-resin">required</span> : null}
                  </dt>
                  <dd className="mt-0.5 text-[12.5px] text-muted">{x.help}</dd>
                </div>
              ))}
            </dl>
          </Pane>
          {p.claimClasses.length ? (
            <Pane title="Claim classes" className="border-0">
              <ul className="divide-y divide-line">
                {p.claimClasses.map((c) => (
                  <li key={c.id} className="px-4 py-2.5">
                    <p className="text-[13.5px] font-medium">{c.label}</p>
                    <p className="text-[12.5px] text-muted">{c.description}</p>
                  </li>
                ))}
              </ul>
            </Pane>
          ) : null}
          <Pane title="Outcome rules" className="border-0">
            <dl className="space-y-2 px-4 py-3 text-[13px]">
              <div>
                <dt className="font-semibold">{COPY.outcome.yes}</dt>
                <dd className="text-muted">{p.outcomeRules.yes}</dd>
              </div>
              <div>
                <dt className="font-semibold">{COPY.outcome.no}</dt>
                <dd className="text-muted">{p.outcomeRules.no}</dd>
              </div>
              <div>
                <dt className="font-semibold">{COPY.outcome.invalid}</dt>
                <dd className="text-muted">{p.outcomeRules.invalid}</dd>
              </div>
            </dl>
          </Pane>
          <Pane title="Evidence must include" className="border-0">
            <ul className="list-disc space-y-1 py-3 pl-8 pr-4 text-[13px]">
              {p.evidenceRequirements.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Pane>
          <Pane title="Never qualifies" className="border-0">
            <ul className="list-disc space-y-1 py-3 pl-8 pr-4 text-[13px]">
              {p.exclusions.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Pane>
        </div>
      </div>
    </div>
  )
}
