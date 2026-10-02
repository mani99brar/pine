'use client'

import { useMemo } from 'react'
import type { EvidenceMechanismId, OracleParams } from '@pine/core'
import { EVIDENCE_MECHANISMS, formatAmount, formatDate, isEvidenceMechanismEnabled } from '@pine/core'
import { CHAINS } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { cn } from '@/lib/cn'
import { Choices, Field, Input, MarginNote } from '@/components/ui/field'
import { formatTimeout } from '@/lib/format'
import { useClientNow } from '@/components/ui/when'
import { useWizard } from '../context'

function splitUtc(iso: string | undefined): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: '', time: '' }
  const s = d.toISOString()
  return { date: s.slice(0, 10), time: s.slice(11, 16) }
}

function joinUtc(date: string, time: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return undefined
  return `${date}T${time}:00Z`
}

function humanDuration(ms: number): string {
  const hours = Math.round(ms / 3600_000)
  if (hours < 48) return `${hours} hours`
  const days = Math.round(hours / 24)
  return `${days} days`
}

function presetFrom(now: Date, hours: number): string {
  const t = now.getTime() + hours * 3600_000
  const rounded = Math.ceil(t / 3600_000) * 3600_000
  return new Date(rounded).toISOString().replace('.000Z', 'Z')
}

function UtcDateTime({
  idPrefix,
  value,
  onChange,
  invalid,
}: {
  idPrefix: string
  value: string | undefined
  onChange: (iso: string) => void
  invalid?: boolean
}) {
  const { date, time } = splitUtc(value)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        id={`${idPrefix}-date`}
        type="date"
        aria-label="Date (UTC)"
        className="w-[11.5rem]"
        value={date}
        aria-invalid={invalid}
        onChange={(e) => {
          const iso = joinUtc(e.target.value, time || '18:00')
          if (iso) onChange(iso)
        }}
      />
      <Input
        id={`${idPrefix}-time`}
        type="time"
        step={60}
        aria-label="Time (UTC, 24-hour)"
        className="w-[8.5rem]"
        value={time}
        aria-invalid={invalid}
        onChange={(e) => {
          const iso = joinUtc(date, e.target.value)
          if (iso) onChange(iso)
        }}
      />
      <span className="rounded-xs bg-ink px-2 py-1 text-sm font-bold text-white">UTC</span>
    </div>
  )
}

export function DeadlinesStep() {
  const { composer, errorFor } = useWizard()
  const now = useClientNow(60_000)
  const spec = composer.draft.spec
  const deadline = spec.evidence?.deadline
  const oracle = spec.oracle as OracleParams | undefined
  const chainId = composer.draft.funding?.chainId ?? oracle?.chainId ?? 100
  const chain = CHAINS[chainId]
  const arb = chain?.arbitration
  const tz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'your time zone'

  const setDeadline = (iso: string) => composer.update((d) => ({ ...d, spec: { ...d.spec, evidence: { mechanism: d.spec.evidence?.mechanism ?? 'erc1497-arbitrator-proxy', deadline: iso } } }))
  const setOracle = (patch: Partial<OracleParams>) => composer.update((d) => ({ ...d, spec: { ...d.spec, oracle: { ...(d.spec.oracle as OracleParams), ...patch } } }))

  const local = useMemo(() => {
    if (!deadline || !now) return null
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(deadline))
    } catch {
      return null
    }
  }, [deadline, now])
  const windowMs = deadline && now ? new Date(deadline).getTime() - now.getTime() : undefined

  return (
    <>
      <Field
        id="f-deadline-date"
        label="Evidence deadline"
        hint="Exhibits must be filed on-chain before this moment. Enter it in UTC."
        error={errorFor('spec.evidence.deadline')}
        guidance={
          <>
            <p>
              The deadline is <strong>absolute</strong> and in UTC, so an investigator in any time zone reads the same moment.
            </p>
            <p>It must be at least 24 hours away. Longer windows give investigators more time; nobody has agreed a standard length yet.</p>
            <p>{COPY.deadlineIsNotTradingCutoff}</p>
          </>
        }
      >
        <UtcDateTime idPrefix="f-deadline" value={deadline} onChange={setDeadline} invalid={!!errorFor('spec.evidence.deadline')} />
        {now ? (
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Quick choices">
            {[
              { h: 72, l: '3 days from now' },
              { h: 24 * 7, l: '1 week' },
              { h: 24 * 14, l: '2 weeks' },
              { h: 24 * 30, l: '30 days' },
            ].map((p) => {
              const iso = presetFrom(now, p.h)
              const on = deadline === iso
              return (
                <button
                  key={p.h}
                  type="button"
                  onClick={() => setDeadline(iso)}
                  aria-pressed={on}
                  className={cn('rounded-xs border px-2.5 py-1 text-sm font-bold', on ? 'border-violet bg-violet-wash text-violet' : 'border-rule-strong bg-sheet hover:bg-bond')}
                >
                  {p.l}
                </button>
              )
            })}
          </div>
        ) : null}
        {deadline ? (
          <p className="mt-3 text-[15px]">
            <strong>{formatDate(deadline, 'long')}</strong>
            {local ? (
              <span className="block text-graphite">
                In your time zone ({tz}): {local}
              </span>
            ) : null}
            {windowMs !== undefined && windowMs > 0 ? (
              <span className="block text-graphite">Investigators get about {humanDuration(windowMs)} from now.</span>
            ) : null}
          </p>
        ) : null}
      </Field>

      <div className="grid gap-x-10 gap-y-4 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div id="f-mechanism" tabIndex={-1} className="min-w-0 outline-none">
          <Choices
            name="mechanism"
            legend="Where exhibits are filed"
            value={spec.evidence?.mechanism}
            onChange={(m: EvidenceMechanismId) =>
              composer.update((d) => ({ ...d, spec: { ...d.spec, evidence: { deadline: d.spec.evidence?.deadline ?? deadline ?? '', mechanism: m } } }))
            }
            options={Object.values(EVIDENCE_MECHANISMS).map((m) => ({
              value: m.id,
              label: m.label,
              description: m.description,
              disabled: !isEvidenceMechanismEnabled(m.id),
              aside: !isEvidenceMechanismEnabled(m.id) ? (
                <span className="text-sm font-bold text-plum">{m.launchGate}</span>
              ) : m.launchGate ? (
                <span className="text-sm text-graphite">
                  <strong className="text-ink">Open question:</strong> {m.launchGate}
                </span>
              ) : null,
            }))}
          />
          {errorFor('spec.evidence.mechanism') ? <p className="mt-2 text-sm font-bold text-red">{errorFor('spec.evidence.mechanism')}</p> : null}
        </div>
        <aside>
          <MarginNote title="Exhibits go to Ethereum">
            <p>
              Exhibits are recorded with the Kleros arbitration contract on Ethereum mainnet, even when the market is on Gnosis. The block
              timestamp is the proof of when an exhibit was filed. Filing costs Ethereum gas, paid by the investigator.
            </p>
          </MarginNote>
        </aside>
      </div>

      <div className="space-y-7 border-t border-rule pt-7">
        <h3 className="text-xl">How the question gets answered</h3>
        <Field
          id="f-opening-date"
          label="Oracle opens for answers"
          hint="Usually one hour after the evidence deadline. It cannot be earlier."
          error={errorFor('spec.oracle.openingTime')}
          guidance={<p>Opening after the deadline means nobody answers while exhibits can still arrive. The opening time follows the deadline until you change it.</p>}
        >
          <UtcDateTime idPrefix="f-opening" value={oracle?.openingTime} onChange={(iso) => setOracle({ openingTime: iso })} invalid={!!errorFor('spec.oracle.openingTime')} />
        </Field>

        <Field
          id="f-timeout"
          label="Challenge window after each answer"
          guidance={<p>{COPY.fixedTimeout} If someone posts a new answer, the window starts again.</p>}
        >
          <p id="f-timeout" className="text-lg font-bold">
            {formatTimeout(oracle?.timeoutSeconds ?? 302400)}
          </p>
          <p className="text-sm text-graphite">Fixed by Seer. Not editable.</p>
        </Field>

        <Field
          id="f-minbond"
          label="Minimum bond for the first answer"
          hint={`Paid in ${oracle?.bondToken ?? chain?.nativeSymbol ?? 'the native token'} by whoever answers.`}
          error={errorFor('spec.oracle.minBond')}
          guidance={
            <>
              <p>A bond makes answering costly to fake. Each new answer must at least double the previous bond.</p>
              <p>Higher bonds discourage careless answers but make it more expensive for an honest party to correct a wrong one.</p>
            </>
          }
        >
          <div className="flex items-center gap-2">
            <Input
              id="f-minbond"
              inputMode="decimal"
              className="w-40"
              value={oracle?.minBond ?? ''}
              aria-invalid={!!errorFor('spec.oracle.minBond')}
              onChange={(e) => setOracle({ minBond: e.target.value.trim() })}
            />
            <span className="font-bold">{oracle?.bondToken ?? chain?.nativeSymbol}</span>
          </div>
        </Field>

        <Field
          id="f-arbitrator"
          label="Arbitrator if an answer is disputed"
          guidance={
            <>
              <p>{COPY.arbitrationOnEthereum}</p>
              <p>Whoever requests arbitration pays the fee. It is not part of your spending limit unless you choose to budget for it.</p>
            </>
          }
        >
          <p id="f-arbitrator" className="font-bold">
            {oracle?.arbitratorName ?? chain?.arbitratorName}
          </p>
          {arb ? (
            <p className="text-[15px] text-graphite">
              About {formatAmount(arb.feeEstimate)} {arb.feeCurrency} on Ethereum for {arb.jurors} jurors. A first ruling takes about{' '}
              {arb.typicalRulingDays} days, plus about {arb.typicalAppealDays} days per appeal.
            </p>
          ) : null}
        </Field>
      </div>

      {deadline && oracle?.openingTime ? <Schedule deadline={deadline} opening={oracle.openingTime} timeout={oracle.timeoutSeconds} rulingDays={arb?.typicalRulingDays ?? 14.5} /> : null}
    </>
  )
}

function Schedule({ deadline, opening, timeout, rulingDays }: { deadline: string; opening: string; timeout: number; rulingDays: number }) {
  const earliestFinal = new Date(new Date(opening).getTime() + timeout * 1000).toISOString()
  const withArbitration = new Date(new Date(earliestFinal).getTime() + rulingDays * 86400_000).toISOString()
  const rows = [
    { t: 'Evidence deadline', at: deadline, note: 'Exhibits after this are not timely.' },
    { t: 'Oracle opens', at: opening, note: 'Anyone may post the first answer with a bond.' },
    { t: 'Earliest final answer', at: earliestFinal, note: 'If the first answer comes right away and nobody challenges it.' },
    { t: 'If arbitrated', at: withArbitration, note: 'Roughly, for a first Kleros ruling without appeals.', approx: true },
  ]
  return (
    <div className="border-t-2 border-ink pt-5">
      <h3 className="text-xl">Your claim&rsquo;s expected schedule</h3>
      <p className="mt-1 text-[15px] text-graphite">Planning dates, not promises. Answers and disputes can take longer.</p>
      <ol className="mt-4 border-l-2 border-ink">
        {rows.map((r) => (
          <li key={r.t} className="relative pb-4 pl-5 last:pb-0">
            <span aria-hidden className={cn('absolute top-2 -left-[6px] size-2.5 rounded-full', r.approx ? 'border-2 border-ink bg-sheet' : 'bg-ink')} />
            <p className="font-bold">
              {r.t}: {r.approx ? 'around ' : ''}
              {formatDate(r.at, r.approx ? 'short' : 'long')}
            </p>
            <p className="text-[15px] text-graphite">{r.note}</p>
          </li>
        ))}
      </ol>
    </div>
  )
}
