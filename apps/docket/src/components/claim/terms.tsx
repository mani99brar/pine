import Link from 'next/link'
import type { ClaimManifest } from '@pine/core'
import { formatDate, shortHash } from '@pine/core'
import { EVIDENCE_MECHANISMS } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { HashValue } from '@/components/ui/copy'
import { DefinitionList } from '@/components/ui/layout'
import { ExternalLink } from '@/components/ui/external-link'
import { formatTimeout } from '@/lib/format'

function Bullets({ items, empty = 'None stated' }: { items: string[] | undefined; empty?: string }) {
  if (!items || items.length === 0) return <span className="text-graphite">{empty}</span>
  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((x, i) => (
        <li key={i} className="untrusted">
          {x}
        </li>
      ))}
    </ul>
  )
}

/** Everything binding about the claim, as frozen in the manifest. */
export function TermsOnRecord({
  manifest,
  manifestUri,
  manifestHash,
  gatewayUrl,
}: {
  manifest: ClaimManifest
  manifestUri?: string
  manifestHash?: string
  gatewayUrl?: string
}) {
  const c = manifest.claim
  const s = manifest.source
  const env = c.environment
  const mech = c.evidence ? EVIDENCE_MECHANISMS[c.evidence.mechanism] : undefined
  const params = Object.entries(c.parameters ?? {})

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-xl">The requirement</h3>
        <p className="mt-1 text-[15px] text-graphite">The one behavior that must hold. Exhibits try to show it does not.</p>
        <p className="record untrusted mt-3 border-l-4 border-ink pl-5">{c.requirement}</p>
        {c.claimClass ? <p className="mt-2 text-sm text-graphite">Claim class: {c.claimClass}</p> : null}
      </div>

      <div>
        <h3 className="mb-2 text-xl">Code under examination</h3>
        <DefinitionList
          items={[
            {
              term: 'Repository',
              value: (
                <ExternalLink href={`https://github.com/${s.owner}/${s.repo}`}>
                  {s.owner}/{s.repo}
                </ExternalLink>
              ),
              note: s.license ? `License: ${s.license}` : undefined,
            },
            {
              term: 'Commit',
              value: <HashValue value={s.commit.sha} wrap label="commit SHA" />,
              note: (
                <>
                  <span className="untrusted">{s.commit.message.split('\n')[0]}</span> (authored by {s.commit.author},{' '}
                  {formatDate(s.commit.committedAt, 'short')}).{' '}
                  <ExternalLink href={s.commit.htmlUrl}>View on GitHub</ExternalLink>
                </>
              ),
            },
            ...(s.baseCommit
              ? [
                  {
                    term: 'Base commit',
                    value: <HashValue value={s.baseCommit.sha} wrap label="base commit SHA" />,
                    note: c.regressionOnly
                      ? 'Only regressions introduced relative to this base qualify.'
                      : 'Shown for context. Any violation in the commit qualifies, not only regressions.',
                  },
                ]
              : []),
            ...(s.pullRequest
              ? [
                  {
                    term: 'Pull request',
                    value: (
                      <ExternalLink href={s.pullRequest.htmlUrl}>
                        <span className="untrusted">
                          #{s.pullRequest.number}: {s.pullRequest.title}
                        </span>
                      </ExternalLink>
                    ),
                    note: 'For context only. The claim covers the pinned commit, not later pushes to this pull request.',
                  },
                ]
              : []),
          ]}
        />
      </div>

      <div>
        <h3 className="mb-2 text-xl">Scope and assumptions</h3>
        <DefinitionList
          items={[
            { term: 'In scope', value: <Bullets items={c.scope?.inScope} /> },
            { term: 'Out of scope', value: <Bullets items={c.scope?.outOfScope} /> },
            ...(c.faultModel ? [{ term: 'Fault model', value: <span className="untrusted">{c.faultModel}</span> }] : []),
            ...(c.allowedInputs ? [{ term: 'Allowed inputs', value: <span className="untrusted">{c.allowedInputs}</span> }] : []),
            { term: 'Assumptions', value: <Bullets items={c.assumptions} /> },
            { term: 'Claim exclusions', value: <Bullets items={c.exclusions} />, note: 'In addition to the policy’s own exclusions.' },
            ...params.map(([k, v]) => ({
              term: k,
              value: (
                <span className="untrusted">
                  {Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v}
                </span>
              ),
            })),
          ]}
        />
      </div>

      {env ? (
        <div>
          <h3 className="mb-2 text-xl">Reproduction environment</h3>
          <DefinitionList
            items={[
              { term: 'Runtime', value: env.runtime },
              ...(env.packageManager ? [{ term: 'Package manager', value: env.packageManager }] : []),
              ...(env.dependencyLock
                ? [
                    {
                      term: 'Dependency lock',
                      value: (
                        <span>
                          <code className="font-mono text-[14px]">{env.dependencyLock.path}</code>{' '}
                          <HashValue value={env.dependencyLock.hash} display={shortHash(env.dependencyLock.hash, 8)} label="lockfile hash" />
                        </span>
                      ),
                    },
                  ]
                : []),
              ...(env.containerImage
                ? [{ term: 'Container image', value: <code className="font-mono text-[14px] break-all">{env.containerImage}</code> }]
                : []),
              { term: 'External state', value: env.externalState ?? 'None' },
              {
                term: 'Configuration',
                value:
                  Object.keys(env.config ?? {}).length === 0 ? (
                    <span className="text-graphite">No configuration values</span>
                  ) : (
                    <ul className="space-y-0.5 font-mono text-[14px]">
                      {Object.entries(env.config).map(([k, v]) => (
                        <li key={k} className="break-all">
                          {k}={v}
                        </li>
                      ))}
                    </ul>
                  ),
                note: (
                  <>
                    Config hash <HashValue value={env.configHash} display={shortHash(env.configHash, 8)} label="config hash" />
                  </>
                ),
              },
              {
                term: 'Reproduction command',
                value: (
                  <pre className="bg-bond px-3 py-2 font-mono text-[14px] leading-6 whitespace-pre-wrap break-all">{env.reproductionCommand}</pre>
                ),
              },
              ...(env.setupSteps?.length
                ? [
                    {
                      term: 'Setup steps',
                      value: (
                        <ol className="list-decimal space-y-1 pl-5">
                          {env.setupSteps.map((x, i) => (
                            <li key={i} className="untrusted">
                              {x}
                            </li>
                          ))}
                        </ol>
                      ),
                    },
                  ]
                : []),
              {
                term: 'Environment hash',
                value: <HashValue value={env.envHash} wrap label="environment hash" />,
                note: 'Fingerprint of everything above. It appears in the question.',
              },
            ]}
          />
        </div>
      ) : null}

      <div>
        <h3 className="mb-2 text-xl">Rules, evidence and oracle</h3>
        <DefinitionList
          items={[
            {
              term: 'Policy',
              value: (
                <Link href={`/policies/${manifest.policy.id}?version=${manifest.policy.version}`} className="link">
                  {manifest.policy.id}@{manifest.policy.version}
                </Link>
              ),
              note: (
                <>
                  Policy text hash <HashValue value={manifest.policy.hash} display={shortHash(manifest.policy.hash, 8)} label="policy hash" />
                </>
              ),
            },
            ...(c.evidence
              ? [
                  {
                    term: 'Evidence deadline',
                    value: <strong>{formatDate(c.evidence.deadline, 'long')}</strong>,
                    note: 'Absolute and in UTC. Not a trading cutoff.',
                  },
                  {
                    term: 'Where exhibits go',
                    value: mech?.label ?? c.evidence.mechanism,
                    note: mech?.launchGate ? `Launch gate: ${mech.launchGate}` : mech?.description,
                  },
                ]
              : []),
            ...(c.oracle
              ? [
                  {
                    term: 'Oracle opens',
                    value: formatDate(c.oracle.openingTime, 'long'),
                    note: 'Reality.eth accepts answers from this moment.',
                  },
                  {
                    term: 'Answer timeout',
                    value: formatTimeout(c.oracle.timeoutSeconds),
                    note: `How long an answer must stand unchallenged to become final. ${COPY.fixedTimeout}`,
                  },
                  { term: 'Minimum bond', value: `${c.oracle.minBond} ${c.oracle.bondToken}` },
                  { term: 'Arbitrator', value: c.oracle.arbitratorName },
                ]
              : []),
            ...(c.specReference
              ? [
                  {
                    term: 'Source requirement',
                    value: <ExternalLink href={c.specReference.url}>{c.specReference.label}</ExternalLink>,
                  },
                ]
              : []),
            ...(manifestHash
              ? [
                  {
                    term: 'Manifest',
                    value: <HashValue value={manifestHash} wrap label="manifest hash" />,
                    note: manifestUri ? (
                      <>
                        Stored at <code className="font-mono text-[13px] break-all">{manifestUri}</code>
                        {gatewayUrl ? (
                          <>
                            {' '}
                            <ExternalLink href={gatewayUrl}>Open through a gateway</ExternalLink>
                          </>
                        ) : null}
                      </>
                    ) : undefined,
                  },
                ]
              : []),
          ]}
        />
      </div>
    </div>
  )
}
