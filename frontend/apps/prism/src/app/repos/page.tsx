import type { Metadata } from 'next'
import { ReposView } from './ReposView'
import { Container, PageHeader } from '@/components/ui/primitives'

export const metadata: Metadata = {
  title: 'Repositories',
  description: 'Pick a public repository, then a pull request and the exact commit to put a claim on.',
}

export default function ReposPage() {
  return (
    <Container>
      <PageHeader title="Repositories" lead="Pick a repository, then a pull request and the exact commit you want to hold up to the light. Public repositories only." />
      <ReposView />
    </Container>
  )
}
