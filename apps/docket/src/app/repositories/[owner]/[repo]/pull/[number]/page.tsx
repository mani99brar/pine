import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Page } from '@/components/ui/layout'
import { PullDetail } from '@/components/repos/repos'

type Params = { params: Promise<{ owner: string; repo: string; number: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { owner, repo, number } = await params
  return { title: `${owner}/${repo} #${number}`, description: `Commits in pull request #${number}. Choose one to file a claim about.` }
}

export default async function PullPage({ params }: Params) {
  const { owner, repo, number } = await params
  const n = Number(number)
  if (!Number.isInteger(n) || n <= 0) notFound()
  return (
    <Page>
      <PullDetail owner={decodeURIComponent(owner)} name={decodeURIComponent(repo)} number={n} />
    </Page>
  )
}
