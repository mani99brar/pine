'use client'

import { useEffect } from 'react'
import { RotateCw } from 'lucide-react'
import { Button, ButtonLink } from '@/components/ui/Button'

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])
  return (
    <div className="mx-auto max-w-[1320px] px-4 py-20 sm:px-6" role="alert">
      <div aria-hidden className="flex h-8 max-w-[28rem] items-center">
        <span className="h-8 w-[3px] bg-ink" />
        <span className="h-4 flex-1 border-[1.5px] border-dashed border-ink-3" />
        <span className="h-8 w-[3px] bg-ink" />
      </div>
      <h1 className="t-h1 mt-8">This part of the field failed to load</h1>
      <p className="mt-3 max-w-[60ch] text-ink-2">
        Something went wrong while rendering this page. Your drafts and any publication progress are saved in this browser, so nothing is lost by retrying.
      </p>
      {error.digest && <p className="mt-2 text-[0.84rem] text-ink-3">Reference: <code className="t-code">{error.digest}</code></p>}
      <div className="mt-8 flex flex-wrap gap-3">
        <Button onClick={reset} icon={<RotateCw size={15} aria-hidden />}>
          Try again
        </Button>
        <ButtonLink href="/board" variant="secondary">
          Back to the board
        </ButtonLink>
      </div>
    </div>
  )
}
