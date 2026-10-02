import type { Metadata } from 'next'
import { EvidenceNew } from '@/components/pages/evidence-new'

type Props = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  return { title: `Submit evidence for ${id.toUpperCase()}`, robots: { index: false } }
}

export default async function SubmitEvidencePage({ params }: Props) {
  const { id } = await params
  return <EvidenceNew claimId={id} />
}
