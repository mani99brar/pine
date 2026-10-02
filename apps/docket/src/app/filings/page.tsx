import type { Metadata } from 'next'
import { FilePlus2 } from 'lucide-react'
import { Page, PageHeader } from '@/components/ui/layout'
import { ButtonLink } from '@/components/ui/button'
import { FilingsView } from '@/components/filings/filings-view'
import { ClientOnly } from '@/components/ui/client-only'
import { ViewSkeleton } from '@/components/ui/view-skeleton'

export const metadata: Metadata = {
  title: 'Drafts and filings',
  description: 'Drafts you are writing and filings that started but did not finish.',
  robots: { index: false },
}

export default function FilingsPage() {
  return (
    <Page>
      <PageHeader
        title="Drafts and filings"
        crumbs={[{ href: '/my-docket', label: 'My docket' }, { label: 'Drafts and filings' }]}
        lead="Drafts save automatically in this browser. A filing that stopped partway can be finished from the first unconfirmed step."
        actions={
          <ButtonLink href="/file" icon={<FilePlus2 aria-hidden />}>
            File a verification
          </ButtonLink>
        }
      />
      <ClientOnly fallback={<ViewSkeleton />}>
        <FilingsView />
      </ClientOnly>
    </Page>
  )
}
