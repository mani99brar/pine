'use client'

import Link from 'next/link'
import type { ClaimDetail } from '@pine/core'
import { formatDate, getEvidenceMechanism } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { Lock } from 'lucide-react'
import { CopyButton, HashChip } from '@/components/ui/interactive'
import { FACET_LABEL } from '@/lib/crystal'

function List({ items, empty = 'None stated' }: { items: string[]; empty?: string }) {
  if (!items.length) return <p className="text-lumen-3">{empty}</p>
  return (
    <ul className="grid gap-1.5">
      {items.map((x, i) => (
        <li key={i} className="flex gap-2">
          <span aria-hidden className="mt-[0.6em] h-1.5 w-1.5 shrink-0 rotate-45 bg-lumen-3" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{x}</span>
        </li>
      ))}
    </ul>
  )
}

/** The exact question and every immutable reference that defines it. Each reference is a facet. */
export function QuestionSection({ claim }: { claim: ClaimDetail }) {
  const m = claim.manifest
  const spec = m.claim
  const env = spec.environment
  const mech = getEvidenceMechanism(spec.evidence.mechanism, claim.chainId)
  const refs: { facet: keyof typeof FACET_LABEL; label: string; value: string; href?: string }[] = [
    { facet: 'commit', label: 'Commit', value: m.source.commit.sha, href: m.source.commit.htmlUrl },
    ...(m.source.baseCommit ? [{ facet: 'commit' as const, label: 'Base commit', value: m.source.baseCommit.sha, href: m.source.baseCommit.htmlUrl }] : []),
    { facet: 'policy', label: `Policy ${m.policy.id}@${m.policy.version}`, value: m.policy.hash },
    { facet: 'question', label: 'Question hash', value: m.question.hash },
    { facet: 'environment', label: 'Environment hash', value: env.envHash },
    { facet: 'environment', label: 'Configuration hash', value: env.configHash },
    { facet: 'manifest', label: 'Manifest hash', value: claim.manifestHash },
    ...(claim.marketAddress ? [{ facet: 'market' as const, label: 'Market', value: claim.marketAddress, href: claim.market?.seerUrl }] : []),
  ]
  return (
    <div className="grid gap-8">
      <div className="cut-xl well relative overflow-hidden p-5 sm:p-7">
        <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: 'linear-gradient(180deg,#5ad8ff,#ffb648,#ff6b83)' }} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-[0.8125rem] text-lumen-3">
            <Lock size={13} aria-hidden /> The market question, frozen when the market was created
          </p>
          <CopyButton text={m.question.text} label="Copy question" size="xs" variant="ghost" />
        </div>
        <p className="mt-3 max-w-[72ch] text-[1.125rem] leading-[1.65] text-lumen [overflow-wrap:anywhere]">{m.question.text}</p>
        <p className="mt-3 text-[0.8125rem] text-lumen-3">Outcomes: {m.question.outcomes.join(', ')}, plus Seer&apos;s native Invalid result.</p>
      </div>

      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
        <div>
          <h3 className="t-h4">Requirement</h3>
          <p className="mt-2 text-[0.96875rem] leading-[1.6] text-lumen-2 [overflow-wrap:anywhere]">{spec.requirement}</p>
          <h3 className="t-h4 mt-6">Violation a counterexample must show</h3>
          <p className="mt-2 text-[0.96875rem] leading-[1.6] text-lumen-2 [overflow-wrap:anywhere]">{spec.violation}</p>
          {spec.regressionOnly && <p className="tag mt-3">Only regressions relative to the base commit qualify</p>}
          {spec.faultModel && (
            <>
              <h3 className="t-h4 mt-6">Fault model</h3>
              <p className="mt-2 text-[0.9375rem] text-lumen-2">{spec.faultModel}</p>
            </>
          )}
          {spec.allowedInputs && (
            <>
              <h3 className="t-h4 mt-6">Allowed inputs</h3>
              <p className="mt-2 text-[0.9375rem] text-lumen-2">{spec.allowedInputs}</p>
            </>
          )}
        </div>
        <div>
          <h3 className="t-h4">Immutable references</h3>
          <ul className="mt-3 grid gap-2">
            {refs.map((r) => (
              <li key={`${r.label}-${r.value}`} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[0.84375rem] text-lumen-2">{r.label}</span>
                <HashChip value={r.value} href={r.href} />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[0.78rem] text-lumen-3">
            Manifest stored at <span className="t-code break-all text-lumen-2">{claim.manifestUri}</span>. {COPY.frozenTerms}
          </p>
        </div>
      </div>

      <div className="grid gap-x-10 gap-y-8 text-[0.9375rem] text-lumen-2 md:grid-cols-2 lg:grid-cols-3">
        <div>
          <h3 className="t-h4 text-lumen">In scope</h3>
          <div className="mt-2">
            <List items={spec.scope.inScope} />
          </div>
        </div>
        <div>
          <h3 className="t-h4 text-lumen">Out of scope</h3>
          <div className="mt-2">
            <List items={spec.scope.outOfScope} />
          </div>
        </div>
        <div>
          <h3 className="t-h4 text-lumen">Assumptions</h3>
          <div className="mt-2">
            <List items={spec.assumptions} />
          </div>
        </div>
        <div>
          <h3 className="t-h4 text-lumen">Exclusions</h3>
          <div className="mt-2">
            <List items={spec.exclusions} />
          </div>
        </div>
        <div className="md:col-span-2">
          <h3 className="t-h4 text-lumen">Reproduction environment</h3>
          <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-[9rem_1fr]">
            <dt className="text-lumen-3">Runtime</dt>
            <dd>{env.runtime || 'Not stated'}</dd>
            {env.packageManager && (
              <>
                <dt className="text-lumen-3">Package manager</dt>
                <dd>{env.packageManager}</dd>
              </>
            )}
            {env.dependencyLock && (
              <>
                <dt className="text-lumen-3">Lockfile</dt>
                <dd className="min-w-0">
                  <span className="t-code">{env.dependencyLock.path}</span> <HashChip value={env.dependencyLock.hash} className="ml-1 align-middle" />
                </dd>
              </>
            )}
            {env.containerImage && (
              <>
                <dt className="text-lumen-3">Container</dt>
                <dd className="t-code break-all">{env.containerImage}</dd>
              </>
            )}
            <dt className="text-lumen-3">External state</dt>
            <dd>{env.externalState || 'None'}</dd>
            {Object.keys(env.config).length > 0 && (
              <>
                <dt className="text-lumen-3">Configuration</dt>
                <dd className="t-code min-w-0 break-all">
                  {Object.entries(env.config)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('  ')}
                </dd>
              </>
            )}
            <dt className="text-lumen-3">Command</dt>
            <dd className="min-w-0">
              <code className="t-code cut-sm block break-all border border-edge bg-void px-2.5 py-1.5 text-lumen">{env.reproductionCommand}</code>
            </dd>
          </dl>
        </div>
        <div>
          <h3 className="t-h4 text-lumen">Evidence channel</h3>
          <p className="mt-2">{mech.label}</p>
          <p className="mt-1 text-lumen-3">Deadline {formatDate(spec.evidence.deadline, 'utc')}</p>
          {mech.launchGate && <p className="mt-1 text-[0.8125rem] text-na">{mech.launchGate}</p>}
          <p className="mt-3">
            <Link href={`/policies/${m.policy.id}`} className="link text-lumen-2">
              Read the {m.policy.id} policy
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
