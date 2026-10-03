import type { Metadata } from 'next'
import { DashboardView } from './DashboardView'
import { Container, PageHeader } from '@/components/ui/primitives'

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Your claims, outcome positions, liquidity positions, redemptions and anything waiting on you.',
  robots: { index: false },
}

export default function DashboardPage() {
  return (
    <Container>
      <PageHeader title="Dashboard" lead="Your claims, positions and liquidity, and anything waiting on you." />
      <DashboardView />
    </Container>
  )
}
