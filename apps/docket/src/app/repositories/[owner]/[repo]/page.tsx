import type { Metadata } from 'next'
import { Page } from '@/components/ui/layout'
import { RepositoryDetail } from '@/components/repos/repos'

type Params = { params: Promise<{ owner: string; repo: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { owner, repo } = await params
  return { title: `${owner}/${repo}`, description: `Pull requests and commits in ${owner}/${repo}, and claims filed about them.` }
}

export default async function RepoPage({ params }: Params) {
  const { owner, repo } = await params
  return (
    <Page>
      <RepositoryDetail owner={decodeURIComponent(owner)} name={decodeURIComponent(repo)} />
    </Page>
  )
}
