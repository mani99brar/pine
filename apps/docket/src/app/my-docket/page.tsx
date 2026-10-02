import type { Metadata } from 'next'
import { FilePlus2 } from 'lucide-react'
import { Page, PageHeader } from '@/components/ui/layout'
import { ButtonLink } from '@/components/ui/button'
import { MyDocket } from '@/components/dashboard/my-docket'
import { ClientOnly } from '@/components/ui/client-only'
import { ViewSkeleton } from '@/components/ui/view-skeleton'

export const metadata: Metadata = {
  title: 'My docket',
  description: 'Your claims, what needs your attention, upcoming deadlines, positions, liquidity and redemptions.',
  robots: { index: false },
}

export default function MyDocketPage() {
  return (
    <Page>
      <PageHeader
        title="My docket"
        lead="Your claims and positions, with whatever needs you first."
        actions={
          <ButtonLink href="/file" icon={<FilePlus2 aria-hidden />}>
            File a verification
          </ButtonLink>
        }
      />
      <ClientOnly fallback={<ViewSkeleton />}>
        <MyDocket />
      </ClientOnly>
    </Page>
  )
}
