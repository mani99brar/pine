import type { Metadata } from 'next'
import { ButtonLink } from '@/components/ui/Button'

export const metadata: Metadata = { title: 'Not found', robots: { index: false } }

/** 404: the rope has snapped. Two anchored halves, no knot. */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-[1320px] px-4 py-20 sm:px-6">
      <div aria-hidden className="flex h-10 max-w-[34rem] items-center">
        <span className="h-10 w-[3px] bg-ink" />
        <span className="hatch-yes h-5 w-[38%]" />
        <span className="h-5 w-[3px] -rotate-12 bg-ink" />
        <span className="flex-1" />
        <span className="h-5 w-[3px] rotate-12 bg-ink" />
        <span className="h-5 w-[38%] bg-cobalt" />
        <span className="h-10 w-[3px] bg-ink" />
      </div>
      <p className="t-figure mt-10 text-[1.1rem] text-ink-3">404</p>
      <h1 className="t-display-l mt-2 max-w-[16ch]">This page is off the field.</h1>
      <p className="mt-4 max-w-[56ch] text-[1.05rem] text-ink-2">
        The address does not match a claim, policy or page. Claim ids look like <code className="t-code rounded-[3px] bg-fog-2 px-1">pine-0009</code>; published claims never move.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <ButtonLink href="/board">Browse open claims</ButtonLink>
        <ButtonLink href="/" variant="secondary">
          Go to the start
        </ButtonLink>
      </div>
    </div>
  )
}
