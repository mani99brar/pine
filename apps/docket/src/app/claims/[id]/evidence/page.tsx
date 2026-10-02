import type { Metadata } from 'next'
import { formatClaimNumber } from '@pine/core'
import { Page } from '@/components/ui/layout'
import { ExhibitFiling } from '@/components/evidence/exhibit-form'
import { serverData, safely } from '@/lib/server-data'

type Params = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params
  const claim = await safely(() => serverData().getClaim(id), null)
  return {
    title: claim ? `File an exhibit for ${formatClaimNumber(claim.number)}` : 'File an exhibit',
    description: 'Submit a reproducible counterexample, rebuttal or clarification. The block timestamp decides whether it is on time.',
    robots: { index: false },
  }
}

export default async function EvidencePage({ params }: Params) {
  const { id } = await params
  const claim = await safely(() => serverData().getClaim(id), null)
  return (
    <Page>
      <ExhibitFiling claimId={id} initial={claim} />
    </Page>
  )
}
