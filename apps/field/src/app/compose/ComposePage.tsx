'use client'

import { useEffect } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newDraftId } from '@pine/react'
import { Composer } from '@/components/composer/Composer'
import { useMounted } from '@/lib/mounted'

/**
 * Every composer session has a draft id in the URL, so a reload (or a link from Drafts) resumes it.
 * Visiting /compose without one starts a fresh draft. `?source=` prefills the GitHub input and
 * `?from=<claimId>` copies an existing claim's terms.
 */
export function ComposePage() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const mounted = useMounted()
  const draftId = params?.get('draft') ?? undefined

  useEffect(() => {
    if (draftId) return
    const next = new URLSearchParams(params?.toString() ?? '')
    next.delete('new')
    next.set('draft', newDraftId())
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }, [draftId, params, pathname, router])

  if (!mounted || !draftId) {
    return (
      <div className="mx-auto max-w-[1320px] px-4 py-10 sm:px-6" aria-busy>
        <span className="sr-only">Opening a new draft</span>
        <span className="skeleton block h-8 w-72" />
        <span className="skeleton mt-6 block h-6 w-full" />
        <span className="skeleton mt-10 block h-64 w-full" />
      </div>
    )
  }
  return <Composer key={draftId} draftId={draftId} initialInput={params?.get('source') ?? undefined} fromClaimId={params?.get('from') ?? undefined} initialPolicy={params?.get('policy') ?? undefined} />
}
