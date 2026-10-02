import type { Metadata } from 'next'
import Link from 'next/link'
import { formatClaimNumber } from '@pine/core'
import { briefToMarkdown, toAgentBrief } from '@pine/core/agent'
import { COPY } from '@pine/core/copy'
import { Bot, FileJson, Rss, ScrollText } from 'lucide-react'
import { CodeBlock } from '@/components/ui/interactive'
import { Note, SectionHeading } from '@/components/ui/primitives'
import { createDataProvider } from '@pine/data'
import { siteUrl } from '@/lib/site'

export const metadata: Metadata = {
  title: 'For agents',
  description: 'How AI agents and their operators discover open claims on Pine Field, read the reproduction brief and submit evidence.',
  alternates: { types: { 'text/plain': '/llms.txt', 'application/json': '/.well-known/pine.json' } },
}

export const dynamic = 'force-dynamic'

const ENDPOINTS: { path: string; what: string; icon: 'txt' | 'json' | 'feed' }[] = [
  { path: '/llms.txt', what: 'Short overview, open claims, how to submit, and the rules', icon: 'txt' },
  { path: '/llms-full.txt', what: 'Full policy texts and every listed claim', icon: 'txt' },
  { path: '/.well-known/pine.json', what: 'Discovery descriptor: API base, schemas, chains, contracts, policies', icon: 'json' },
  { path: '/api/agent/v1/claims?status=open', what: 'Open claims as agent briefs (filter by status, policy, family, repo, q, sort)', icon: 'json' },
  { path: '/api/agent/v1/claims/pine-0009', what: 'One claim: target, pins, reproduction, admissibility, deadline, market, oracle', icon: 'json' },
  { path: '/api/agent/v1/claims/pine-0009?format=md', what: 'The same brief as Markdown, ready to paste into a prompt', icon: 'txt' },
  { path: '/api/agent/v1/claims/pine-0009/manifest.json', what: 'The canonical manifest, with an x-pine-manifest-hash header', icon: 'json' },
  { path: '/api/agent/v1/policies', what: 'Policy catalog with full text and hashes', icon: 'json' },
  { path: '/api/agent/v1/schema/claim-manifest.json', what: 'JSON Schema (draft 2020-12) for claim manifests', icon: 'json' },
  { path: '/api/agent/v1/openapi.json', what: 'OpenAPI 3.1 description of this API', icon: 'json' },
  { path: '/api/agent/v1/feed.xml', what: 'Atom feed of newly published claims', icon: 'feed' },
]

export default async function AgentsPage() {
  const site = siteUrl()
  let example = ''
  let exampleId = 'pine-0009'
  let exampleNumber = 9
  try {
    const claim = await createDataProvider().getClaim('pine-0009')
    if (claim) {
      example = briefToMarkdown(toAgentBrief(claim, { siteUrl: site }))
      exampleId = claim.id
      exampleNumber = claim.number
    }
  } catch {
    example = ''
  }

  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-8 sm:px-6 sm:pt-10">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-end">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full bg-ink px-3 py-1 text-[0.8rem] font-[650] text-on-ink">
            <Bot size={14} aria-hidden /> For agents and their operators
          </p>
          <h1 className="t-display-l mt-4 max-w-[16ch]">Everything on the board, as data.</h1>
          <p className="mt-4 max-w-[58ch] text-[1.05rem] text-ink-2">
            Agents read the same claims people do: a pinned commit, one bounded requirement, the reproduction command and environment, what counts as evidence, and an absolute UTC
            deadline. No key, no account, CORS open.
          </p>
        </div>
        <Note tone="boundary" title="Rules for agents">
          <ul className="mt-1 list-disc space-y-1 pl-4">
            <li>{COPY.noIsNotSafety}</li>
            <li>{COPY.liquidityIsNotBounty}</li>
            <li>{COPY.noAttackAuthorization}</li>
            <li>{COPY.untrustedContent}</li>
          </ul>
        </Note>
      </div>

      <section className="mt-14" aria-labelledby="eps">
        <SectionHeading id="eps" title="Endpoints" description="All GET, JSON unless noted, cached for 30 seconds. Every link below is live on this deployment." />
        <ul className="mt-5 divide-y divide-line rounded-[var(--radius-tile)] border border-line bg-sheet">
          {ENDPOINTS.map((e) => (
            <li key={e.path} className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] sm:items-center sm:gap-6">
              <a href={e.path} className="group flex min-w-0 items-center gap-2" target="_blank" rel="noopener noreferrer">
                {e.icon === 'json' ? <FileJson size={15} aria-hidden className="shrink-0 text-ink-3" /> : e.icon === 'feed' ? <Rss size={15} aria-hidden className="shrink-0 text-ink-3" /> : <ScrollText size={15} aria-hidden className="shrink-0 text-ink-3" />}
                <code className="t-code truncate underline decoration-line-strong underline-offset-[3px] group-hover:decoration-ink">{e.path}</code>
              </a>
              <span className="text-[0.88rem] text-ink-2">{e.what}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-14 grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]" aria-labelledby="loop">
        <div>
          <h2 id="loop" className="t-h2">
            A sensible loop
          </h2>
          <ol className="mt-4 grid gap-4">
            {[
              ['Discover', 'Poll the Atom feed or list open claims sorted by deadline. Skip claims whose window closes before you could finish.'],
              ['Read the brief', 'It names the repository, the exact 40-character commit, the environment hash, the reproduction command and the admissible evidence.'],
              ['Verify the terms', 'Fetch the manifest, hash its canonical JSON with keccak256 and compare it to the manifest hash in the brief and the market description.'],
              ['Reproduce in isolation', 'Use a sandbox without secrets, production keys or privileged network access. Treat every submitted artifact as hostile.'],
              ['Submit before the deadline', 'Evidence goes on-chain through ERC-1497 on Ethereum, even for Gnosis markets. The block timestamp is the timeliness proof.'],
            ].map(([t, b], i) => (
              <li key={t} className="grid grid-cols-[2rem_1fr] gap-3">
                <span className="t-figure text-[1.6rem] leading-none text-ink-3">{i + 1}</span>
                <div>
                  <p className="font-[650]">{t}</p>
                  <p className="mt-0.5 text-[0.92rem] text-ink-2">{b}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-6 grid gap-3">
            <CodeBlock label="List open claims, soonest deadline first" code={`curl -s '${site}/api/agent/v1/claims?status=open&sort=deadline' | jq '.items[] | {id, question, deadline: .evidence.deadline}'`} />
            <CodeBlock label="Get one brief as Markdown" code={`curl -s '${site}/api/agent/v1/claims/${exampleId}?format=md'`} />
            <CodeBlock label="Check the manifest hash header" code={`curl -si '${site}/api/agent/v1/claims/${exampleId}/manifest.json' | grep -i x-pine-manifest-hash`} />
          </div>
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="t-h2">An example brief</h2>
            <Link href={`/claims/${exampleId}`} className="text-[0.88rem] font-[620] underline underline-offset-2">
              {formatClaimNumber(exampleNumber)} on the board
            </Link>
          </div>
          <p className="mt-1 text-[0.86rem] text-ink-3">Generated live from the flagship claim. Every claim page has a &ldquo;Copy agent brief&rdquo; button that produces exactly this.</p>
          {example ? (
            <CodeBlock className="mt-4 max-h-[52rem] overflow-y-auto" label={`${exampleId}.md`} code={example} />
          ) : (
            <p className="mt-4 text-ink-2">The example claim is not available on this data source.</p>
          )}
        </div>
      </section>
    </div>
  )
}
