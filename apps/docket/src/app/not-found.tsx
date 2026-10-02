import Link from 'next/link'
import type { Metadata } from 'next'
import { ButtonLink } from '@/components/ui/button'

export const metadata: Metadata = { title: 'Page not found' }

export default function NotFound() {
  return (
    <main id="main" className="mx-auto w-full max-w-[60rem] px-4 py-16 sm:px-6 lg:py-24">
      <p className="text-sm font-bold text-graphite">Not on the docket</p>
      <h1 className="mt-2 text-3xl">There is no page at this address</h1>
      <p className="mt-3 max-w-[52ch] text-lg text-graphite">
        The link may be mistyped, or the page may have moved. If you were looking for a claim, search the docket by number, repository or commit.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <ButtonLink href="/docket">Search the docket</ButtonLink>
        <ButtonLink href="/" variant="secondary">
          Go to the home page
        </ButtonLink>
      </div>
      <p className="mt-10 text-[15px] text-graphite">
        Filing something? <Link href="/file" className="link">Start a new filing</Link> or <Link href="/filings" className="link">continue a draft</Link>.
      </p>
    </main>
  )
}
