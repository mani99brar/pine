import type { Metadata } from 'next'
import { Suspense } from 'react'
import { readPineEnv } from '@pine/data'
import { LightTable } from '@/components/table/LightTable'
import { Container, PageHeader, Skeleton } from '@/components/ui/primitives'

export function generateMetadata(): Metadata {
  // `api` mode: the machine-readable claim list is the backend's agent feed.
  const json = readPineEnv().dataSource === 'api' ? '/api/v1/agents/claims' : '/api/agent/v1/claims'
  return {
    title: 'Light table',
    description: 'Every published claim as a crystal around the present moment: Yes price, liquidity, policy family and time left in the evidence window. Filter, search and sort, or use the list.',
    alternates: { canonical: '/claims', types: { 'application/json': json } },
  }
}

export default function ClaimsPage() {
  return (
    <Container wide>
      <PageHeader
        className="pb-6 pt-8 sm:pt-10"
        title="Light table"
        lead="Every published claim, placed around the present moment. Right of the slit the evidence window is still open; left of it, the oracle is answering or the claim is resolved."
      />
      <Suspense fallback={<Skeleton className="h-[28rem] w-full" />}>
        <LightTable />
      </Suspense>
    </Container>
  )
}
