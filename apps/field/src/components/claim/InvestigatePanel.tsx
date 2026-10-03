'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import type { ClaimDetail } from '@pine/core'
import { formatDate, getEvidenceMechanism, shortSha } from '@pine/core'
import { briefToMarkdown, toAgentBrief } from '@pine/core/agent'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { usePolicy } from '@pine/react'
import { Bot, CheckSquare, Plus, TerminalSquare } from 'lucide-react'
import { CodeBlock, CopyButton, ExternalLink, HashChip } from '@/components/ui/interactive'
import { KV, Note } from '@/components/ui/primitives'
import { ButtonLink } from '@/components/ui/Button'
import { siteUrlClient } from '@/lib/site-client'

function List({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-[0.88rem] text-ink-3">{empty}</p>
  return (
    <ul className="space-y-1.5 text-[0.9rem] text-ink-2">
      {items.map((s, i) => (
        <li key={i} className="flex gap-2">
          <span aria-hidden className="mt-[0.6em] h-[3px] w-2.5 shrink-0 bg-ink-3" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{s}</span>
        </li>
      ))}
    </ul>
  )
}

export function AgentBriefActions({ claim, compact }: { claim: ClaimDetail; compact?: boolean }) {
  const site = siteUrlClient()
  const markdown = useMemo(() => {
    try {
      return briefToMarkdown(toAgentBrief(claim, { siteUrl: site }))
    } catch {
      return `# ${claim.title}\n\n${claim.manifest.question.text}\n`
    }
  }, [claim, site])
  const apiUrl = `${site}/api/agent/v1/claims/${claim.id}`
  const curl = `curl -s ${apiUrl} | jq .`
  return (
    <div className={compact ? 'flex flex-wrap gap-2' : 'grid gap-2'}>
      <CopyButton variant="button" text={markdown} label="Copy agent brief" copiedLabel="Agent brief copied" className={compact ? 'h-8 text-[0.82rem]' : undefined} />
      {!compact && <CopyButton variant="button" text={curl} label="Copy curl" copiedLabel="curl copied" />}
      {!compact && (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[0.84rem]">
          <a href={`/api/agent/v1/claims/${claim.id}`} className="underline underline-offset-2" target="_blank" rel="noopener noreferrer">
            JSON brief
          </a>
          <a href={`/api/agent/v1/claims/${claim.id}?format=md`} className="underline underline-offset-2" target="_blank" rel="noopener noreferrer">
            Markdown brief
          </a>
          <a href={`/api/agent/v1/claims/${claim.id}/manifest.json`} className="underline underline-offset-2" target="_blank" rel="noopener noreferrer">
            Manifest
          </a>
        </div>
      )}
    </div>
  )
}

export function InvestigatePanel({ claim }: { claim: ClaimDetail }) {
  const spec = claim.manifest.claim
  const env = spec.environment
  const policyQ = usePolicy(claim.policy.id, claim.policy.version)
  const policy = policyQ.data
  const mech = getEvidenceMechanism(spec.evidence.mechanism)
  const arb = getChainOrDefault(claim.chainId).arbitration
  const l1 = getChainOrDefault(arb.chainId)
  const configEntries = Object.entries(env.config ?? {})

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
      <div className="grid min-w-0 gap-8">
        <section aria-labelledby="inv-req">
          <h3 id="inv-req" className="t-h3">
            The requirement
          </h3>
          <p className="mt-2 max-w-[70ch] text-[1.02rem] leading-[1.55] [overflow-wrap:anywhere]">{spec.requirement}</p>
          <p className="mt-3 max-w-[70ch] text-[0.92rem] text-ink-2">
            A counterexample must demonstrate that <span className="font-[650] text-ink">{spec.violation}</span>
            {spec.regressionOnly && claim.source.commitSha ? ', as a regression relative to the pinned base commit' : ''}.
          </p>
          {spec.specReference && (
            <p className="mt-2 text-[0.86rem]">
              Source requirement: <ExternalLink href={spec.specReference.url}>{spec.specReference.label}</ExternalLink>
            </p>
          )}
        </section>

        <section aria-labelledby="inv-repro">
          <h3 id="inv-repro" className="t-h3 flex items-center gap-2">
            <TerminalSquare size={18} aria-hidden /> Reproduce
          </h3>
          <p className="mt-1 text-[0.86rem] text-ink-2">
            Check out <code className="t-code">{claim.source.owner}/{claim.source.repo}</code> at <code className="t-code">{shortSha(claim.source.commitSha)}</code>, then:
          </p>
          {env.setupSteps.length > 0 && <CodeBlock className="mt-3" label="Setup" code={env.setupSteps.join('\n')} />}
          <CodeBlock className="mt-3" label="Reproduction command" code={env.reproductionCommand} />
          <p className="mt-2 text-[0.8rem] text-ink-3">{COPY.noAttackAuthorization}</p>
        </section>

        <section aria-labelledby="inv-env">
          <h3 id="inv-env" className="t-h3">
            Environment pins
          </h3>
          <KV
            className="mt-2"
            rows={[
              { k: 'Runtime', v: env.runtime },
              ...(env.packageManager ? [{ k: 'Package manager', v: env.packageManager }] : []),
              ...(env.dependencyLock
                ? [{ k: 'Lockfile', v: <span className="flex flex-wrap items-center gap-2"><code className="t-code">{env.dependencyLock.path}</code><HashChip value={env.dependencyLock.hash} label="hash" /></span> }]
                : []),
              ...(env.containerImage ? [{ k: 'Container image', v: <code className="t-code break-all">{env.containerImage}</code> }] : []),
              { k: 'External state', v: env.externalState ?? 'none' },
              {
                k: 'Configuration',
                v: configEntries.length ? (
                  <div className="grid gap-1">
                    {configEntries.map(([k, v]) => (
                      <div key={k} className="flex min-w-0 gap-2">
                        <code className="t-code shrink-0 text-ink-2">{k}</code>
                        <code className="t-code min-w-0 break-all">{v}</code>
                      </div>
                    ))}
                    <HashChip value={env.configHash} label="config hash" className="mt-1 w-fit" />
                  </div>
                ) : (
                  'none'
                ),
              },
              { k: 'Environment hash', v: <HashChip value={env.envHash} label="env" /> },
              ...(env.notes ? [{ k: 'Notes', v: env.notes }] : []),
            ]}
          />
        </section>

        <section aria-labelledby="inv-scope" className="grid gap-6 sm:grid-cols-2">
          <div>
            <h3 id="inv-scope" className="t-h3">
              In scope
            </h3>
            <div className="mt-2">
              <List items={spec.scope.inScope} empty="Not specified." />
            </div>
          </div>
          <div>
            <h3 className="t-h3">Out of scope</h3>
            <div className="mt-2">
              <List items={spec.scope.outOfScope} empty="Nothing listed." />
            </div>
          </div>
          {spec.faultModel && (
            <div>
              <h3 className="t-h3">Fault model</h3>
              <p className="mt-2 text-[0.9rem] text-ink-2 [overflow-wrap:anywhere]">{spec.faultModel}</p>
            </div>
          )}
          {spec.allowedInputs && (
            <div>
              <h3 className="t-h3">Allowed inputs</h3>
              <p className="mt-2 text-[0.9rem] text-ink-2 [overflow-wrap:anywhere]">{spec.allowedInputs}</p>
            </div>
          )}
          <div>
            <h3 className="t-h3">Assumptions</h3>
            <div className="mt-2">
              <List items={spec.assumptions} empty="None stated." />
            </div>
          </div>
          <div>
            <h3 className="t-h3">Exclusions</h3>
            <div className="mt-2">
              <List items={[...spec.exclusions, ...(policy?.exclusions ?? [])]} empty="None stated." />
            </div>
          </div>
        </section>
      </div>

      <aside className="grid min-w-0 content-start gap-5">
        <section className="rounded-[var(--radius-tile)] border border-line bg-sheet p-5" aria-labelledby="inv-adm">
          <h3 id="inv-adm" className="t-h3 flex items-center gap-2">
            <CheckSquare size={18} aria-hidden /> What counts as evidence
          </h3>
          {policy ? (
            <ol className="mt-3 space-y-2 text-[0.88rem]">
              {policy.evidenceRequirements.map((r, i) => (
                <li key={i} className="flex gap-2.5">
                  <span aria-hidden className="t-figure mt-[1px] w-4 shrink-0 text-right text-[0.95rem] text-ink-3">
                    {i + 1}
                  </span>
                  <span className="text-ink-2">{r}</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="mt-3 grid gap-2">
              <span className="skeleton h-4 w-full" />
              <span className="skeleton h-4 w-5/6" />
            </div>
          )}
          <p className="mt-3 text-[0.8rem] text-ink-3">
            From <Link href={`/policies/${claim.policy.id}?v=${claim.policy.version}`} className="underline underline-offset-2">{claim.policy.id}@{claim.policy.version}</Link>. {COPY.evidenceIsNotPayment}
          </p>
        </section>

        <section className="rounded-[var(--radius-tile)] border border-line bg-sheet p-5" aria-labelledby="inv-chan">
          <h3 id="inv-chan" className="t-h3">
            Evidence channel
          </h3>
          <p className="mt-2 font-[620]">{mech?.label ?? spec.evidence.mechanism}</p>
          {mech?.description && <p className="mt-1 text-[0.86rem] text-ink-2 [overflow-wrap:anywhere]">{mech.description}</p>}
          <p className="mt-3 text-[0.86rem] text-ink-2">
            Deadline <span className="font-[650] text-ink">{formatDate(spec.evidence.deadline, 'long')}</span>, by block timestamp. Submitting is a transaction on {l1.name}
            {claim.chainId !== arb.chainId ? ` even though the market is on ${getChainOrDefault(claim.chainId).name}` : ''}, so your wallet switches to {l1.name}.
          </p>
          {mech?.launchGate && <Note tone="caution" className="mt-3">{mech.launchGate}</Note>}
          {claim.status === 'open' && (
            <ButtonLink href={`/claims/${claim.id}/evidence`} className="mt-4 w-full" icon={<Plus size={16} aria-hidden />}>
              Submit evidence
            </ButtonLink>
          )}
        </section>

        <section className="rounded-[var(--radius-tile)] bg-ink p-5 text-on-ink" aria-labelledby="inv-agent">
          <h3 id="inv-agent" className="t-h3 flex items-center gap-2">
            <Bot size={18} aria-hidden /> Hand it to an agent
          </h3>
          <p className="mt-1 text-[0.86rem] text-on-ink/80">
            The brief carries the target, pins, reproduction command, admissibility rules, deadline and disclaimers. Same content as the JSON API.
          </p>
          <div className="mt-4 [&_a]:text-on-ink [&_button]:border-on-ink/70 [&_button]:text-on-ink [&_button:hover]:bg-white/10">
            <AgentBriefActions claim={claim} />
          </div>
        </section>
      </aside>
    </div>
  )
}
