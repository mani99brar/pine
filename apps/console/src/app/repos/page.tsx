import type { Metadata } from 'next'
import { ReposIndex } from '@/components/pages/repos'

export const metadata: Metadata = { title: 'Repositories', description: 'Browse public repositories, pull requests and commits, then verify an exact commit.' }

export default function ReposPage() {
  return <ReposIndex />
}
