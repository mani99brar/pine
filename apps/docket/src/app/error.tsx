'use client'

import { useEffect } from 'react'
import { Button, ButtonLink } from '@/components/ui/button'

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])
  return (
    <main id="main" className="mx-auto w-full max-w-[60rem] px-4 py-16 sm:px-6 lg:py-24">
      <div className="border-l-8 border-red bg-sheet px-6 py-6">
        <p className="text-sm font-bold text-red">Something failed while loading this page</p>
        <h1 className="mt-1 text-3xl">This page could not be shown</h1>
        <p className="mt-3 max-w-[56ch] text-lg text-graphite">
          The data source did not respond as expected. Nothing you filed or signed is affected: drafts stay in this browser and on-chain records stay on-chain.
        </p>
        {error.digest ? <p className="mt-2 text-sm text-graphite">Reference {error.digest}</p> : null}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => retry()}>Try again</Button>
          <ButtonLink href="/docket" variant="secondary">
            Go to the docket
          </ButtonLink>
        </div>
      </div>
    </main>
  )
}
