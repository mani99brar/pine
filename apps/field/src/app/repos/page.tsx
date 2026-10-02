import type { Metadata } from 'next'
import { ReposView } from './ReposView'

export const metadata: Metadata = {
  title: 'Repositories',
  description: 'Browse public repositories, pull requests and commits, and put an exact commit on the board.',
}

export default function ReposPage() {
  return <ReposView />
}
