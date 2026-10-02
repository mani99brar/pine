import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RepoView } from './RepoView'

type Params = { params: Promise<{ owner: string; repo: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { owner, repo } = await params
  return { title: `${owner}/${repo}`, description: `Pull requests and commits in ${owner}/${repo}, and the claims already on the board.` }
}

export default async function RepoPage({ params }: Params) {
  const { owner, repo } = await params
  return (
    <Suspense>
      <RepoView owner={decodeURIComponent(owner)} repo={decodeURIComponent(repo)} />
    </Suspense>
  )
}
