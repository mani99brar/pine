'use client'

import * as React from 'react'
import type { EnvironmentPin, EvidenceMechanismId } from '@pine/core'
import { EVIDENCE_MECHANISMS, formatAmount, formatDuration, timeRemaining } from '@pine/core'
import { CHAINS, SUPPORTED_CHAIN_IDS, getChainOrDefault } from '@pine/core/chains'
import { cn } from '@/lib/cn'
import { Callout } from '@/components/ui/callout'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import { HashChip } from '@/components/ui/hash-chip'
import { DataList } from '@/components/ui/pane'
import { useNowTick } from '@/lib/use-now'
import { useComposerCtx, fieldId } from './context'
import { KeyValueEditor, ListEditor, UtcDateTimeInput } from './editors'
import { Section } from './section'

export function EnvironmentSection() {
  const { c, err, touch, disabled, updateSpec } = useComposerCtx()
  const env = (c.draft.spec.environment ?? {}) as Partial<EnvironmentPin>
  const set = (patch: Partial<EnvironmentPin>) =>
    updateSpec((s) => ({ ...s, environment: { ...(s.environment as EnvironmentPin), ...patch } }))
  return (
    <Section
      id="environment"
      index={4}
      title="Environment"
      description="Pin everything a reproduction depends on. Non-secret configuration is hashed into the config hash, and the whole pin into the environment hash."
      aside={
        <span className="flex flex-wrap gap-1.5">
          <HashChip label="env" value={env.envHash} />
          <HashChip label="config" value={env.configHash} />
        </span>
      }
    >
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="Runtime" htmlFor={fieldId('spec.environment.runtime')} required error={err('spec.environment.runtime')}>
          <Input id={fieldId('spec.environment.runtime')} mono value={env.runtime ?? ''} disabled={disabled} onBlur={() => touch('spec.environment.runtime')} onChange={(e) => set({ runtime: e.target.value })} placeholder="node 22.14.0" />
        </Field>
        <Field label="Package manager" htmlFor="env-pm">
          <Input id="env-pm" mono value={env.packageManager ?? ''} disabled={disabled} onChange={(e) => set({ packageManager: e.target.value || undefined })} placeholder="pnpm 10.9.2" />
        </Field>
        <Field label="Lockfile path" htmlFor="env-lock-path">
          <Input
            id="env-lock-path"
            mono
            value={env.dependencyLock?.path ?? ''}
            disabled={disabled}
            onChange={(e) =>
              set({ dependencyLock: e.target.value || env.dependencyLock?.hash ? { path: e.target.value, hash: env.dependencyLock?.hash ?? ('' as `0x${string}`) } : undefined })
            }
            placeholder="pnpm-lock.yaml"
          />
        </Field>
        <Field label="Lockfile hash" htmlFor={fieldId('spec.environment.dependencyLock')} error={err('spec.environment.dependencyLock')} hint="keccak256 or sha256 of the lockfile, 0x-prefixed.">
          <Input
            id={fieldId('spec.environment.dependencyLock')}
            mono
            value={env.dependencyLock?.hash ?? ''}
            disabled={disabled}
            onBlur={() => touch('spec.environment.dependencyLock')}
            onChange={(e) =>
              set({ dependencyLock: e.target.value || env.dependencyLock?.path ? { path: env.dependencyLock?.path ?? '', hash: e.target.value as `0x${string}` } : undefined })
            }
            placeholder="0x…"
          />
        </Field>
        <Field label="Container image" htmlFor="env-image" hint="Pin by digest: image@sha256:…">
          <Input id="env-image" mono value={env.containerImage ?? ''} disabled={disabled} onChange={(e) => set({ containerImage: e.target.value || undefined })} placeholder="ghcr.io/org/app@sha256:…" />
        </Field>
        <Field label="External state" htmlFor="env-ext" hint="Chain snapshot, fixture dataset, or none.">
          <Input id="env-ext" value={env.externalState ?? ''} disabled={disabled} onChange={(e) => set({ externalState: e.target.value || undefined })} placeholder="none" />
        </Field>
      </div>
      <Field label="Reproduction command" htmlFor={fieldId('spec.environment.reproductionCommand')} required error={err('spec.environment.reproductionCommand')} hint="The command a counterexample must make fail. Runs in an isolated sandbox with no secrets.">
        <Input id={fieldId('spec.environment.reproductionCommand')} mono value={env.reproductionCommand ?? ''} disabled={disabled} onBlur={() => touch('spec.environment.reproductionCommand')} onChange={(e) => set({ reproductionCommand: e.target.value })} placeholder="pnpm vitest run test/reporter-funding.spec.ts" />
      </Field>
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="Setup steps" htmlFor={fieldId('spec.environment.setupSteps')}>
          <ListEditor id={fieldId('spec.environment.setupSteps')} mono value={env.setupSteps ?? []} disabled={disabled} onChange={(v) => set({ setupSteps: v })} placeholder="pnpm install --frozen-lockfile" addLabel="Add setup step" />
        </Field>
        <Field label="Configuration (non-secret)" htmlFor={fieldId('spec.environment.config')} error={err('spec.environment.config')}>
          <KeyValueEditor id={fieldId('spec.environment.config')} value={env.config ?? {}} disabled={disabled} onChange={(v) => set({ config: v })} />
        </Field>
      </div>
      <Field label="Notes" htmlFor="env-notes">
        <Textarea id="env-notes" rows={2} value={env.notes ?? ''} disabled={disabled} onChange={(e) => set({ notes: e.target.value || undefined })} />
      </Field>
    </Section>
  )
}

const PRESETS = [
  { label: '72h', hours: 72 },
  { label: '7 days', hours: 24 * 7 },
  { label: '14 days', hours: 24 * 14 },
  { label: '30 days', hours: 24 * 30 },
]

function roundHour(d: Date) {
  const x = new Date(d)
  x.setUTCMinutes(0, 0, 0)
  x.setUTCHours(x.getUTCHours() + 1)
  return x
}

export function DeadlinesSection() {
  const { c, err, touch, disabled, updateSpec } = useComposerCtx()
  const now = useNowTick(30_000)
  const spec = c.draft.spec
  const chainId = c.draft.funding?.chainId ?? spec.oracle?.chainId ?? 100
  const chain = getChainOrDefault(chainId)
  const deadline = spec.evidence?.deadline
  const oracle = spec.oracle
  const rem = deadline ? timeRemaining(deadline, now) : undefined
  const mech = spec.evidence?.mechanism ?? 'erc1497-arbitrator-proxy'
  return (
    <Section
      id="deadlines"
      index={5}
      title="Deadlines & oracle"
      description="Evidence must be submitted before an absolute UTC deadline. The oracle opens for answers at or after that deadline."
    >
      <Field label="Chain" htmlFor="chain" hint={!chain.verified ? 'Addresses for this chain are not verified yet.' : `Collateral ${chain.collateral.symbol}. Oracle bonds in ${chain.nativeSymbol}.`}>
        <Select
          id="chain"
          value={String(chainId)}
          disabled={disabled || c.fundingFrozen}
          onChange={(e) => c.update((d) => ({ ...d, funding: { ...d.funding, chainId: Number(e.target.value) } }))}
        >
          {SUPPORTED_CHAIN_IDS.map((id) => (
            <option key={id} value={id}>
              {CHAINS[id]?.name ?? id} ({id}){CHAINS[id]?.testnet ? ', testnet' : ''}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Evidence deadline"
        htmlFor={fieldId('spec.evidence.deadline')}
        required
        error={err('spec.evidence.deadline')}
        aside={rem ? <span className={cn('tnum', rem.past && 'text-flare')}>{rem.past ? `${rem.label} in the past` : `in ${rem.label}`}</span> : null}
      >
        <UtcDateTimeInput
          id={fieldId('spec.evidence.deadline')}
          value={deadline}
          disabled={disabled}
          invalid={!!err('spec.evidence.deadline')}
          onBlur={() => touch('spec.evidence.deadline')}
          onChange={(iso) => {
            updateSpec((s) => ({ ...s, evidence: { mechanism: s.evidence?.mechanism ?? 'erc1497-arbitrator-proxy', deadline: iso } }))
            touch('spec.evidence.deadline')
          }}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">From now:</span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={disabled}
              onClick={() => {
                const iso = roundHour(new Date(Date.now() + p.hours * 3600_000)).toISOString().replace('.000Z', 'Z')
                updateSpec((s) => ({ ...s, evidence: { mechanism: s.evidence?.mechanism ?? 'erc1497-arbitrator-proxy', deadline: iso } }))
              }}
              className="h-6 rounded-chip border border-line-strong px-1.5 text-[11.5px] hover:border-needle hover:text-needle"
            >
              {p.label}
            </button>
          ))}
        </div>
      </Field>

      <fieldset>
        <legend className="stretch-cond mb-1.5 text-[13px] font-medium">Evidence channel</legend>
        <div className="overflow-hidden rounded-ctl border border-line">
          {(Object.keys(EVIDENCE_MECHANISMS) as EvidenceMechanismId[]).map((id) => {
            const m = EVIDENCE_MECHANISMS[id]
            return (
              <label key={id} className={cn('flex cursor-pointer gap-3 border-b border-line px-3 py-2.5 last:border-b-0 hover:bg-frost', mech === id && 'bg-needle-soft/50')}>
                <input
                  type="radio"
                  name="mechanism"
                  checked={mech === id}
                  disabled={disabled}
                  onChange={() => updateSpec((s) => ({ ...s, evidence: { deadline: s.evidence?.deadline ?? '', mechanism: id } }))}
                  className="mt-1 accent-[var(--needle)]"
                />
                <span className="min-w-0">
                  <span className="text-[13.5px] font-medium">{m.label}</span>
                  <span className="mt-0.5 block text-[12.5px] text-muted">{m.description}</span>
                  {m.launchGate ? <span className="mt-0.5 block text-[12px] text-resin">{m.launchGate}</span> : null}
                </span>
              </label>
            )
          })}
        </div>
        <p className="mt-1.5 text-xs text-muted">
          Evidence is an {chain.arbitration.chainId === 1 ? 'Ethereum mainnet' : `chain ${chain.arbitration.chainId}`} transaction to the {chain.arbitration.requestContractName}, even when the market is on {chain.name}. Investigators pay that gas.
        </p>
      </fieldset>

      <div className="grid gap-5 md:grid-cols-2">
        <Field label="Oracle opening time" htmlFor={fieldId('spec.oracle.openingTime')} required error={err('spec.oracle.openingTime')} hint="Follows the deadline (+1 hour) unless you change it. Must not be before the deadline.">
          <UtcDateTimeInput
            id={fieldId('spec.oracle.openingTime')}
            value={oracle?.openingTime}
            min={deadline}
            disabled={disabled}
            invalid={!!err('spec.oracle.openingTime')}
            onBlur={() => touch('spec.oracle.openingTime')}
            onChange={(iso) => updateSpec((s) => (s.oracle ? { ...s, oracle: { ...s.oracle, openingTime: iso } } : s))}
          />
        </Field>
        <Field label={`Minimum answer bond (${chain.nativeSymbol})`} htmlFor={fieldId('spec.oracle.minBond')} required error={err('spec.oracle.minBond')} hint={`Seer's default on ${chain.name} is ${chain.defaultMinBond} ${chain.nativeSymbol}. Each later answer must double the bond.`}>
          <Input
            id={fieldId('spec.oracle.minBond')}
            inputMode="decimal"
            className="tnum"
            value={oracle?.minBond ?? ''}
            disabled={disabled}
            onBlur={() => touch('spec.oracle.minBond')}
            onChange={(e) => updateSpec((s) => (s.oracle ? { ...s, oracle: { ...s.oracle, minBond: e.target.value } } : s))}
          />
        </Field>
      </div>
      <DataList
        className="rounded-ctl border border-line"
        labelWidth="11rem"
        rows={[
          {
            label: 'Answer timeout',
            value: <span className="tnum">{formatDuration(chain.seerQuestionTimeoutSeconds * 1000)} (fixed)</span>,
            hint: "Set by Seer's official market factory and not editable. Each new answer restarts it.",
          },
          { label: 'Arbitrator', value: oracle?.arbitratorName ?? chain.arbitratorName, hint: <span className="mono-cond text-[11px]">{oracle?.arbitrator ?? chain.arbitrator}</span> },
          {
            label: 'If an answer is disputed',
            value: `${chain.arbitration.courtName}, ${chain.arbitration.jurors} jurors, fee about ${formatAmount(chain.arbitration.feeEstimate, { symbol: chain.arbitration.feeCurrency, maxDecimals: 4 })}`,
            hint: `Requested and paid on Ethereum by whoever disputes. About ${chain.arbitration.typicalRulingDays} days to a first ruling, plus about ${chain.arbitration.typicalAppealDays} days per appeal.${chain.arbitration.bridgeDelayNote ? ` ${chain.arbitration.bridgeDelayNote}` : ''}`,
          },
          { label: 'Language and category', value: <span className="mono-cond text-[12px]">{oracle?.language ?? 'en_US'} / {oracle?.category ?? 'misc'}</span> },
        ]}
      />
      {!chain.verified ? <Callout tone="warning">{chain.notes[0] ?? 'Contract addresses for this chain are unverified placeholders.'}</Callout> : null}
    </Section>
  )
}
