'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { formatDate } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { useDrafts } from '@pine/react'
import { BookOpenCheck, Check, FilePlus2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/layout'
import { MarginNote } from '@/components/ui/field'
import { WIZARD_STEPS } from '@/lib/wizard'
import { WORKED_EXAMPLE_REF, workedExampleDraft } from '@/lib/example'

const HAVE_READY = [
  'A link to the pull request or commit, in a public GitHub repository.',
  'The one behavior you want tested, in a sentence.',
  'How to reproduce it: runtime version, lockfile and a test command.',
  'A deadline at least 24 hours away.',
  'A wallet with collateral for liquidity (sDAI on Gnosis) and a little xDAI for gas.',
]

export function FilingStart() {
  const sp = useSearchParams()
  const router = useRouter()
  const { drafts, create, isLoading } = useDrafts()
  const [busy, setBusy] = useState<'new' | 'example' | null>(null)
  const ref = sp.get('ref')
  const started = useRef(false)

  // Coming from "File for this commit": create a draft and go straight to the source step.
  useEffect(() => {
    if (!ref || started.current) return
    started.current = true
    const d = create()
    router.replace(`/file/${encodeURIComponent(d.id)}?step=source&ref=${encodeURIComponent(ref)}`)
  }, [ref, create, router])

  if (ref) {
    return (
      <p className="flex items-center gap-2 text-lg" role="status">
        <Loader2 aria-hidden className="size-5 motion-safe:animate-spin" /> Opening a new filing for {ref}
      </p>
    )
  }

  const unfinished = drafts.filter((d) => !d.publication?.steps?.every((s) => s.status === 'confirmed')).slice(0, 3)

  return (
    <>
      <PageHeader
        title="File a verification"
        lead="Eight steps, with guidance beside every field. Your draft saves automatically, so you can stop and come back."
      />
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-10">
          <section aria-labelledby="ready-title" className="border border-rule bg-sheet p-6 sm:p-8">
            <h2 id="ready-title" className="text-2xl">
              Have these ready
            </h2>
            <ul className="mt-4 divide-y divide-rule">
              {HAVE_READY.map((t) => (
                <li key={t} className="flex gap-3 py-3">
                  <Check aria-hidden className="mt-1 size-5 shrink-0 text-violet" strokeWidth={2.75} />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button
                size="lg"
                icon={busy === 'new' ? <Loader2 aria-hidden className="motion-safe:animate-spin" /> : <FilePlus2 aria-hidden />}
                onClick={() => {
                  setBusy('new')
                  const d = create()
                  router.push(`/file/${encodeURIComponent(d.id)}?step=source`)
                }}
              >
                Start a new filing
              </Button>
              <Button
                size="lg"
                variant="secondary"
                icon={busy === 'example' ? <Loader2 aria-hidden className="motion-safe:animate-spin" /> : <BookOpenCheck aria-hidden />}
                onClick={() => {
                  setBusy('example')
                  const d = create(workedExampleDraft())
                  router.push(`/file/${encodeURIComponent(d.id)}?step=source&ref=${encodeURIComponent(WORKED_EXAMPLE_REF)}`)
                }}
              >
                Start from the worked example
              </Button>
            </div>
            <p className="mt-3 text-sm text-graphite">
              The worked example fills in the keeper-bot claim from the Pine specification, so you can see what a complete filing looks like.
            </p>
          </section>

          <section aria-labelledby="steps-title">
            <h2 id="steps-title" className="text-2xl">
              The steps
            </h2>
            <ol className="mt-4 grid gap-x-8 sm:grid-cols-2">
              {WIZARD_STEPS.map((s, i) => (
                <li key={s.id} className="flex gap-3 border-b border-rule py-3">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-[13px] font-[800] text-white tabular">
                    {i + 1}
                  </span>
                  <span>
                    <span className="block font-bold">{s.title}</span>
                    <span className="text-[15px] text-graphite">{s.purpose}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="space-y-8">
          <div>
            <h2 className="text-lg font-bold">Continue a draft</h2>
            {isLoading ? (
              <p className="mt-2 text-graphite">Looking for drafts</p>
            ) : unfinished.length === 0 ? (
              <p className="mt-2 text-[15px] text-graphite">No drafts yet. They appear here as soon as you start.</p>
            ) : (
              <ul className="mt-2 divide-y divide-rule border-y border-rule">
                {unfinished.map((d) => (
                  <li key={d.id} className="py-2.5">
                    <Link href={`/file/${encodeURIComponent(d.id)}?step=${d.stage}`} className="link font-bold">
                      <span className="untrusted">{d.spec.title?.trim() || 'Untitled filing'}</span>
                    </Link>
                    <span className="block text-sm text-graphite">
                      At {WIZARD_STEPS.find((w) => w.stage === d.stage)?.title ?? d.stage}, saved {formatDate(d.updatedAt, 'short')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/filings" className="link mt-3 inline-block text-[15px]">
              All drafts and filings
            </Link>
          </div>
          <MarginNote title="What filing is not">
            <p>{COPY.notAReview}</p>
            <p>{COPY.noMergeAuthority}</p>
          </MarginNote>
          <MarginNote title="Read first, if you are new">
            <p>
              <Link href="/how-it-works" className="link">How it works</Link> explains oracles, bonds and outcome tokens in plain words.{' '}
              <Link href="/risks" className="link">Risks and launch gates</Link> lists what is still unresolved.
            </p>
          </MarginNote>
        </aside>
      </div>
    </>
  )
}
