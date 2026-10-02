import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Page, Skeleton } from '@/components/ui/layout'
import { FilingWizard } from '@/components/wizard/wizard'
import { ClientOnly } from '@/components/ui/client-only'

export const metadata: Metadata = {
  title: 'File a verification',
  description: 'A guided filing: pin a commit, choose a policy, state one bounded claim, set the deadline and fund the market.',
  robots: { index: false },
}

export default async function FilingPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params
  return (
    <Page>
      <Suspense
        fallback={
          <div className="space-y-4" aria-busy="true">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-96 w-full" />
          </div>
        }
      >
        <ClientOnly fallback={<Skeleton className="h-96 w-full" />}>
          <FilingWizard draftId={decodeURIComponent(draftId)} />
        </ClientOnly>
      </Suspense>
    </Page>
  )
}
