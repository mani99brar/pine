import type { Metadata } from 'next'
import { formatClaimNumber } from '@pine/core'
import { EvidenceForm } from './EvidenceForm'
import { getClaimServer } from '@/lib/server/data'

type Params = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params
  const claim = await getClaimServer(id)
  return {
    title: claim ? `Submit evidence: ${formatClaimNumber(claim.number)}` : 'Submit evidence',
    description: 'Submit a reproducible counterexample, rebuttal or clarification on-chain before the evidence deadline.',
    robots: { index: false },
  }
}

export default async function EvidencePage({ params }: Params) {
  const { id } = await params
  return <EvidenceForm id={id} />
}
