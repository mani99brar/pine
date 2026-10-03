import type { Metadata } from 'next'
import Link from 'next/link'
import type { PolicyVersion } from '@pine/core'
import { POLICIES, POLICY_FAMILIES, shortHash } from '@pine/core'
import { Lock } from 'lucide-react'
import { Page, PageHeader } from '@/components/ui/layout'
import { MarginNote } from '@/components/ui/field'
import { serverData, safely } from '@/lib/server-data'

export const metadata: Metadata = {
  title: 'Policy catalog',
  description: 'The reviewed policies a claim can use. Each is versioned and hashed; revisions never change claims already filed.',
  alternates: { canonical: '/policies', types: { 'application/json': '/api/agent/v1/policies' } },
}

export default async function PoliciesPage() {
  const policies = await safely(() => serverData().listPolicies(), POLICIES as PolicyVersion[])
  const list = policies.length ? policies : (POLICIES as PolicyVersion[])
  return (
    <Page>
      <PageHeader
        title="Policy catalog"
        lead="A small, reviewed set of rulebooks. A claim picks one policy and one bounded requirement inside it. Customers fill in the template; they do not write their own rules."
      />
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <ol className="space-y-5">
          {list.map((p) => {
            const fam = POLICY_FAMILIES.find((f) => f.id === p.family)
            const gated = p.status !== 'enabled'
            return (
              <li key={`${p.id}@${p.version}`} className="border border-rule bg-sheet">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-3 sm:px-6">
                  <p className="font-[800] text-violet tabular">
                    {p.id}@{p.version}
                  </p>
                  {gated ? (
                    <span className="inline-flex items-center gap-1.5 rounded-xs border border-mauve-line bg-mauve px-2 py-0.5 text-sm font-bold text-plum">
                      <Lock aria-hidden className="size-3.5" /> Gated: not available for new claims
                    </span>
                  ) : (
                    <span className="rounded-xs border border-violet-line bg-violet-wash px-2 py-0.5 text-sm font-bold text-violet">Enabled</span>
                  )}
                </div>
                <div className="px-5 py-5 sm:px-6">
                  <p className="text-sm text-graphite">{fam?.name ?? p.family}</p>
                  <h2 className="record-title mt-1 text-2xl">
                    <Link href={`/policies/${p.id}`} className="no-underline hover:underline">
                      {p.title}
                    </Link>
                  </h2>
                  <p className="mt-2 text-lg measure">{p.summary}</p>
                  {gated && p.gateReason ? <p className="mt-3 border-l-4 border-plum pl-3 text-[15px] text-plum">{p.gateReason}</p> : null}
                  {(() => {
                    // The summary often repeats the first intended use word for word; list only what adds something.
                    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '')
                    const uses = p.intendedUse.filter((u) => norm(u).slice(0, 40) !== norm(p.summary).slice(0, 40)).slice(0, 3)
                    return uses.length ? (
                      <ul className="mt-4 list-disc space-y-1 pl-5 text-[15px] text-graphite measure">
                        {uses.map((u) => (
                          <li key={u}>{u}</li>
                        ))}
                      </ul>
                    ) : null
                  })()}
                  <p className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                    <Link href={`/policies/${p.id}`} className="link font-bold">
                      Read the full policy
                    </Link>
                    <Link href={`/docket?policy=${p.id}`} className="link">
                      Claims under {p.id}
                    </Link>
                    <span className="text-graphite">
                      Text hash <code className="font-mono">{shortHash(p.contentHash, 6)}</code>
                    </span>
                  </p>
                </div>
              </li>
            )
          })}
        </ol>
        <aside className="space-y-6">
          <MarginNote title="Why policies are versioned">
            <p>The policy id, version and text hash go into every market question. A later revision applies only to claims filed after it.</p>
            <p>Labels, documentation or administrator preferences can never change the terms of a funded market.</p>
          </MarginNote>
          <MarginNote title="Why SC-001 is gated">
            <p>Smart-contract claims can expose live vulnerabilities. They stay disabled until evidence access, responsible disclosure and adjudicator review are settled.</p>
          </MarginNote>
        </aside>
      </div>
    </Page>
  )
}
