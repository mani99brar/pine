import type { Metadata } from 'next'
import Link from 'next/link'
import type { ClaimDetail, ClaimSummary } from '@pine/core'
import {
  evidenceMechanismQuestionLabel,
  formatAmount,
  formatClaimNumber,
  formatPrice,
  formatUtcMinute,
  normalizeViolation,
  shortSha,
  timeRemaining,
} from '@pine/core'
import { COPY } from '@pine/core/copy'
import { getOrigin, getServerClaim, getServerClaims, getServerPriceHistory, getServerStats } from '@/lib/server/data'
import { cn } from '@/lib/cn'
import { PasteBox } from '@/components/landing/paste-box'
import { CodeBlock } from '@/components/ui/code-block'
import { HashChip } from '@/components/ui/hash-chip'
import { InlineHash } from '@/components/ui/inline-hash'
import { DeadlineBar, PriceGauge, Sparkline } from '@/components/ui/instruments'
import { StatusDot } from '@/components/claim/status'

export const metadata: Metadata = {
  title: { absolute: 'Pine Console: adversarial verification for pinned commits' },
  description:
    'Pin an exact commit, publish one bounded claim about it, and fund a Seer prediction market where investigators, human or agent, try to demonstrate a reproducible counterexample before a UTC deadline.',
}

const FLAGSHIP = 'pine-0009'

/** The question text with each inserted value marked, rendered on the server. */
function SlottedQuestion({ claim }: { claim: ClaimDetail }) {
  const q = claim.manifest.question.text
  const spec = claim.manifest.claim
  const values = [
    normalizeViolation(spec.violation),
    claim.manifest.source.commit.sha.toLowerCase(),
    spec.environment.envHash,
    `${claim.manifest.policy.id}@${claim.manifest.policy.version}`,
    claim.manifest.policy.hash,
    evidenceMechanismQuestionLabel(spec.evidence.mechanism, spec.oracle.chainId),
    formatUtcMinute(spec.evidence.deadline),
  ]
  const marks = values
    .map((v) => ({ v, i: q.indexOf(v) }))
    .filter((m) => m.v && m.i >= 0)
    .sort((a, b) => a.i - b.i)
  // Landing preview only: long hex values render shortened (click copies the full value).
  const HEX = /(0x[0-9a-fA-F]{40,64}|\b[0-9a-f]{40}\b)/g
  const withHashes = (text: string, key: string) =>
    text.split(HEX).map((piece, j) => (j % 2 === 1 ? <InlineHash key={`${key}-${j}`} value={piece} /> : piece))
  const parts: React.ReactNode[] = []
  let at = 0
  marks.forEach((m, k) => {
    if (m.i < at) return
    if (m.i > at) parts.push(...withHashes(q.slice(at, m.i), `t${k}`))
    parts.push(
      <span key={k} className="rounded-[2px] bg-needle-soft px-[1px] [box-decoration-break:clone]">
        {withHashes(m.v, `s${k}`)}
      </span>,
    )
    at = m.i + m.v.length
  })
  parts.push(...withHashes(q.slice(at), 'end'))
  return <p className="mono-cond wrap-anywhere text-[12px] leading-[1.75] text-bark">{parts}</p>
}

function Specimen({ claim, history }: { claim: ClaimDetail; history: number[] }) {
  const now = new Date()
  const rem = timeRemaining(claim.evidenceDeadline, now)
  return (
    <figure className="overflow-hidden rounded-float border border-line bg-surface shadow-float">
      <figcaption className="flex items-center gap-2 border-b border-line bg-sunken px-4 py-2">
        <StatusDot status={claim.status} outcome={claim.outcome} />
        <Link href={`/claims/${claim.id}`} className="mono-cond shrink-0 text-[11.5px] text-muted hover:text-needle">
          {formatClaimNumber(claim.number)}
        </Link>
        <span className="truncate text-[12.5px] font-medium">{claim.title}</span>
      </figcaption>
      <div className="space-y-3 px-4 py-4">
        <div className="flex flex-wrap gap-1.5">
          <HashChip label="commit" value={claim.manifest.source.commit.sha} head={7} tail={4} />
          <HashChip label="policy" value={claim.manifest.policy.hash} />
          <HashChip label="env" value={claim.manifest.claim.environment.envHash} />
          <HashChip label="manifest" value={claim.manifestHash} />
        </div>
        <SlottedQuestion claim={claim} />
      </div>
      <div className="grid grid-cols-2 border-t border-line">
        <div className="border-r border-line px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12px] text-muted">YES price</span>
            <span className="text-xl font-semibold">{typeof claim.yesPrice === 'number' ? formatPrice(claim.yesPrice) : 'none'}</span>
          </div>
          <Sparkline values={history} width={200} height={28} className="mt-1 w-full" />
          <PriceGauge value={claim.yesPrice} previous={claim.yesPrice24hAgo} width={200} className="mt-1 w-full" />
        </div>
        <div className="px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12px] text-muted">Evidence closes</span>
            <span className="tnum text-xl font-semibold">{rem.past ? 'closed' : rem.label}</span>
          </div>
          <DeadlineBar start={claim.createdAt} end={claim.evidenceDeadline} now={now} width={200} className="mt-3 w-full" />
          <p className="tnum mt-2 text-[11.5px] text-muted">
            {formatAmount(claim.liquidity, { symbol: claim.collateralSymbol })} liquidity, {claim.evidence.length} submissions
          </p>
        </div>
      </div>
    </figure>
  )
}

const STEPS: { title: string; body: string }[] = [
  { title: 'Pin', body: 'Choose the exact commit and, for regressions, its base.' },
  { title: 'Claim', body: 'Pick a policy and state one bounded requirement.' },
  { title: 'Publish', body: 'Manifest to IPFS, market on Seer. Terms freeze.' },
  { title: 'Investigate', body: 'Anyone submits reproducible evidence before the UTC deadline.' },
  { title: 'Answer', body: 'Someone posts a bonded answer on Reality.eth.' },
  { title: 'Dispute', body: 'Challenges double the bond; Kleros can arbitrate.' },
  { title: 'Settle', body: 'Holders redeem; you decide what to merge.' },
]

function ResolutionRuler() {
  return (
    <ol className="relative grid gap-y-5 sm:grid-cols-2 lg:grid-cols-7 lg:gap-0" aria-label="How a claim resolves">
      <span aria-hidden className="absolute inset-x-0 top-[13px] hidden h-px bg-line-strong lg:block" />
      <span
        aria-hidden
        className="graduation absolute inset-x-0 top-[7px] hidden h-[6px] text-line-strong lg:block"
        style={{ ['--tick-gap' as string]: '12px' }}
      />
      {STEPS.map((s, i) => (
        <li key={s.title} className="relative lg:pr-5">
          <span aria-hidden className="relative z-10 mb-3 hidden h-[14px] w-[2px] bg-bark lg:block" />
          <p className="flex items-baseline gap-2">
            <span className="mono-cond tnum text-[11px] text-faint">{String(i + 1).padStart(2, '0')}</span>
            <span className="stretch-wide text-[15px] font-semibold">{s.title}</span>
          </p>
          <p className="mt-1 text-[13px] leading-[1.5] text-muted">{s.body}</p>
        </li>
      ))}
    </ol>
  )
}

function ClaimsList({ claims }: { claims: ClaimSummary[] }) {
  const now = new Date()
  return (
    <ul className="divide-y divide-line">
      {claims.map((c) => {
        const rem = timeRemaining(c.evidenceDeadline, now)
        return (
          <li key={c.id}>
            <Link href={`/claims/${c.id}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 px-4 py-2.5 hover:bg-frost sm:grid-cols-[auto_1fr_auto_auto]">
              <StatusDot status={c.status} outcome={c.outcome} />
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-medium">{c.title}</span>
                <span className="mono-cond block truncate text-[11px] text-muted">
                  {formatClaimNumber(c.number)} {c.source.owner}/{c.source.repo}@{shortSha(c.source.commitSha)} {c.policy.id}
                </span>
              </span>
              <span className="tnum text-right text-[13px] font-semibold">{typeof c.yesPrice === 'number' ? formatPrice(c.yesPrice) : 'none'}</span>
              <span className={cn('tnum hidden w-20 text-right text-[12px] sm:block', !rem.past && rem.ms < 48 * 3600_000 ? 'text-resin' : 'text-muted')}>
                {rem.past ? 'closed' : `${rem.label} left`}
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

export default async function LandingPage() {
  const [flagship, open, stats, history, siteUrl] = await Promise.all([
    getServerClaim(FLAGSHIP),
    getServerClaims(6),
    getServerStats(),
    getServerPriceHistory(FLAGSHIP),
    getOrigin(),
  ])
  return (
    <div className="bg-surface">
      <section className="border-b border-line px-4 pb-12 pt-10 sm:px-8 lg:pt-14">
        <div className="mx-auto grid max-w-[1240px] grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <h1 className="stretch-display max-w-[17ch] text-[38px] font-[780] leading-[1.03] tracking-[-0.02em] text-bark sm:text-[48px] xl:text-[54px]">
              Pin a commit. State one claim. Let a market look for the counterexample.
            </h1>
            <p className="mt-5 max-w-[60ch] text-[16px] leading-[1.6] text-muted">
              Pine publishes a bounded, policy-versioned claim about an exact commit and funds a Seer prediction market on it. Investigators,
              human or agent, can profit by demonstrating a reproducible counterexample before an absolute UTC deadline. Reality.eth answers
              the question; Kleros arbitrates disputes.
            </p>
            <div className="mt-7">
              <PasteBox />
            </div>
            <ul className="mt-8 grid max-w-[640px] gap-x-6 gap-y-2 text-[13px] text-muted sm:grid-cols-3">
              <li>
                <span className="block font-semibold text-bark">One commit</span>New commits need a new claim.
              </li>
              <li>
                <span className="block font-semibold text-bark">One requirement</span>Never “is this code safe”.
              </li>
              <li>
                <span className="block font-semibold text-bark">One deadline</span>Absolute UTC, not a trading cutoff.
              </li>
            </ul>
          </div>
          {flagship ? (
            <div className="min-w-0">
              <Specimen claim={flagship} history={history.map((p) => p.yes)} />
              <p className="mt-2 text-[12px] text-muted">
                A live claim. Highlighted values are the pinned inputs. Hashes are shortened here; click one to copy it, or open the claim for the full text.
              </p>
            </div>
          ) : null}
        </div>
      </section>

      <section className="border-b border-line bg-frost px-4 py-10 sm:px-8" aria-labelledby="how-h">
        <div className="mx-auto max-w-[1240px]">
          <h2 id="how-h" className="stretch-wide text-[22px] font-[650]">
            How a claim resolves
          </h2>
          <p className="mt-1 max-w-[70ch] text-[14px] text-muted">
            Evidence submission and adjudication have separate clocks. A timely submission can still be adjudicated after the deadline, and
            arbitration can take weeks.
          </p>
          <div className="mt-7">
            <ResolutionRuler />
          </div>
        </div>
      </section>

      <section className="border-b border-line px-4 py-10 sm:px-8">
        <div className="mx-auto grid max-w-[1240px] grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="stretch-wide text-[22px] font-[650]">Open for evidence</h2>
              <Link href="/claims?view=open" className="text-[13px] text-needle hover:underline">
                All claims
              </Link>
            </div>
            <p className="mt-1 text-[13px] text-muted">YES = {COPY.priceLabel.toLowerCase()}.</p>
            <div className="mt-4 overflow-hidden rounded-ctl border border-line">
              {open.length ? (
                <ClaimsList claims={open} />
              ) : (
                <p className="px-4 py-8 text-sm text-muted">No claims are open right now. Publish the first one.</p>
              )}
            </div>
            {stats ? (
              <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                {[
                  ['Open claims', String(stats.openClaims)],
                  ['Liquidity', formatAmount(stats.totalLiquidity, { symbol: stats.collateralSymbol, compact: true })],
                  ['Evidence submitted', String(stats.evidenceSubmissions)],
                  ['Counterexamples accepted', String(stats.counterexamplesAccepted)],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-[12px] text-muted">{k}</dt>
                    <dd className="text-[20px] font-semibold">{v}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <p className="mt-2 text-[12px] text-muted">{COPY.volumeCaveat}</p>
          </div>
          <div>
            <h2 className="stretch-wide text-[22px] font-[650]">Read the result for what it is</h2>
            <dl className="mt-4 divide-y divide-line rounded-ctl border border-line">
              <div className="flex gap-3 px-4 py-3">
                <StatusDot status="resolved" outcome="yes" size={12} className="mt-1" />
                <div>
                  <dt className="text-[14px] font-semibold">{COPY.outcome.yes}</dt>
                  <dd className="mt-0.5 text-[13px] text-muted">{COPY.outcomeLong.yes} That is bad news for the code, and useful news for you.</dd>
                </div>
              </div>
              <div className="flex gap-3 px-4 py-3">
                <StatusDot status="resolved" outcome="no" size={12} className="mt-1" />
                <div>
                  <dt className="text-[14px] font-semibold">{COPY.outcome.no}</dt>
                  <dd className="mt-0.5 text-[13px] text-muted">{COPY.noIsNotSafety}</dd>
                </div>
              </div>
              <div className="flex gap-3 px-4 py-3">
                <StatusDot status="resolved" outcome="invalid" size={12} className="mt-1" />
                <div>
                  <dt className="text-[14px] font-semibold">{COPY.outcome.invalid}</dt>
                  <dd className="mt-0.5 text-[13px] text-muted">{COPY.invalidIsNotRefund}</dd>
                </div>
              </div>
            </dl>
            <p className="mt-3 text-[13px] text-muted">
              {COPY.liquidityIsNotBounty} <Link href="/risks" className="text-needle hover:underline">Risks and launch gates</Link>
            </p>
          </div>
        </div>
      </section>

      <section className="px-4 py-10 sm:px-8" aria-labelledby="agents-h">
        <div className="mx-auto grid max-w-[1240px] grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="min-w-0">
            <h2 id="agents-h" className="stretch-wide text-[22px] font-[650]">
              Built to be read by agents
            </h2>
            <p className="mt-2 max-w-[56ch] text-[14px] leading-[1.6] text-muted">
              Every claim has a machine-readable brief: the pinned target, the requirement, the reproduction command, the evidence channel and
              the admissibility rules. Point an investigator at the feed and let it pick work.
            </p>
            <ul className="mt-4 space-y-1.5 text-[13px]">
              <li>
                <Link href="/agents" className="text-needle hover:underline">
                  Agent API guide
                </Link>
              </li>
              <li>
                <a href="/llms.txt" className="mono-cond text-[12px] text-needle hover:underline">
                  /llms.txt
                </a>
              </li>
              <li>
                <a href="/.well-known/pine.json" className="mono-cond text-[12px] text-needle hover:underline">
                  /.well-known/pine.json
                </a>
              </li>
              <li>
                <a href="/api/agent/v1/feed.xml" className="mono-cond text-[12px] text-needle hover:underline">
                  /api/agent/v1/feed.xml
                </a>
              </li>
            </ul>
          </div>
          <CodeBlock
            label="Find open BOT-001 claims, then fetch one brief as Markdown"
            prompt
            code={`curl -s "${siteUrl}/api/agent/v1/claims?status=open&policy=BOT-001"\ncurl -s "${siteUrl}/api/agent/v1/claims/${FLAGSHIP}?format=md"`}
          />
        </div>
        <div className="mx-auto mt-10 max-w-[1240px] border-t border-line pt-5 text-[12px] text-muted">
          <p className="max-w-[90ch]">
            {COPY.notAReview} {COPY.noMergeAuthority}
          </p>
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            <Link href="/risks" className="hover:text-bark">
              Risks and launch gates
            </Link>
            <Link href="/policies" className="hover:text-bark">
              Policy catalog
            </Link>
            <Link href="/agents" className="hover:text-bark">
              Agents
            </Link>
            <Link href="/claims" className="hover:text-bark">
              Claims
            </Link>
          </p>
        </div>
      </section>
    </div>
  )
}
