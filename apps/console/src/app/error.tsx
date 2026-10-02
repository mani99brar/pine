'use client'

import * as React from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    console.error(error)
  }, [error])
  return (
    <div className="bg-surface px-4 py-16 sm:px-8" role="alert">
      <div className="mx-auto max-w-[640px]">
        <p className="mono-cond text-[12px] text-flare">error{error.digest ? ` ${error.digest}` : ''}</p>
        <h1 className="stretch-display mt-1 text-[28px] font-[750] leading-tight">This view stopped rendering</h1>
        <p className="mt-3 text-[15px] leading-[1.6] text-muted">
          {error.message || 'An unexpected error occurred.'} Your drafts and any in-progress publication are saved in this browser, and nothing
          on-chain was changed by this error.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => reset()}>
            Try again
          </Button>
          <Button asChild variant="secondary">
            <Link href="/drafts">Open drafts</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/">Console home</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
