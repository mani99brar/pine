import type { Metadata } from 'next'
import { Page, PageHeader } from '@/components/ui/layout'
import { Ledger } from '@/components/activity/ledger'
import { ClientOnly } from '@/components/ui/client-only'
import { ViewSkeleton } from '@/components/ui/view-skeleton'

export const metadata: Metadata = {
  title: 'Activity ledger',
  description: 'Every deposit, fee, withdrawal, trade and redemption, with a reconciliation of where your money is.',
  robots: { index: false },
}

export default function ActivityPage() {
  return (
    <Page>
      <PageHeader
        title="Activity ledger"
        crumbs={[{ href: '/my-docket', label: 'My docket' }, { label: 'Activity ledger' }]}
        lead="Every transaction, with a reconciliation of what you put in, what you paid, what came back and what you still hold."
      />
      <ClientOnly fallback={<ViewSkeleton />}>
        <Ledger />
      </ClientOnly>
    </Page>
  )
}
