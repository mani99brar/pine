import type { Metadata } from 'next'
import { Suspense } from 'react'
import { LightTable } from '@/components/table/LightTable'
import { Container, PageHeader, Skeleton } from '@/components/ui/primitives'

export const metadata: Metadata = {
  title: 'Light table',
  description: 'Every published claim as a crystal around the present moment: Yes price, liquidity, policy family and time left in the evidence window. Filter, search and sort, or use the list.',
  alternates: { canonical: '/claims', types: { 'application/json': '/api/agent/v1/claims' } },
}

export default function ClaimsPage() {
  return (
    <Container wide>
      <PageHeader
        title="Light table"
        lead="Every published claim, placed around the present moment. Crystals right of the slit are still open for evidence; those to the left are with the oracle or resolved."
      />
      <Suspense fallback={<Skeleton className="h-[28rem] w-full" />}>
        <LightTable />
      </Suspense>
    </Container>
  )
}
