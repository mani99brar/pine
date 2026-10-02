import type { Metadata } from 'next'
import { Drafts } from '@/components/pages/drafts'

export const metadata: Metadata = { title: 'Drafts', description: 'Autosaved drafts and publications in progress, with recovery for partially published claims.' }

export default function DraftsPage() {
  return <Drafts />
}
