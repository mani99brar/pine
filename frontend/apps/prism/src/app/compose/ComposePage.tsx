'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newDraftId } from '@pine/react'
import { Composer } from '@/components/composer/Composer'
import { Skeleton } from '@/components/ui/primitives'
import { useMounted } from '@/lib/hooks'

/**
 * Every composer session has a draft id in the URL, so a reload (or a link from Drafts) resumes it.
 * `?source=` prefills the GitHub input, `?from=<claimId>` copies a claim's terms, `?policy=` preselects.
 */
export function ComposePage() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const mounted = useMounted()
  const draftId = params.get('draft') ?? undefined
  // The id being put into the URL: a re-run effect (React StrictMode) reuses it instead of racing a second draft id;
  // once the URL carries a draft, the next visit without one gets a new id.
  const pending = useRef<string | null>(null)

  useEffect(() => {
    if (draftId) {
      pending.current = null
      return
    }
    pending.current ??= newDraftId()
    const next = new URLSearchParams(params.toString())
    next.delete('new')
    next.set('draft', pending.current)
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }, [draftId, params, pathname, router])

  if (!mounted || !draftId) {
    return (
      <div className="mx-auto max-w-[1320px] px-4 py-12 sm:px-6 lg:px-8" aria-busy>
        <span className="sr-only">Opening a new draft</span>
        <Skeleton className="h-10 w-72" />
        <Skeleton className="mt-6 h-8 w-full" />
        <Skeleton className="mt-10 h-72 w-full" />
      </div>
    )
  }
  return <Composer key={draftId} draftId={draftId} initialInput={params.get('source') ?? undefined} fromClaimId={params.get('from') ?? undefined} initialPolicy={params.get('policy') ?? undefined} />
}
