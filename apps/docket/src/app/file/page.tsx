import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Page, Skeleton } from '@/components/ui/layout'
import { FilingStart } from '@/components/wizard/filing-start'

export const metadata: Metadata = {
  title: 'File a verification',
  description: 'What you need before filing a claim about a commit, and how long it takes.',
  alternates: { canonical: '/file' },
}

export default function FilePage() {
  return (
    <Page>
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <FilingStart />
      </Suspense>
    </Page>
  )
}
