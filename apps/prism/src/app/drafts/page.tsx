import type { Metadata } from 'next'
import { DraftsView } from './DraftsView'
import { Container, PageHeader } from '@/components/ui/primitives'

export const metadata: Metadata = {
  title: 'Drafts',
  description: 'Claims you are still cutting, and publications you can resume from the step where they stopped.',
  robots: { index: false },
}

export default function DraftsPage() {
  return (
    <Container>
      <PageHeader title="Drafts" lead="Claims you are still cutting, and publications you can resume from the step where they stopped." />
      <DraftsView />
    </Container>
  )
}
