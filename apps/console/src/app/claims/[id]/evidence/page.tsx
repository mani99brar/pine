import { redirect } from 'next/navigation'

/** Agent briefs link here as the evidence submission URL; the console's form lives at /evidence/new. */
export default async function EvidenceIndex({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/claims/${encodeURIComponent(id)}/evidence/new`)
}
