'use client'

import Link from 'next/link'
import type { ClaimDetail } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { EVIDENCE_MECHANISMS, explorerAddressUrl, formatDate, getPolicy } from '@pine/core'
import { cn } from '@/lib/cn'
import { CopyButton } from '@/components/ui/copy-button'
import { CodeBlock } from '@/components/ui/code-block'
import { ExternalLink } from '@/components/ui/external-link'
import { Pane } from '@/components/ui/pane'
import { PlainText } from '@/components/ui/safe-markdown'
import { LifecycleRuler } from './lifecycle-ruler'

export function QuestionBlock({ claim }: { claim: ClaimDetail }) {
  const q = claim.manifest.question
  return (
    <div className="rounded-ctl border border-line bg-frost">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="stretch-cond text-[12px] text-muted">Immutable question</span>
        <span className="mono-cond ml-auto truncate text-[10.5px] text-faint" title={q.hash}>
          keccak256 {q.hash.slice(0, 10)}…{q.hash.slice(-6)}
        </span>
        <CopyButton value={q.text} label="question text" size={13} />
      </div>
      <p className="mono-cond wrap-anywhere px-4 py-3 text-[12.5px] leading-[1.7] text-bark">{q.text}</p>
      <div className="grid gap-px border-t border-line bg-line sm:grid-cols-3">
        <OutcomeKey glyph="yes" label="Yes" meaning={COPY.outcome.yes} />
        <OutcomeKey glyph="no" label="No" meaning={COPY.outcome.no} />
        <OutcomeKey glyph="invalid" label="Invalid result" meaning="Only the Invalid result token redeems; Yes and No pay nothing. Not a refund." />
      </div>
    </div>
  )
}

function OutcomeKey({ glyph, label, meaning }: { glyph: 'yes' | 'no' | 'invalid'; label: string; meaning: string }) {
  return (
    <div className="flex items-start gap-2 bg-frost px-3 py-2">
      <span
        aria-hidden
        className={cn(
          'mt-[3px] size-2.5 shrink-0 rounded-[2px]',
          glyph === 'yes' && 'bg-flare',
          glyph === 'no' && 'border-[1.6px] border-slate',
          glyph === 'invalid' && 'border-[1.6px] border-violet',
        )}
      />
      <p className="text-[12px] leading-[1.45]">
        <span className="font-semibold">{label}</span> <span className="text-muted">{meaning}</span>
      </p>
    </div>
  )
}

function RefRow({ label, value, href, mono = true, copy = true, hint }: { label: string; value?: string; href?: string; mono?: boolean; copy?: boolean; hint?: string }) {
  if (!value) return null
  return (
    <tr className="border-b border-line last:border-b-0">
      <th scope="row" className="stretch-cond w-[150px] whitespace-nowrap py-2 pl-4 pr-3 text-left align-top text-[12.5px] font-normal text-muted">
        {label}
      </th>
      <td className="py-2 pr-2 align-top">
        <span className={cn('wrap-anywhere', mono ? 'mono-cond text-[11.5px]' : 'text-[13px]')}>
          {href ? (
            <ExternalLink href={href} className="text-bark hover:text-needle">
              {value}
            </ExternalLink>
          ) : (
            value
          )}
        </span>
        {hint ? <span className="block text-[11.5px] text-muted">{hint}</span> : null}
      </td>
      <td className="w-8 py-1.5 pr-3 text-right align-top">{copy ? <CopyButton value={value} label={label} size={13} /> : null}</td>
    </tr>
  )
}

export function ImmutableRefs({ claim }: { claim: ClaimDetail }) {
  const m = claim.manifest
  const src = m.source
  const env = m.claim.environment
  return (
    <table className="w-full border-collapse">
      <caption className="sr-only">Immutable references</caption>
      <tbody>
        <RefRow label="Repository" value={`${src.owner}/${src.repo}`} href={`https://github.com/${src.owner}/${src.repo}`} />
        <RefRow label="Commit" value={src.commit.sha} href={src.commit.htmlUrl} />
        <RefRow label="Base commit" value={src.baseCommit?.sha} href={src.baseCommit?.htmlUrl} hint={m.claim.regressionOnly ? 'Only regressions relative to this base qualify' : undefined} />
        <RefRow label="Pull request" value={src.pullRequest ? `#${src.pullRequest.number} ${src.pullRequest.title}` : undefined} href={src.pullRequest?.htmlUrl} mono={false} copy={false} />
        <RefRow label="Policy" value={`${m.policy.id}@${m.policy.version}`} />
        <RefRow label="Policy hash" value={m.policy.hash} />
        <RefRow label="Policy URI" value={m.policy.uri} />
        <RefRow label="Manifest URI" value={claim.manifestUri} />
        <RefRow label="Manifest hash" value={claim.manifestHash} />
        <RefRow label="Question hash" value={m.question.hash} />
        <RefRow label="Environment hash" value={env.envHash} />
        <RefRow label="Config hash" value={env.configHash} />
        {env.dependencyLock ? <RefRow label="Lockfile" value={`${env.dependencyLock.path} ${env.dependencyLock.hash}`} /> : null}
        <RefRow label="Market" value={claim.market?.address} href={claim.market ? explorerAddressUrl(claim.market.chainId, claim.market.address) : undefined} />
        <RefRow label="Condition id" value={claim.market?.conditionId} />
        <RefRow label="Reality question" value={claim.oracle?.realityQuestionId} href={claim.oracle?.realityUrl} />
      </tbody>
    </table>
  )
}

function List({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-[13px] text-muted">{empty}</p>
  return (
    <ul className="space-y-1 text-[13.5px]">
      {items.map((x, i) => (
        <li key={i} className="flex gap-2">
          <span aria-hidden className="mt-[9px] h-px w-2.5 shrink-0 bg-faint" />
          <PlainText>{x}</PlainText>
        </li>
      ))}
    </ul>
  )
}

export function OverviewTab({ claim, now }: { claim: ClaimDetail; now: Date }) {
  const spec = claim.manifest.claim
  const env = spec.environment
  const policy = getPolicy(spec.policyId, spec.policyVersion)
  const mech = EVIDENCE_MECHANISMS[spec.evidence.mechanism]
  const claimClass = policy?.claimClasses.find((c) => c.id === spec.claimClass)
  return (
    <div className="divide-y divide-line">
      <section className="px-4 py-5 sm:px-6" aria-label="Question">
        <QuestionBlock claim={claim} />
      </section>

      <section className="px-4 py-5 sm:px-6" aria-labelledby="lifecycle-h">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
          <h2 id="lifecycle-h" className="text-[15px] font-semibold">
            Lifecycle
          </h2>
          <p className="text-xs text-muted">All times UTC. {COPY.deadlineIsNotTradingCutoff}</p>
        </div>
        <LifecycleRuler claim={claim} now={now} />
      </section>

      <section className="grid gap-6 px-4 py-5 sm:px-6 lg:grid-cols-2" aria-label="Claim terms">
        <div className="space-y-4">
          <div>
            <h2 className="text-[15px] font-semibold">Requirement</h2>
            <PlainText className="mt-1 text-[14px] leading-[1.6]">{spec.requirement}</PlainText>
          </div>
          <div>
            <h3 className="stretch-cond text-[13px] font-semibold text-muted">Violation that resolves YES</h3>
            <PlainText className="mt-1 text-[14px] leading-[1.6]">{spec.violation}</PlainText>
          </div>
          {claimClass ? (
            <p className="text-[13px] text-muted">
              Claim class: <span className="text-bark">{claimClass.label}</span>
            </p>
          ) : null}
          {spec.faultModel ? (
            <div>
              <h3 className="stretch-cond text-[13px] font-semibold text-muted">Fault model</h3>
              <PlainText className="mt-1 text-[13.5px]">{spec.faultModel}</PlainText>
            </div>
          ) : null}
          {spec.allowedInputs ? (
            <div>
              <h3 className="stretch-cond text-[13px] font-semibold text-muted">Allowed inputs</h3>
              <PlainText className="mt-1 text-[13.5px]">{spec.allowedInputs}</PlainText>
            </div>
          ) : null}
          {spec.specReference ? (
            <p className="text-[13px] text-muted">
              Source requirement:{' '}
              <ExternalLink href={spec.specReference.url}>{spec.specReference.label}</ExternalLink>
            </p>
          ) : null}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <div>
            <h3 className="stretch-cond mb-1.5 text-[13px] font-semibold text-muted">In scope</h3>
            <List items={spec.scope.inScope} empty="Not specified" />
          </div>
          <div>
            <h3 className="stretch-cond mb-1.5 text-[13px] font-semibold text-muted">Out of scope</h3>
            <List items={spec.scope.outOfScope} empty="Not specified" />
          </div>
          <div>
            <h3 className="stretch-cond mb-1.5 text-[13px] font-semibold text-muted">Assumptions</h3>
            <List items={spec.assumptions} empty="None stated" />
          </div>
          <div>
            <h3 className="stretch-cond mb-1.5 text-[13px] font-semibold text-muted">Exclusions</h3>
            <List items={spec.exclusions} empty="Policy exclusions only" />
          </div>
        </div>
      </section>

      <section className="px-4 py-5 sm:px-6" aria-labelledby="env-h">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
          <h2 id="env-h" className="text-[15px] font-semibold">
            Reproduction environment
          </h2>
          <p className="text-xs text-muted">Evidence must reproduce under this pinned environment.</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            <dt className="text-muted">Runtime</dt>
            <dd className="mono-cond text-[12px]">{env.runtime}</dd>
            {env.packageManager ? (
              <>
                <dt className="text-muted">Package manager</dt>
                <dd className="mono-cond text-[12px]">{env.packageManager}</dd>
              </>
            ) : null}
            {env.containerImage ? (
              <>
                <dt className="text-muted">Container</dt>
                <dd className="mono-cond wrap-anywhere text-[12px]">{env.containerImage}</dd>
              </>
            ) : null}
            <dt className="text-muted">External state</dt>
            <dd className="text-[13px]">{env.externalState || 'none'}</dd>
            {Object.entries(env.config).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="mono-cond text-[11.5px] text-muted">{k}</dt>
                <dd className="mono-cond wrap-anywhere text-[12px]">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="space-y-3">
            <CodeBlock code={env.reproductionCommand} label="Reproduction command" prompt />
            {env.setupSteps.length ? (
              <CodeBlock code={env.setupSteps.join('\n')} label="Setup steps" prompt />
            ) : null}
          </div>
        </div>
      </section>

      <section className="px-4 py-5 sm:px-6" aria-labelledby="ev-h">
        <h2 id="ev-h" className="text-[15px] font-semibold">
          Evidence channel
        </h2>
        <p className="mt-1 max-w-[72ch] text-[13.5px] text-muted">
          <span className="text-bark">{mech.label}.</span> {mech.description} Deadline{' '}
          <span className="mono-cond tnum text-[12px] text-bark">{formatDate(spec.evidence.deadline, 'utc')}</span>.
          {mech.launchGate ? <span className="text-resin"> {mech.launchGate}</span> : null}
        </p>
        {policy ? (
          <p className="mt-2 text-[13px]">
            Admissibility follows{' '}
            <Link href={`/policies/${policy.id}?version=${policy.version}`} className="text-needle hover:underline">
              {policy.id}@{policy.version} {policy.title}
            </Link>
            .
          </p>
        ) : null}
      </section>

      <Pane title="Immutable references" className="border-t-0" description="Frozen when the market was created">
        <ImmutableRefs claim={claim} />
      </Pane>
    </div>
  )
}
