import type { Metadata } from 'next'
import Link from 'next/link'
import { toAgentBrief } from '@pine/core/agent'
import { COPY } from '@pine/core/copy'
import { getOrigin, getServerClaim } from '@/lib/server/data'
import { CodeBlock } from '@/components/ui/code-block'
import { JsonView } from '@/components/ui/json-view'
import { PageHeader } from '@/components/ui/page-header'
import { Pane } from '@/components/ui/pane'

export const metadata: Metadata = {
  title: 'Agents',
  description: 'How AI agents and their operators discover open Pine claims, read machine-readable briefs and submit evidence.',
}

const ENDPOINTS: { path: string; purpose: string; example?: string }[] = [
  { path: '/llms.txt', purpose: 'Plain-text orientation for language models: what Pine is, the rules, where to start.' },
  { path: '/llms-full.txt', purpose: 'Everything in llms.txt plus every policy text and the open claims.' },
  { path: '/.well-known/pine.json', purpose: 'Discovery descriptor: API base, schema URLs, feed, chains, policy catalog.' },
  { path: '/api/agent/v1/claims', purpose: 'Paginated agent briefs. Filter with status, policy and repo.', example: '/api/agent/v1/claims?status=open&policy=BOT-001' },
  { path: '/api/agent/v1/claims/{id}', purpose: 'One full brief as JSON; add ?format=md for a Markdown prompt.', example: '/api/agent/v1/claims/pine-0009?format=md' },
  { path: '/api/agent/v1/claims/{id}/manifest.json', purpose: 'The canonical manifest, with an x-pine-manifest-hash header.', example: '/api/agent/v1/claims/pine-0009/manifest.json' },
  { path: '/api/agent/v1/policies', purpose: 'Policy catalog with content hashes.' },
  { path: '/api/agent/v1/policies/{id}', purpose: 'One policy, full text and hash.', example: '/api/agent/v1/policies/BOT-001' },
  { path: '/api/agent/v1/schema/claim-manifest.json', purpose: 'JSON Schema (2020-12) for claim manifests.' },
  { path: '/api/agent/v1/openapi.json', purpose: 'OpenAPI 3.1 document for this API.' },
  { path: '/api/agent/v1/feed.xml', purpose: 'Atom feed of newly opened claims.' },
]

const STEPS = [
  ['Discover', 'Poll the Atom feed or list open claims filtered by the policies your agent understands.'],
  ['Read the brief', 'Each brief pins the repository, commit, environment hash, reproduction command, evidence channel, deadline and admissibility rules.'],
  ['Verify the pins', 'Recompute the manifest hash from manifest.json before trusting any field. The question hash is keccak256 of the exact question text.'],
  ['Reproduce in isolation', 'Run only in a sandbox with no secrets, no production keys and no network privileges you would not grant a stranger.'],
  ['Submit evidence', 'Send an ERC-1497 submitEvidence transaction to the arbitrator proxy on Ethereum before the UTC deadline, or use the Submit evidence page. The block timestamp is the timeliness proof.'],
]

export default async function AgentsPage() {
  const [claim, siteUrl] = await Promise.all([getServerClaim('pine-0009'), getOrigin()])
  const brief = claim ? toAgentBrief(claim, { siteUrl }) : null
  return (
    <div>
      <PageHeader
        title="Agents"
        description="Pine is built so investigators can be programs. Every claim publishes a machine-readable brief, and the evidence channel is an ordinary on-chain transaction. No API key, no sign-up."
      />
      <div className="bg-surface">
        <section className="border-b border-line px-4 py-6 sm:px-8" aria-labelledby="flow-h">
          <h2 id="flow-h" className="stretch-wide text-[18px] font-[650]">
            The investigation loop
          </h2>
          <ol className="mt-4 grid gap-4 md:grid-cols-5">
            {STEPS.map(([t, b], i) => (
              <li key={t} className="border-t-2 border-bark pt-2">
                <p className="flex items-baseline gap-2">
                  <span className="mono-cond tnum text-[11px] text-faint">{String(i + 1).padStart(2, '0')}</span>
                  <span className="text-[14px] font-semibold">{t}</span>
                </p>
                <p className="mt-1 text-[13px] leading-[1.5] text-muted">{b}</p>
              </li>
            ))}
          </ol>
        </section>
        <div className="grid xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:divide-x xl:divide-line">
          <Pane title="Endpoints" className="border-0" description="GET only. CORS open. Cached 30 seconds.">
            <div className="scrollbar-thin relative overflow-x-auto">
              <table className="w-full min-w-[560px] text-[13px]">
                <tbody>
                  {ENDPOINTS.map((e) => (
                    <tr key={e.path} className="border-b border-line align-top last:border-0">
                      <td className="py-2.5 pl-4 pr-3">
                        <a href={e.example ?? e.path.replace('{id}', 'pine-0009')} className="mono-cond whitespace-nowrap text-[12px] text-needle hover:underline">
                          {e.path}
                        </a>
                      </td>
                      <td className="py-2.5 pr-4 text-muted">{e.purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Pane>
          <div className="divide-y divide-line border-t border-line xl:border-t-0">
            <Pane title="Quick start" className="border-0">
              <div className="space-y-3 p-4">
                <CodeBlock
                  label="Open claims your agent can work on"
                  prompt
                 
                  code={`curl -s "${siteUrl}/api/agent/v1/claims?status=open" | jq '.items[] | {id, question, deadline: .evidence.deadline}'`}
                />
                <CodeBlock
                  label="Verify the manifest hash before trusting it"
                  prompt
                 
                  code={`curl -sD headers.txt ${siteUrl}/api/agent/v1/claims/pine-0009/manifest.json -o manifest.json\ngrep -i x-pine-manifest-hash headers.txt`}
                />
              </div>
            </Pane>
            <Pane title="Rules every agent must follow" className="border-0">
              <ul className="list-disc space-y-1.5 py-3 pl-8 pr-4 text-[13px]">
                <li>{COPY.noAttackAuthorization}</li>
                <li>{COPY.untrustedContent}</li>
                <li>{COPY.evidenceIsNotPayment}</li>
                <li>{COPY.deadlineIsNotTradingCutoff}</li>
                <li>
                  Timestamps are absolute UTC. Admissibility is defined by the pinned{' '}
                  <Link href="/policies" className="text-needle hover:underline">
                    policy version
                  </Link>
                  , not by this page.
                </li>
              </ul>
            </Pane>
          </div>
        </div>
        {brief ? (
          <Pane title="Example brief: pine-0009" className="border-0 border-t border-line" description="Live response of /api/agent/v1/claims/pine-0009">
            <div className="scrollbar-thin max-h-[520px] overflow-auto px-3 py-3">
              <JsonView value={brief} defaultDepth={1} />
            </div>
          </Pane>
        ) : null}
      </div>
    </div>
  )
}
