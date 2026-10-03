import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RepoView } from './RepoView'
import { Container, Skeleton } from '@/components/ui/primitives'

type Params = { params: Promise<{ owner: string; repo: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { owner, repo } = await params
  return {
    title: `${owner}/${repo}`,
    description: `Pull requests and commits in ${owner}/${repo}. Pick the exact commit to put a claim on.`,
  }
}

export default async function RepoPage({ params }: Params) {
  const { owner, repo } = await params
  return (
    <Container>
      <Suspense fallback={<Skeleton className="mt-10 h-72 w-full" />}>
        <RepoView owner={decodeURIComponent(owner)} repo={decodeURIComponent(repo)} />
      </Suspense>
    </Container>
  )
}
