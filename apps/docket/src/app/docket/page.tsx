import type { Metadata } from 'next'
import { Suspense } from 'react'
import { FilePlus2 } from 'lucide-react'
import { Page, PageHeader } from '@/components/ui/layout'
import { ButtonLink } from '@/components/ui/button'
import { DocketBrowser, DocketSkeleton } from '@/components/docket/docket-browser'

export const metadata: Metadata = {
  title: 'Docket',
  description: 'Every claim on file, grouped by procedural stage: closing soon, awaiting an oracle answer, disputed, decided.',
  alternates: { canonical: '/docket', types: { 'application/json': '/api/agent/v1/claims' } },
  openGraph: { title: 'The Pine docket', description: 'Open claims about exact commits, grouped by procedural stage.', url: '/docket' },
}

export default function DocketPage() {
  return (
    <Page>
      <PageHeader
        title="The docket"
        lead="Every claim on file, grouped by where it stands in the procedure. Claims that need someone to act come first."
        actions={
          <ButtonLink href="/file" icon={<FilePlus2 aria-hidden />}>
            File a verification
          </ButtonLink>
        }
      />
      <Suspense fallback={<DocketSkeleton />}>
        <DocketBrowser />
      </Suspense>
    </Page>
  )
}
