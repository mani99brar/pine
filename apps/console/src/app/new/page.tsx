import type { Metadata } from 'next'
import { Composer } from '@/components/composer/composer'

export const metadata: Metadata = {
  title: 'New verification',
  description: 'Pin a commit, choose a policy, state one bounded claim and watch the immutable question and hashes form before you publish.',
}

export default async function NewVerificationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const draft = typeof sp.draft === 'string' ? sp.draft : undefined
  const source = typeof sp.source === 'string' ? sp.source : undefined
  const policy = typeof sp.policy === 'string' ? sp.policy : undefined
  return <Composer key={draft ?? 'new'} draftId={draft} source={source} policy={policy} />
}
