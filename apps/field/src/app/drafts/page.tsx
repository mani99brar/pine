import type { Metadata } from 'next'
import { DraftsView } from './DraftsView'

export const metadata: Metadata = {
  title: 'Drafts and publications',
  description: 'Claim drafts and publications that stopped part-way, ready to resume.',
  robots: { index: false },
}

export default function DraftsPage() {
  return <DraftsView />
}
