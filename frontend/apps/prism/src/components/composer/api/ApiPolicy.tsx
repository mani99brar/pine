'use client'

import Link from 'next/link'
import type { ClaimDraft, PolicyVersion } from '@pine/core'
import { usePolicies, type ClaimComposer } from '@pine/react'
import { HashChip } from '@/components/ui/interactive'
import { ErrorState, LoadingBlock } from '@/components/ui/primitives'
import { FamilyIcon } from '@/components/icons'
import { FAMILY_NAME, FAMILY_VAR } from '@/lib/crystal'
import { cn } from '@/lib/cn'
import { StageHeader, StageIssues, StageNav, type StepNav } from '../shared'

// Policy stage in api mode: the backend's policy catalog. Approved policies, and draft policies on a deployment that
// allows them (development, staging), can be chosen; disabled (SC-001), retired or not-enabled ones are shown with the
// reason and cannot. The version is pinned explicitly: the question names the policy by its sha256.

const usable = (p: PolicyVersion) => p.status === 'enabled' || p.status === 'draft'
const keyOf = (p: Pick<PolicyVersion, 'id' | 'version'>) => `${p.id}@${p.version}`

/** Selects a policy version; parameters of another policy are dropped (the backend refuses parameters a policy does not define). */
function choose(d: ClaimDraft, p: PolicyVersion): ClaimDraft {
  const same = d.spec.policyId === p.id && d.spec.policyVersion === p.version
  const known = new Set(p.parameters.map((x) => x.key))
  const parameters = same ? (d.spec.parameters ?? {}) : Object.fromEntries(Object.entries(d.spec.parameters ?? {}).filter(([k]) => known.has(k)))
  return { ...d, spec: { ...d.spec, policyId: p.id, policyVersion: p.version, claimClass: undefined, parameters } }
}

function StatusTag({ p, active }: { p: PolicyVersion; active: boolean }) {
  if (p.status === 'gated') return <span className="tag ml-auto border-[rgba(183,154,255,0.45)] text-ca">Gated</span>
  if (p.status === 'retired') return <span className="tag ml-auto text-lumen-3">Retired</span>
  return (
    <span className="ml-auto flex flex-wrap gap-2">
      {p.status === 'draft' && <span className="tag border-[rgba(255,182,72,0.45)] text-na">Draft policy</span>}
      {active && <span className="tag text-lumen">Selected</span>}
    </span>
  )
}

export function ApiStagePolicy({ c, nav }: { c: ClaimComposer; nav: StepNav }) {
  const q = usePolicies()
  const policies = [...(q.data ?? [])].sort((a, b) => a.id.localeCompare(b.id) || b.version.localeCompare(a.version, undefined, { numeric: true }))
  const selected = c.draft.spec.policyId && c.draft.spec.policyVersion ? `${c.draft.spec.policyId}@${c.draft.spec.policyVersion}` : ''
  const enabled = policies.filter(usable)
  const select = (p: PolicyVersion) => {
    if (c.frozen || !usable(p)) return
    c.update((d: ClaimDraft) => choose(d, p))
  }
  const policy = c.policy

  return (
    <div>
      <StageHeader step="policy">
        A policy defines what counts as a counterexample. The market question names it by version and sha256, so later edits to the policy never change this
        claim.
      </StageHeader>
      {q.isLoading ? (
        <LoadingBlock lines={4} label="Loading Pine's policies" />
      ) : q.isError ? (
        <ErrorState title="Pine's policies could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      ) : policies.length === 0 ? (
        <p className="text-lumen-2">This Pine deployment lists no policies yet.</p>
      ) : (
        <div
          role="radiogroup"
          aria-label="Policy"
          className="grid gap-3"
          onKeyDown={(e) => {
            // Arrow keys move between usable policies and select them, as in a native radio group.
            const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
            if (!d || c.frozen || enabled.length === 0) return
            const i = Math.max(0, enabled.findIndex((p) => keyOf(p) === selected))
            const next = enabled[(i + d + enabled.length) % enabled.length]
            if (!next) return
            e.preventDefault()
            select(next)
            requestAnimationFrame(() => document.getElementById(`policy-${next.id}-${next.version}`)?.focus())
          }}
        >
          {policies.map((p) => {
            const active = selected === keyOf(p)
            const blocked = !usable(p)
            const first = !selected && keyOf(p) === (enabled[0] ? keyOf(enabled[0]) : '')
            return (
              <button
                key={keyOf(p)}
                id={`policy-${p.id}-${p.version}`}
                type="button"
                role="radio"
                aria-checked={active}
                aria-disabled={blocked}
                tabIndex={active || first || blocked ? 0 : -1}
                disabled={c.frozen}
                onClick={() => select(p)}
                className={cn(
                  'cut-lg relative overflow-hidden border p-5 text-left transition-colors',
                  active ? 'border-[rgba(255,236,220,0.45)] bg-smoke-2' : 'border-edge bg-smoke hover:border-edge-strong',
                  blocked && 'cursor-not-allowed opacity-75',
                )}
              >
                <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: FAMILY_VAR[p.family], opacity: active ? 1 : 0.5 }} />
                <div className="flex flex-wrap items-center gap-3">
                  <span style={{ color: FAMILY_VAR[p.family] }}>
                    <FamilyIcon family={p.family} size={22} />
                  </span>
                  <span className="t-h4">{keyOf(p)}</span>
                  <span className="text-[0.875rem] text-lumen-2">{p.title}</span>
                  <StatusTag p={p} active={active} />
                </div>
                {p.summary && <p className="mt-2 max-w-[68ch] text-[0.90625rem] text-lumen-2">{p.summary}</p>}
                <p className="mt-1 text-[0.8125rem] text-lumen-3">{FAMILY_NAME[p.family]}</p>
                {p.status === 'draft' && (
                  <p className="mt-2 text-[0.84375rem] text-na">Draft policy: this deployment allows it for testing. It is not approved market terms.</p>
                )}
                {blocked && p.gateReason && <p className="mt-2 text-[0.84375rem] text-ca">{p.gateReason}</p>}
                {blocked && !p.gateReason && <p className="mt-2 text-[0.84375rem] text-lumen-3">New claims cannot use this policy here.</p>}
              </button>
            )
          })}
        </div>
      )}
      {policy && (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <HashChip value={policy.contentHash} label="Policy sha256" />
          <Link href={`/policies/${encodeURIComponent(policy.id)}`} className="link text-[0.875rem]">
            Read {policy.id}
          </Link>
        </div>
      )}
      <StageIssues c={c} step="policy" className="mt-6" />
      <StageNav nav={nav} nextDisabled={!policy || !c.api?.policyPublishable || Boolean(c.api?.policyLoading)} />
    </div>
  )
}
