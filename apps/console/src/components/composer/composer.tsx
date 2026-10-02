'use client'

import * as React from 'react'
import Link from 'next/link'
import { PanelBottomOpen, Snowflake } from 'lucide-react'
import { COPY } from '@pine/core/copy'
import { getPolicy } from '@pine/core'
import { useClaimComposer, usePublishClaim } from '@pine/react'
import { cn } from '@/lib/cn'
import { useKeys } from '@/lib/use-keys'
import { useIsClient } from '@/lib/hooks'
import { Callout } from '@/components/ui/callout'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { ComposerProvider, SECTIONS, fieldId, sectionForPath, useComposerCtx, type SectionId } from './context'
import { Gutter, fieldTicks } from './gutter'
import { SourceSection } from './source-section'
import { ClaimSection, PolicySection } from './policy-claim-sections'
import { DeadlinesSection, EnvironmentSection } from './env-deadline-sections'
import { FundingSection, ReviewSection } from './funding-review-sections'
import { ArtifactsPane } from './artifacts-pane'

/** Drafts carry generated ids and time-based defaults, so the composer renders on the client only. */
export function Composer(props: { draftId?: string; source?: string; policy?: string }) {
  const isClient = useIsClient()
  if (!isClient) return <ComposerSkeleton />
  return <ComposerLoaded {...props} />
}

function ComposerLoaded({ draftId, source, policy }: { draftId?: string; source?: string; policy?: string }) {
  const c = useClaimComposer(draftId)
  if (c.isLoading) return <ComposerSkeleton />
  return (
    <ComposerProvider c={c}>
      <ComposerBody urlDraftId={draftId} initialSource={source} initialPolicy={policy} />
    </ComposerProvider>
  )
}

function ComposerBody({ urlDraftId, initialSource, initialPolicy }: { urlDraftId?: string; initialSource?: string; initialPolicy?: string }) {
  const { c, touch, updateSpec } = useComposerCtx()

  // ?policy=BOT-001 (from a policy page) preselects an enabled policy once.
  const policyApplied = React.useRef(false)
  React.useEffect(() => {
    if (policyApplied.current || !initialPolicy || c.draft.spec.policyId) return
    policyApplied.current = true
    const p = getPolicy(initialPolicy.toUpperCase())
    if (p && p.status === 'enabled') updateSpec((s) => ({ ...s, policyId: p.id, policyVersion: p.version }))
  }, [initialPolicy, c.draft.spec.policyId, updateSpec])
  const publish = usePublishClaim(c.draft.id)
  const [active, setActive] = React.useState<SectionId>('source')
  const [sheet, setSheet] = React.useState(false)

  // Make the URL resumable as soon as the draft exists in storage.
  React.useEffect(() => {
    if (!urlDraftId && c.lastSavedAt) window.history.replaceState(null, '', `/new?draft=${encodeURIComponent(c.draft.id)}`)
  }, [urlDraftId, c.lastSavedAt, c.draft.id])

  // Track the section in view for the gutter and the draft's stage.
  React.useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-section]'))
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        const id = visible[0]?.target.getAttribute('data-section') as SectionId | undefined
        if (id) setActive(id)
      },
      { rootMargin: '-20% 0px -65% 0px' },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])

  const { setStage } = c
  React.useEffect(() => {
    const stage = SECTIONS.find((s) => s.id === active)?.stage
    if (stage && stage !== c.draft.stage) setStage(stage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const jump = React.useCallback((id: SectionId) => {
    document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActive(id)
  }, [])

  const focusProblem = React.useCallback(
    (path: string) => {
      setSheet(false)
      touch(path)
      const parts = path.split('.')
      let el: HTMLElement | null = null
      for (let n = parts.length; n > 0 && !el; n--) el = document.getElementById(fieldId(parts.slice(0, n).join('.')))
      if (!el) el = document.getElementById(`sec-${sectionForPath(path)}`)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      const focusable = el.matches('input,textarea,select,button') ? el : el.querySelector<HTMLElement>('input,textarea,select,button')
      window.setTimeout(() => focusable?.focus({ preventScroll: true }), 350)
    },
    [touch],
  )

  const idx = SECTIONS.findIndex((s) => s.id === active)
  useKeys({
    'mod+Enter': (e) => {
      e.preventDefault()
      jump('review')
    },
    ']': () => jump(SECTIONS[Math.min(SECTIONS.length - 1, idx + 1)]!.id),
    '[': () => jump(SECTIONS[Math.max(0, idx - 1)]!.id),
    a: () => setSheet((s) => !s),
  })

  const ticks = fieldTicks(c.draft)
  const all = Object.values(ticks).flat()
  const doneCount = all.filter((t) => t.done).length
  const issues = c.validation.issues.length
  const started = publish.steps.some((s) => s.status !== 'idle')

  return (
    <div className="lg:grid lg:grid-cols-[48px_minmax(0,1fr)_minmax(360px,44%)] xl:grid-cols-[180px_minmax(0,1fr)_minmax(420px,42%)]">
      <aside className="sticky top-12 hidden h-[calc(100dvh-48px-28px)] self-start overflow-y-auto border-r border-line bg-frost lg:block">
        <div className="hidden xl:block">
          <Gutter active={active} onJump={jump} wide />
        </div>
        <div className="xl:hidden">
          <Gutter active={active} onJump={jump} />
        </div>
      </aside>

      <div className="min-w-0 bg-surface">
        <div className="border-b border-line px-4 pb-5 pt-6 sm:px-8">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="stretch-display text-[28px] font-[750] leading-none tracking-[-0.01em] sm:text-[34px]">
              New verification
            </h1>
            <span className="mono-cond text-[11.5px] text-muted">draft {c.draft.id.slice(0, 12)}</span>
          </div>
          <p className="mt-2 max-w-[68ch] text-[14px] leading-[1.55] text-muted">
            One commit, one bounded requirement, one absolute deadline. The right-hand pane shows exactly what will be published as you type.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
            <span className="tnum">
              {doneCount}/{all.length} fields
            </span>
            <span className={cn('tnum', issues ? 'text-flare' : 'text-needle')}>{issues ? `${issues} problems` : 'no problems'}</span>
            <span className="hidden items-center gap-1 sm:flex">
              <Kbd>[</Kbd>
              <Kbd>]</Kbd> sections
            </span>
            <span className="hidden items-center gap-1 sm:flex">
              <Kbd>⌘↵</Kbd> review
            </span>
            <Link href="/drafts" className="ml-auto text-needle hover:underline">
              All drafts
            </Link>
          </div>
          {c.frozen ? (
            <Callout tone="frozen" className="mt-3" title="Market created: terms are frozen">
              {COPY.frozenTerms}
            </Callout>
          ) : started ? (
            <Callout tone="warning" className="mt-3" title="Publishing in progress">
              Steps already confirmed stay on-chain. Resume from the Review section or the Publish log.
            </Callout>
          ) : null}
        </div>

        {/* Mobile progress rule */}
        <div className="sticky top-12 z-20 border-b border-line bg-surface/95 px-4 py-2 backdrop-blur lg:hidden">
          <div className="flex items-center gap-1">
            {SECTIONS.map((s) => {
              const n = c.validation.issues.filter((x) => sectionForPath(x.path) === s.id).length
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => jump(s.id)}
                  aria-label={s.label}
                  className={cn('h-1.5 flex-1 rounded-full', active === s.id ? 'bg-resin-fill' : n ? 'bg-line-strong' : 'bg-bark')}
                />
              )
            })}
          </div>
          <p className="mt-1 text-[11.5px] text-muted">
            {idx + 1}/{SECTIONS.length} {SECTIONS[idx]?.label}
          </p>
        </div>

        <SourceSection initialInput={initialSource} />
        <PolicySection />
        <ClaimSection />
        <EnvironmentSection />
        <DeadlinesSection />
        <FundingSection />
        <ReviewSection publish={publish} onFocusProblem={focusProblem} />
        <div className="h-24 lg:h-8" />
      </div>

      <aside className="sticky top-12 hidden h-[calc(100dvh-48px-28px)] self-start border-l border-line lg:flex" aria-label="Live artifacts">
        <ArtifactsPane publish={publish} onFocusProblem={focusProblem} className="w-full" />
      </aside>

      {/* Mobile: sticky artifacts toggle above the bottom nav */}
      <div className="fixed inset-x-0 bottom-14 z-30 border-t border-line bg-raised/95 px-3 py-2 backdrop-blur lg:hidden">
        <button type="button" onClick={() => setSheet(true)} className="flex w-full items-center gap-2 text-left text-[13px]" aria-haspopup="dialog">
          <PanelBottomOpen size={16} aria-hidden className="text-needle" />
          <span className="font-medium">Artifacts</span>
          <span className="mono-cond truncate text-[11px] text-muted">{c.manifestHash ? `manifest ${c.manifestHash.slice(0, 8)}…` : 'manifest pending'}</span>
          <span className={cn('tnum ml-auto shrink-0 rounded-full px-2 text-[11.5px]', issues ? 'bg-flare-soft text-flare' : 'bg-needle-soft text-needle')}>
            {issues} problems
          </span>
          {c.frozen ? <Snowflake size={14} aria-label="frozen" className="text-slate" /> : null}
        </button>
      </div>
      <Dialog open={sheet} onOpenChange={setSheet}>
        <DialogContent title="Live artifacts" side="bottom" className="h-[85vh]">
          <ArtifactsPane publish={publish} onFocusProblem={focusProblem} className="h-full" />
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ComposerSkeleton() {
  return (
    <div className="lg:grid lg:grid-cols-[180px_minmax(0,1fr)_42%]" role="status" aria-label="Loading draft">
      <div className="hidden border-r border-line lg:block" />
      <div className="space-y-4 bg-surface p-8">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-[70%]" />
        <Skeleton className="mt-8 h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
      <div className="hidden space-y-3 border-l border-line p-4 lg:block">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  )
}

