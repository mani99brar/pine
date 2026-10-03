'use client'

import type { ClaimDraft, IsoDate } from '@pine/core'
import { formatDate, formatDuration } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import type { ClaimComposer } from '@pine/react'
import { Lock } from 'lucide-react'
import { FormField } from '@/components/ui/primitives'
import { useNowMs } from '@/lib/hooks'
import { issueFor, StageHeader, StageIssues, StageNav, type StepNav } from '../shared'

// Deadlines in api mode. The user picks the evidence deadline; the backend measures it as a window from the preview
// (3..30 days) and fixes the rest: the reveal deadline (48 h later by default), the Reality opening time (= the reveal
// deadline), the 3.5-day answer timeout and the arbitrator. Those are shown as derived values, never as inputs.

const HOUR = 3_600_000

function isoParts(iso?: string): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: '', time: '' }
  const p = (n: number) => String(n).padStart(2, '0')
  return { date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` }
}
const toIso = (date: string, time: string) => (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time) ? `${date}T${time}:00Z` : undefined)

function Derived({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <div className="cut-sm border border-edge bg-void px-3 py-2.5">
      <dt className="flex items-center gap-1.5 text-[0.78rem] text-lumen-3">
        <Lock size={12} aria-hidden /> {label}
      </dt>
      <dd className="tnum mt-0.5 text-[0.9rem] text-lumen">{value}</dd>
      <dd className="mt-1 text-[0.75rem] text-lumen-3">{help}</dd>
    </div>
  )
}

export function ApiStageDeadlines({ c, nav }: { c: ClaimComposer; nav: StepNav }) {
  const now = useNowMs()
  const api = c.api
  const dis = c.frozen
  const deadline = c.draft.spec.evidence?.deadline
  const parts = isoParts(deadline)
  const timeline = api?.timeline
  const rules = api?.rules
  const arb = getChainOrDefault(c.fundingInput.chainId).arbitration
  const setDeadline = (iso: IsoDate) =>
    c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, evidence: { mechanism: d.spec.evidence?.mechanism ?? 'erc1497-arbitrator-proxy', deadline: iso } } }))
  const minBond = c.draft.spec.oracle?.minBond ?? ''
  const revealHours = (rules?.revealWindowSeconds ?? 0) / 3600
  const windowMs = now && deadline ? Date.parse(deadline) - now : null
  const fmt = (iso?: IsoDate) => (iso ? formatDate(iso, 'utc') : '—')

  return (
    <div>
      <StageHeader step="deadlines">
        The evidence deadline is an absolute UTC time, 3 to 30 days after you request the preview. Pine fixes the rest: sealed evidence can be revealed for{' '}
        {revealHours} hours after it, answers open on Reality.eth when the reveal window ends, and every answer can be challenged for 3.5 days.
      </StageHeader>

      {/* Schematic timeline */}
      <div className="cut-lg well mb-8 p-4" aria-hidden>
        <div className="grid grid-cols-[2fr_0.8fr_1.2fr_1.6fr] gap-1 text-[0.75rem]">
          {[
            ['Evidence window', windowMs !== null && windowMs > 0 ? formatDuration(windowMs) : 'set a future time', 'var(--hb)'],
            ['Reveal', `${revealHours}h`, 'var(--ca)'],
            ['Answers and challenges', '3.5 days per answer', 'var(--na)'],
            ['If escalated: Kleros', `about ${arb.typicalRulingDays} days, plus ${arb.typicalAppealDays} per appeal`, 'var(--ha)'],
          ].map(([label, sub, color]) => (
            <div key={label} className="min-w-0">
              <div className="h-[3px] rounded-full" style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
              <p className="mt-2 font-semibold leading-[1.3] text-lumen-2">{label}</p>
              <p className="mt-0.5 leading-[1.3] text-lumen-3">{sub}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-6">
        <fieldset aria-describedby="deadline-help">
          <legend className="label">Evidence deadline (UTC)</legend>
          <div className="flex flex-wrap gap-2">
            {(rules?.presetDays ?? []).map((days) => {
              const iso = now && api ? api.deadlineForDays(days, new Date(now)) : ''
              const active = Boolean(now && deadline && iso && Math.abs(Date.parse(deadline) - Date.parse(iso)) <= HOUR)
              return (
                <button key={days} type="button" className="chip" aria-pressed={active} disabled={dis || !now || !iso} onClick={() => iso && setDeadline(iso)}>
                  {days} days from now
                </button>
              )
            })}
          </div>
          <div className="mt-3 grid max-w-[28rem] grid-cols-[1.3fr_1fr] gap-2">
            <div>
              <label htmlFor="deadline-date" className="sr-only">
                Deadline date (UTC)
              </label>
              <input
                id="deadline-date"
                type="date"
                className="field tnum"
                value={parts.date}
                disabled={dis}
                onChange={(e) => {
                  const iso = toIso(e.target.value, parts.time || '00:00')
                  if (iso) setDeadline(iso)
                }}
              />
            </div>
            <div>
              <label htmlFor="deadline-time" className="sr-only">
                Deadline time (UTC)
              </label>
              <input
                id="deadline-time"
                type="time"
                step={60}
                className="field tnum"
                value={parts.time}
                disabled={dis}
                onChange={(e) => {
                  const iso = toIso(parts.date, e.target.value)
                  if (iso) setDeadline(iso)
                }}
              />
            </div>
          </div>
          <p id="deadline-help" className="help mt-1.5">
            {deadline ? formatDate(deadline, 'utc') : 'No deadline set'}
            {now && deadline ? `, ${formatDuration(Math.max(0, Date.parse(deadline) - now))} from now` : ''}. Allowed: 3 to 30 days from when you request the preview.
          </p>
          {issueFor(c, 'spec.evidence') && (
            <p className="mt-1 text-[0.8125rem] font-medium text-ha" role="alert">
              {issueFor(c, 'spec.evidence')}
            </p>
          )}
          <p className="mt-2 text-[0.84375rem] text-lumen-3">{COPY.deadlineIsNotTradingCutoff}</p>
        </fieldset>

        <section aria-labelledby="derived-title">
          <h3 id="derived-title" className="label">
            Fixed by Pine if you request the preview now
          </h3>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Derived label="Evidence deadline" value={fmt(timeline?.evidenceDeadline)} help="Evidence is committed or published while the block time is before it (rounded up to the minute)." />
            <Derived label="Reveal deadline" value={fmt(timeline?.revealDeadline)} help={`${revealHours} hours after the evidence deadline: sealed evidence is revealed before it.`} />
            <Derived label="Oracle opens" value={fmt(timeline?.answersOpen)} help="Reality.eth accepts answers from the reveal deadline on." />
            <Derived label="Earliest finalization" value={fmt(timeline?.earliestFinalization)} help="Opening plus the 3.5-day answer timeout; every new answer restarts it." />
          </dl>
          <p className="mt-2 text-[0.78rem] text-lumen-3">The preview states the exact times Pine fixes; the deployment may configure a different reveal window.</p>
        </section>

        <div className="cut-md border border-edge bg-smoke px-4 py-3">
          <p className="text-[0.9rem] font-semibold text-lumen">Evidence channel: Pine&apos;s evidence registry on Gnosis</p>
          <p className="mt-0.5 text-[0.8125rem] text-lumen-2">
            Investigators publish evidence directly, or commit it sealed before the evidence deadline and reveal it before the reveal deadline.
          </p>
        </div>

        <FormField
          id="min-bond"
          className="max-w-[28rem]"
          label="Minimum answer bond (xDAI)"
          help={`Answerers post at least this bond; each challenge must double it. Between ${rules?.minBondXdai.min ?? '1'} and ${rules?.minBondXdai.max ?? '100'} xDAI. Leave it empty for Pine's default.`}
          error={issueFor(c, 'spec.oracle.minBond')}
        >
          <input
            id="min-bond"
            className="field tnum"
            inputMode="decimal"
            value={minBond}
            disabled={dis}
            aria-invalid={Boolean(issueFor(c, 'spec.oracle.minBond')) || undefined}
            onChange={(e) =>
              c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, oracle: { ...c.spec.oracle, ...(d.spec.oracle ?? {}), minBond: e.target.value.replace(',', '.').trim() } } }))
            }
          />
        </FormField>

        <dl className="grid gap-3 sm:grid-cols-2">
          <Derived label="Answer timeout" value="3.5 days (302,400 seconds), fixed" help={COPY.fixedTimeout} />
          <Derived
            label="Arbitrator"
            value={c.spec.oracle.arbitratorName}
            help={`About ${arb.feeEstimate} ${arb.feeCurrency} on Ethereum, paid by whoever requests it. ${COPY.arbitrationOnEthereum}`}
          />
        </dl>
      </div>
      <StageIssues c={c} step="deadlines" className="mt-6" />
      <StageNav nav={nav} />
    </div>
  )
}
