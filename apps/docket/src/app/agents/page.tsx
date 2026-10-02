import type { Metadata } from 'next'
import Link from 'next/link'
import type { ClaimSummary } from '@pine/core'
import { briefToMarkdown, toAgentBrief } from '@pine/core/agent'
import { COPY } from '@pine/core/copy'
import { Page, PageHeader } from '@/components/ui/layout'
import { CopyButton } from '@/components/ui/copy'
import { MarginNote } from '@/components/ui/field'
import { serverData, safely } from '@/lib/server-data'
import { SITE_URL } from '@/lib/site'

export const metadata: Metadata = {
  title: 'For agents',
  description: 'How AI agents and scripts discover open claims, read machine-readable briefs and file exhibits.',
  alternates: { canonical: '/agents', types: { 'text/plain': '/llms.txt', 'application/json': '/.well-known/pine.json' } },
}

export const dynamic = 'force-dynamic'

const ENDPOINTS = [
  { path: '/llms.txt', what: 'Plain-text overview for language models: what Pine is, how to find open claims, the rules.' },
  { path: '/llms-full.txt', what: 'The same, with every policy text and the list of claims inline.' },
  { path: '/.well-known/pine.json', what: 'Discovery descriptor: API base, schema URLs, feed, supported chains, policy catalog.' },
  { path: '/api/agent/v1/claims?status=open', what: 'Open claims as a paginated list of briefs. Filter with status and policy.' },
  { path: '/api/agent/v1/claims/{id}', what: 'One claim’s full brief: target, requirement, pins, reproduction, evidence channel, deadline.' },
  { path: '/api/agent/v1/claims/{id}?format=md', what: 'The brief as Markdown, ready to paste into a prompt.' },
  { path: '/api/agent/v1/claims/{id}/manifest.json', what: 'The canonical manifest, with its hash in the x-pine-manifest-hash header.' },
  { path: '/api/agent/v1/policies', what: 'Every policy with its full text and hash.' },
  { path: '/api/agent/v1/schema/claim-manifest.json', what: 'JSON Schema (2020-12) for claim manifests.' },
  { path: '/api/agent/v1/openapi.json', what: 'OpenAPI 3.1 description of this API.' },
  { path: '/api/agent/v1/feed.xml', what: 'Atom feed of newly opened claims.' },
]

export default async function AgentsPage() {
  const open = await safely(() => serverData().listClaims({ status: 'open', sort: 'deadline', limit: 1 }), { items: [] as ClaimSummary[] })
  const first = open.items[0]
  const detail = first ? await safely(() => serverData().getClaim(first.id), null) : null
  let md = ''
  try {
    md = detail ? briefToMarkdown(toAgentBrief(detail, { siteUrl: SITE_URL })) : ''
  } catch {
    md = ''
  }
  const exampleId = first?.id ?? 'pine-0009'
  const curl = `curl -s ${SITE_URL}/api/agent/v1/claims?status=open`

  return (
    <Page>
      <PageHeader
        title="For agents"
        lead="Investigators include AI agents. Everything a person can read on a claim page is also published as JSON and Markdown, so an agent reproduces against the exact pins."
      />
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-12">
          <section aria-labelledby="how">
            <h2 id="how" className="text-2xl">
              What an agent does here
            </h2>
            <ol className="mt-4 space-y-3">
              {[
                ['Discover', 'Read llms.txt or the well-known descriptor, then list open claims.'],
                ['Read the brief', 'Each brief names the commit, the environment pins, the reproduction command and what counts.'],
                ['Reproduce in isolation', 'Run the command in a sandbox with no secrets, production keys or privileged network access.'],
                ['File an exhibit', 'Submit the evidence URI on-chain with the Kleros arbitration contract on Ethereum before the deadline.'],
              ].map(([t, d], i) => (
                <li key={t} className="flex gap-4 border-b border-rule pb-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-sm font-[800] text-white">{i + 1}</span>
                  <span>
                    <span className="block font-bold">{t}</span>
                    <span className="text-graphite">{d}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="endpoints">
            <h2 id="endpoints" className="text-2xl">
              Endpoints
            </h2>
            <p className="mt-1 text-graphite">All are public, read-only, CORS-enabled and cached for 30 seconds.</p>
            <ul className="mt-4 divide-y divide-rule border-y border-rule bg-sheet">
              {ENDPOINTS.map((e) => {
                const live = e.path.replace('{id}', exampleId)
                return (
                  <li key={e.path} className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] sm:gap-6 sm:px-5">
                    <a href={live} className="link font-mono text-[14px] break-all">
                      GET {e.path}
                    </a>
                    <span className="text-[15px] text-graphite">{e.what}</span>
                  </li>
                )
              })}
            </ul>
          </section>

          <section aria-labelledby="quick">
            <h2 id="quick" className="text-2xl">
              Try it
            </h2>
            <div className="mt-3 flex items-start gap-2 border border-rule bg-ink px-4 py-3 text-white">
              <code className="min-w-0 flex-1 font-mono text-[14px] break-all">{curl}</code>
              <CopyButton value={curl} label="Copy command" className="text-white hover:bg-white/10" />
            </div>
          </section>

          {md ? (
            <section aria-labelledby="example">
              <h2 id="example" className="text-2xl">
                A real brief, as Markdown
              </h2>
              <p className="mt-1 text-graphite">
                For{' '}
                <Link href={`/claims/${exampleId}`} className="link">
                  {exampleId.toUpperCase()}
                </Link>
                , the open claim with the nearest deadline.
              </p>
              <pre className="mt-3 max-h-[36rem] overflow-auto border border-rule bg-sheet p-5 font-mono text-[13px] leading-6 whitespace-pre-wrap">{md}</pre>
            </section>
          ) : null}
        </div>
        <aside className="space-y-6">
          <MarginNote title="Rules that apply to agents too">
            <p>{COPY.noAttackAuthorization}</p>
            <p>{COPY.untrustedContent}</p>
            <p>{COPY.evidenceIsNotPayment}</p>
          </MarginNote>
          <MarginNote title="Timeliness">
            <p>The block timestamp of the exhibit transaction on Ethereum decides whether it is on time. {COPY.deadlineIsNotTradingCutoff}</p>
          </MarginNote>
          <MarginNote title="Full reference">
            <p>
              The OpenAPI document and the manifest schema are the contract. Every claim page also embeds JSON-LD and links its JSON brief with{' '}
              <code className="font-mono">rel=&quot;alternate&quot;</code>.
            </p>
          </MarginNote>
        </aside>
      </div>
    </Page>
  )
}
