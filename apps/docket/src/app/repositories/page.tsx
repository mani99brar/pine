import type { Metadata } from 'next'
import { Page, PageHeader } from '@/components/ui/layout'
import { RepositoryList } from '@/components/repos/repos'

export const metadata: Metadata = {
  title: 'Repositories',
  description: 'Browse public repositories, pull requests and commits, then file a claim about one exact commit.',
}

export default function RepositoriesPage() {
  return (
    <Page>
      <PageHeader
        title="Repositories"
        lead="Choose a public repository, then a pull request or commit. Every claim is about one exact commit."
      />
      <RepositoryList />
    </Page>
  )
}
