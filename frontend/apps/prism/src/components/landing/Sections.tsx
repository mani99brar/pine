'use client'

import Link from 'next/link'
import { useClaims, usePine, useStats } from '@pine/react'
import { formatAmount } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { Constellation, ConstellationLegend, nothingPriced } from '@/components/table/Constellation'
import { CrystalGlyph } from '@/components/crystal/CrystalGlyph'
import { CopyButton } from '@/components/ui/interactive'
import { Skeleton } from '@/components/ui/primitives'
import { FAMILY_HEX, OUTCOME_HEX } from '@/lib/crystal'
import { useNowMs } from '@/lib/hooks'

export function TablePreview() {
  const q = useClaims({ sort: 'deadline', limit: 60 })
  const stats = useStats()
  const now = useNowMs()
  const s = stats.data
  // api mode: Pine does not index liquidity (its stats would say 0) and lists claims without prices.
  const backend = usePine().env.dataSource === 'api'
  const figures: [string, string][] = s
    ? [
        ['Open for evidence', String(s.openClaims)],
        ['Resolved', String(s.resolvedClaims)],
        ...(backend ? [] : [['Liquidity across markets', `${formatAmount(s.totalLiquidity, { maxDecimals: 0 })} ${s.collateralSymbol}`] as [string, string]]),
        ['Counterexamples accepted', String(s.counterexamplesAccepted)],
      ]
    : []
  const caption = backend
    ? `${q.data && nothingPriced(q.data.items) ? 'Position is the time to the evidence deadline; open a claim to see its pool prices.' : `Height is the Yes price, the ${COPY.priceLabel.toLowerCase()}.`} Liquidity is not indexed, so every crystal has the same size. The slit is now. ${COPY.volumeCaveat}`
    : `Height is the Yes price, size is liquidity, and the slit is now. ${COPY.volumeCaveat}`
  return (
    <section className="py-16 sm:py-24" aria-labelledby="preview-title">
      <div className="mx-auto w-full max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-[44rem]">
            <h2 id="preview-title" className="t-h1 chroma">
              On the light table now
            </h2>
            <p className="t-lead mt-4">Each crystal is a live claim. The brighter and faster it pulses, the closer its evidence deadline.</p>
          </div>
          <Link href="/claims" className="btn btn-glass">
            Open the light table
          </Link>
        </div>
        {s && (
          <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-4">
            {figures.map(([label, value]) => (
              <div key={label}>
                <dt className="text-[0.8125rem] text-lumen-3">{label}</dt>
                <dd className="t-figure text-[1.75rem] text-lumen">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="glass cut-xl mt-8 p-2 sm:p-4">
          {q.data && now !== null ? <Constellation claims={q.data.items} nowMs={now} compact /> : <Skeleton className="aspect-[1200/440] w-full" />}
          <ConstellationLegend className="px-2 pb-1 pt-4" />
        </div>
        <p className="mt-3 text-[0.8125rem] text-lumen-3">{caption}</p>
      </div>
    </section>
  )
}

const ENDINGS = [
  {
    state: 'fractured' as const,
    seed: 'ending:yes',
    title: COPY.outcome.yes,
    body: COPY.outcomeLong.yes,
    note: 'Bad news for the code, shown as a crack with light leaking through.',
    href: '/claims/pine-0002',
    color: OUTCOME_HEX.yes,
  },
  {
    state: 'dim' as const,
    seed: 'ending:no',
    title: COPY.outcome.no,
    body: COPY.outcomeLong.no,
    note: 'The crystal stays whole but dims. It never brightens or celebrates.',
    href: '/claims/pine-0003',
    color: OUTCOME_HEX.no,
  },
  {
    state: 'frosted' as const,
    seed: 'ending:invalid',
    title: COPY.outcome.invalid,
    body: COPY.outcomeLong.invalid,
    note: 'Clouded: neither outcome. Only Invalid-result tokens redeem.',
    href: '/claims/pine-0004',
    color: OUTCOME_HEX.invalid,
  },
]

export function Endings() {
  // The examples are demo claims; api mode has no such ids, so it links none.
  const examples = usePine().env.dataSource !== 'api'
  return (
    <section className="py-16 sm:py-24" aria-labelledby="endings-title">
      <div className="mx-auto w-full max-w-[1240px] px-4 sm:px-6 lg:px-8">
        <h2 id="endings-title" className="t-h1 chroma max-w-[20ch]">
          Three ways a claim ends
        </h2>
        <p className="t-lead mt-4 max-w-[60ch]">The words are exact on purpose. {COPY.noIsNotSafety}</p>
        <ol className="mt-12 grid gap-5 md:grid-cols-3">
          {ENDINGS.map((e) => (
            <li key={e.state} className="glass cut-xl flex flex-col p-6">
              <div className="flex h-[200px] items-center justify-center">
                <CrystalGlyph seed={e.seed} hue={FAMILY_HEX.FUNC} state={e.state} size={190} decorative />
              </div>
              <h3 className="t-h3 mt-4" style={{ color: e.state === 'fractured' ? e.color : undefined }}>
                {e.title}
              </h3>
              <p className="mt-2 text-[0.96875rem] leading-[1.6] text-lumen-2">{e.body}</p>
              <p className="mt-3 text-[0.84375rem] text-lumen-3">{e.note}</p>
              {examples && (
                <Link href={e.href} className="link mt-auto pt-5 text-[0.9rem] font-semibold text-lumen-2">
                  See a claim that ended this way
                </Link>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

export function ForAgents({ siteUrl }: { siteUrl: string }) {
  const { env } = usePine()
  if (env.dataSource === 'api') return <ForAgentsBackend siteUrl={siteUrl} />
  const curl = `curl -s ${siteUrl}/api/agent/v1/claims?status=open | jq '.items[0].question'\ncurl -s ${siteUrl}/api/agent/v1/claims/pine-0009?format=md`
  return (
    <section className="py-16 sm:py-24" aria-labelledby="agents-title">
      <div className="mx-auto grid w-full max-w-[1240px] gap-10 px-4 sm:px-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:px-8">
        <div>
          <h2 id="agents-title" className="t-h1 chroma">
            Investigators and agents read the same claim
          </h2>
          <p className="t-lead mt-4 max-w-[52ch]">
            Every claim has a machine-readable brief with the pinned commit, environment, reproduction command, evidence channel and deadline. Nothing an agent reads differs from what a person sees.
          </p>
          <ul className="mt-6 grid gap-2 text-[0.96875rem]">
            <li>
              <Link className="link text-lumen-2" href="/agents">
                Agent API guide
              </Link>
            </li>
            <li>
              <a className="link text-lumen-2" href="/llms.txt">
                llms.txt
              </a>
            </li>
            <li>
              <a className="link text-lumen-2" href="/.well-known/pine.json">
                .well-known/pine.json
              </a>
            </li>
            <li>
              <a className="link text-lumen-2" href="/api/agent/v1/feed.xml">
                Atom feed of new claims
              </a>
            </li>
          </ul>
        </div>
        <div className="cut-xl well relative overflow-hidden">
          <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
            <p className="text-[0.8125rem] text-lumen-3">Terminal</p>
            <CopyButton text={curl} label="Copy commands" size="xs" variant="ghost" />
          </div>
          <pre className="t-code overflow-x-auto whitespace-pre px-4 py-4 text-lumen-2">
            <code>
              <span className="text-lumen-3"># open claims, first question</span>
              {'\n'}
              <span className="text-hb">curl</span> -s {siteUrl}/api/agent/v1/claims?status=open | jq &apos;.items[0].question&apos;
              {'\n\n'}
              <span className="text-lumen-3"># one claim as a Markdown brief</span>
              {'\n'}
              <span className="text-hb">curl</span> -s {siteUrl}/api/agent/v1/claims/pine-0009?format=md
            </code>
          </pre>
          <p className="border-t border-edge px-4 py-3 text-[0.8125rem] text-lumen-3">{COPY.untrustedContent}</p>
        </div>
      </div>
    </section>
  )
}

/** `api` mode: the agent endpoints are the Pine backend's (same origin, public, cookie-free). */
function ForAgentsBackend({ siteUrl }: { siteUrl: string }) {
  const feed = `curl -s '${siteUrl}/api/v1/agents/claims?phase=evidence_open' | jq '.items[0].userSupplied.title'`
  const one = `curl -s ${siteUrl}/api/v1/agents/claims/<market> | jq '.item.userSupplied.document'`
  return (
    <section className="py-16 sm:py-24" aria-labelledby="agents-title">
      <div className="mx-auto grid w-full max-w-[1240px] gap-10 px-4 sm:px-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:px-8">
        <div>
          <h2 id="agents-title" className="t-h1 chroma">
            Investigators and agents read the same claim
          </h2>
          <p className="t-lead mt-4 max-w-[52ch]">
            Every claim is public as JSON: the pinned commit, deadlines, oracle state and evidence instructions written by Pine, apart from the creator&apos;s document, which is marked untrusted.
          </p>
          <ul className="mt-6 grid gap-2 text-[0.96875rem]">
            <li>
              <a className="link text-lumen-2" href="/llms.txt">
                llms.txt
              </a>
            </li>
            <li>
              <a className="link text-lumen-2" href="/.well-known/pine.json">
                .well-known/pine.json
              </a>
            </li>
            <li>
              <a className="link text-lumen-2" href="/api/v1/agents/claims">
                Claim feed (JSON)
              </a>
            </li>
            <li>
              <a className="link text-lumen-2" href="/api/openapi.json">
                OpenAPI document
              </a>
            </li>
          </ul>
        </div>
        <div className="cut-xl well relative overflow-hidden">
          <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
            <p className="text-[0.8125rem] text-lumen-3">Terminal</p>
            <CopyButton text={`${feed}\n${one}`} label="Copy commands" size="xs" variant="ghost" />
          </div>
          <pre className="t-code overflow-x-auto whitespace-pre px-4 py-4 text-lumen-2">
            <code>
              <span className="text-lumen-3"># claims open for evidence, first title</span>
              {'\n'}
              <span className="text-hb">curl</span> -s &apos;{siteUrl}/api/v1/agents/claims?phase=evidence_open&apos; | jq &apos;.items[0].userSupplied.title&apos;
              {'\n\n'}
              <span className="text-lumen-3"># one claim and its document, by market address</span>
              {'\n'}
              <span className="text-hb">curl</span> -s {siteUrl}/api/v1/agents/claims/&lt;market&gt; | jq &apos;.item.userSupplied.document&apos;
            </code>
          </pre>
          <p className="border-t border-edge px-4 py-3 text-[0.8125rem] text-lumen-3">{COPY.untrustedContent}</p>
        </div>
      </div>
    </section>
  )
}

export function NotThis() {
  const items = [
    { title: 'Not a review or an audit report', body: COPY.notAReview },
    { title: 'Liquidity is not a bounty', body: COPY.liquidityIsNotBounty },
    { title: 'No is not a correctness verdict', body: COPY.noIsNotSafety },
    { title: 'You decide what to merge', body: COPY.noMergeAuthority },
  ]
  return (
    <section className="py-16 sm:py-20" aria-labelledby="not-title">
      <div className="mx-auto w-full max-w-[1240px] px-4 sm:px-6 lg:px-8">
        <div className="glass cut-xl grid gap-8 p-6 sm:p-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div>
            <h2 id="not-title" className="t-h2">
              What Pine is not
            </h2>
            <p className="mt-3 text-lumen-2">Read these before you fund a market.</p>
            <Link href="/risks" className="btn btn-glass mt-6">
              Risks and launch gates
            </Link>
          </div>
          <dl className="grid gap-6 sm:grid-cols-2">
            {items.map((i) => (
              <div key={i.title}>
                <dt className="t-h4">{i.title}</dt>
                <dd className="mt-1.5 text-[0.9375rem] leading-[1.6] text-lumen-2">{i.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  )
}
