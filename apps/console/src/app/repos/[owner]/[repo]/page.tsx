import type { Metadata } from 'next'
import { RepoDetail } from '@/components/pages/repos'

type Props = { params: Promise<{ owner: string; repo: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { owner, repo } = await params
  return { title: `${owner}/${repo}`, description: `Pull requests, commits and Pine claims for ${owner}/${repo}.` }
}

export default async function RepoPage({ params }: Props) {
  const { owner, repo } = await params
  return <RepoDetail owner={decodeURIComponent(owner)} repo={decodeURIComponent(repo)} />
}
