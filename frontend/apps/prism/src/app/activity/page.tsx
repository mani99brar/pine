import type { Metadata } from 'next'
import { ActivityView } from './ActivityView'
import { Container, PageHeader } from '@/components/ui/primitives'

export const metadata: Metadata = {
  title: 'Activity ledger',
  description: 'Every funding step, trade, evidence filing, oracle action and redemption, reconciled against indexed totals.',
}

export default function ActivityPage() {
  return (
    <Container>
      <PageHeader title="Activity ledger" lead="Every funding step, trade, filing, oracle action and redemption, reconciled against what the indexer reports." />
      <ActivityView />
    </Container>
  )
}
