'use client'

import Link from 'next/link'
import type { ClaimDetail } from '@pine/core'
import { explorerAddressUrl, formatDate, getEvidenceMechanism } from '@pine/core'
import { COPY } from '@pine/core/copy'
import type { ApiClaimDetailFacts } from '@pine/data'
import { usePine } from '@pine/react'
import { Download, Lock, ShieldAlert } from 'lucide-react'
import { CopyButton, HashChip } from '@/components/ui/interactive'
import { Notice } from '@/components/ui/primitives'
import { FACET_LABEL } from '@/lib/crystal'
import { apiDetailFactsOf, claimPolicyHref } from '@/lib/claims'
import { ApiDeadlines } from './ApiDeadlines'
import { documentWithheldReason } from './ApiNotices'

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
  const api = apiDetailFactsOf(claim)
  if (api) return <ApiQuestionSection claim={claim} api={api} />
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
                <HashChip value={r.value} href={r.href} name={r.label} />
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
                  <span className="t-code">{env.dependencyLock.path}</span> <HashChip value={env.dependencyLock.hash} name="Lockfile hash" className="ml-1 align-middle" />
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

function Text({ children }: { children: string }) {
  return <p className="untrusted mt-2 text-[0.96875rem] leading-[1.6] text-lumen-2">{children}</p>
}

function parameterText(v: string | string[] | boolean): string {
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  return Array.isArray(v) ? v.join(', ') : v
}

const MEMBERSHIP: Record<string, string> = {
  pull_head: 'is the head of',
  pull_commit: 'is a commit of',
  branch_ancestor: 'is in the history of',
}

/**
 * A backend claim: the market's on-chain question, then the claim document's terms (untrusted creator text, shown as
 * plain text, and only when the document matched its on-chain digest), the deadlines and the digests that pin them.
 */
function ApiQuestionSection({ claim, api }: { claim: ClaimDetail; api: ApiClaimDetailFacts }) {
  const { env: pineEnv } = usePine()
  const m = claim.manifest
  const spec = m.claim
  const env = spec.environment
  const withheld = documentWithheldReason(api)
  const docUrl = api.claimDocument.url
  const repo = m.source.owner && m.source.repo ? `${m.source.owner}/${m.source.repo}` : null
  const membership = api.membership
  const registry = pineEnv.deployment?.evidenceRegistry
  const refs: { label: string; value: string; href?: string }[] = [
    { label: 'Commit', value: api.commit, href: m.source.commit.htmlUrl || undefined },
    ...(m.source.baseCommit ? [{ label: 'Base commit', value: m.source.baseCommit.sha, href: m.source.baseCommit.htmlUrl || undefined }] : []),
    { label: `Policy ${claim.policy.id}${claim.policy.version ? `@${claim.policy.version}` : ''}`, value: api.policyDocument.sha256 },
    { label: 'Claim document', value: api.claimDocument.sha256 },
    { label: 'Reality question', value: api.currentQuestionId, href: claim.oracle?.realityUrl },
    { label: 'Condition', value: api.conditionId },
    ...(claim.marketAddress ? [{ label: 'Market', value: claim.marketAddress, href: claim.market?.seerUrl }] : []),
  ]
  const params = Object.entries(spec.parameters)
  return (
    <div className="grid gap-8">
      <div className="cut-xl well relative overflow-hidden p-5 sm:p-7">
        <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: 'linear-gradient(180deg,#5ad8ff,#ffb648,#ff6b83)' }} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-[0.8125rem] text-lumen-3">
            <Lock size={13} aria-hidden /> The market question, recorded on chain when the market was created
          </p>
          {m.question.text && <CopyButton text={m.question.text} label="Copy question" size="xs" variant="ghost" />}
        </div>
        {m.question.text ? (
          <p className="untrusted mt-3 max-w-[72ch] text-[1.125rem] leading-[1.65] text-lumen">{m.question.text}</p>
        ) : (
          <p className="mt-3 text-[1rem] text-lumen-3">{api.hidden ? 'Withheld by moderation.' : 'The market question could not be read.'}</p>
        )}
        <p className="mt-3 text-[0.8125rem] text-lumen-3">Outcomes: Yes, No, plus Seer&apos;s native Invalid result. Its terms are the claim document below, pinned by digest.</p>
      </div>

      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
        <div className="min-w-0">
          {withheld ? (
            <Notice tone="caution" title="The claim document’s terms are not shown">
              {withheld}
            </Notice>
          ) : (
            <>
              <h3 className="t-h4">Requirement</h3>
              <Text>{spec.requirement}</Text>
              <h3 className="t-h4 mt-6">Violation a counterexample must show</h3>
              <Text>{spec.violation}</Text>
              {spec.regressionOnly && <p className="tag mt-3">Only regressions relative to the base commit qualify</p>}
              {spec.faultModel && (
                <>
                  <h3 className="t-h4 mt-6">Fault model</h3>
                  <Text>{spec.faultModel}</Text>
                </>
              )}
              {spec.allowedInputs && (
                <>
                  <h3 className="t-h4 mt-6">Allowed inputs</h3>
                  <Text>{spec.allowedInputs}</Text>
                </>
              )}
            </>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="t-h4">Pinned references</h3>
          <ul className="mt-3 grid gap-2">
            {refs.map((r) => (
              <li key={`${r.label}-${r.value}`} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[0.84375rem] text-lumen-2">{r.label}</span>
                <HashChip value={r.value} href={r.href} name={r.label} />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[0.78rem] text-lumen-3">
            {repo ? (
              <>
                Repository <span className="t-code text-lumen-2">{repo}</span> (GitHub id {api.repositoryId})
              </>
            ) : (
              <>GitHub repository id {api.repositoryId}</>
            )}
            {membership?.ref.kind === 'branch' ? (
              <>
                ; the commit {MEMBERSHIP[membership.method] ?? 'belongs to'} branch <span className="t-code text-lumen-2">{membership.ref.name}</span>
              </>
            ) : membership?.ref.kind === 'pull' ? (
              <>
                ; the commit {MEMBERSHIP[membership.method] ?? 'belongs to'} pull request #{membership.ref.number}
              </>
            ) : null}
            . {COPY.frozenTerms}
          </p>
          {docUrl && (
            <p className="mt-3 text-[0.84375rem]">
              <a className="link inline-flex items-center gap-1.5 text-lumen-2" href={docUrl} rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" download>
                <Download size={14} aria-hidden /> Download the claim document
              </a>
              <span className="mt-0.5 block text-[0.78rem] text-lumen-3">Canonical JSON from Pine&apos;s separate user-content domain, saved as a file. Its SHA-256 must equal the claim document digest above.</span>
            </p>
          )}
        </div>
      </div>

      {!withheld && (
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
          {params.length > 0 && (
            <div className="md:col-span-2">
              <h3 className="t-h4 text-lumen">Policy parameters</h3>
              <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(7rem,auto)_1fr]">
                {params.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="t-code text-[0.8125rem] text-lumen-3">{k}</dt>
                    <dd className="untrusted min-w-0">{parameterText(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          <div className="md:col-span-2 lg:col-span-3">
            <h3 className="t-h4 text-lumen">Reproduction environment</h3>
            <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-[9rem_1fr]">
              <dt className="text-lumen-3">Runtime</dt>
              <dd className="untrusted min-w-0">{env.runtime || 'Not stated'}</dd>
              {env.config.dependencies && (
                <>
                  <dt className="text-lumen-3">Dependencies</dt>
                  <dd className="untrusted min-w-0">{env.config.dependencies}</dd>
                </>
              )}
              {env.config.configuration && (
                <>
                  <dt className="text-lumen-3">Configuration</dt>
                  <dd className="untrusted min-w-0">{env.config.configuration}</dd>
                </>
              )}
              <dt className="text-lumen-3">External state</dt>
              <dd className="untrusted min-w-0">{env.externalState || 'None'}</dd>
              {env.setupSteps.length > 0 && (
                <>
                  <dt className="text-lumen-3">Setup</dt>
                  <dd className="min-w-0">
                    <ol className="list-decimal pl-5">
                      {env.setupSteps.map((s, i) => (
                        <li key={i} className="untrusted">
                          {s}
                        </li>
                      ))}
                    </ol>
                  </dd>
                </>
              )}
              <dt className="text-lumen-3">Command</dt>
              <dd className="min-w-0">
                <code className="t-code cut-sm untrusted block border border-edge bg-void px-2.5 py-1.5 text-lumen">{env.reproductionCommand || 'Not stated'}</code>
              </dd>
              {env.notes && (
                <>
                  <dt className="text-lumen-3">Notes</dt>
                  <dd className="untrusted min-w-0">{env.notes}</dd>
                </>
              )}
            </dl>
            <p className="mt-3 flex items-start gap-2 text-[0.78rem] text-lumen-3">
              <ShieldAlert size={13} aria-hidden className="mt-0.5 shrink-0" /> The creator wrote these terms. {COPY.untrustedContent}
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <ApiDeadlines claim={claim} />
        <div>
          <h3 className="t-h4">Evidence channel</h3>
          <p className="mt-2 text-[0.9375rem] text-lumen-2">
            Pine&apos;s evidence registry on Gnosis. Commit a sealed hash and reveal it later, or publish the evidence directly. The block timestamp of the transaction is the proof of timeliness.
          </p>
          {registry && (
            <p className="mt-3">
              <HashChip value={registry} label="Registry" href={explorerAddressUrl(claim.chainId, registry)} className="max-w-full" />
            </p>
          )}
          <p className="mt-3 text-[0.9375rem]">
            {claim.policy.unknown ? (
              <span className="text-ha">This claim pins a policy that is not in Pine&apos;s catalog; it is identified only by the digest above.</span>
            ) : (
              <Link href={claimPolicyHref(claim)} className="link text-lumen-2">
                Read the {claim.policy.id} policy
              </Link>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}
