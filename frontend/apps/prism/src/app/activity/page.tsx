import type { Metadata } from 'next'
import { readPineEnv } from '@pine/data'
import { ActivityView } from './ActivityView'
import { Container, PageHeader } from '@/components/ui/primitives'

export const metadata: Metadata = {
  title: 'Activity ledger',
  description: 'Every funding step, trade, evidence filing, oracle action and redemption, reconciled against indexed totals.',
}

export default function ActivityPage() {
  // `api` mode: the backend lists each wallet's published claims and recorded evidence, with no amounts to reconcile.
  const backend = readPineEnv().dataSource === 'api'
  return (
    <Container>
      <PageHeader
        title="Activity ledger"
        lead={
          backend
            ? 'The claims a wallet published and the evidence it recorded, as Pine indexed them.'
            : 'Every funding step, trade, filing, oracle action and redemption, reconciled against what the indexer reports.'
        }
      />
      <ActivityView />
    </Container>
  )
}
