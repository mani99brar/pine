import type { Metadata } from 'next'
import { EvidenceForm } from './EvidenceForm'
import { Container } from '@/components/ui/primitives'
import { claimLabel } from '@/lib/claims'
import { getClaimServer } from '@/lib/server/data'

type Params = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params
  const claim = await getClaimServer(id)
  return {
    title: claim ? `Submit evidence: ${claimLabel(claim)}` : 'Submit evidence',
    description: 'File reproducible evidence before the evidence deadline, published directly or as a sealed commitment revealed later.',
    robots: { index: false },
  }
}

export default async function EvidencePage({ params }: Params) {
  const { id } = await params
  return (
    <Container>
      <EvidenceForm id={id} />
    </Container>
  )
}
