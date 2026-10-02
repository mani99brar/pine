import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PullDetail } from '@/components/pages/repos'

type Props = { params: Promise<{ owner: string; repo: string; number: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { owner, repo, number } = await params
  return { title: `${owner}/${repo}#${number}`, description: `Commits on ${owner}/${repo} pull request #${number}, ready to verify.` }
}

export default async function PullPage({ params }: Props) {
  const { owner, repo, number } = await params
  const n = Number(number)
  if (!Number.isInteger(n) || n <= 0) notFound()
  return <PullDetail owner={decodeURIComponent(owner)} repo={decodeURIComponent(repo)} number={n} />
}
