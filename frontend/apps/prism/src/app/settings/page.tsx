import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { readPineEnv } from '@pine/data'
import { GitHubLinkOutcome } from '../account/GitHubLinkOutcome'
import { Container } from '@/components/ui/primitives'

export const metadata: Metadata = {
  title: 'GitHub link',
  robots: { index: false, follow: false },
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/**
 * `api` mode: the backend's GitHub callback redirects here with `?github=linked|error` (packages/api auth-routes). Any
 * other visit, and every visit outside `api` mode, goes to the account page.
 */
export default async function SettingsPage({ searchParams }: Props) {
  const { github } = await searchParams
  if (readPineEnv().dataSource !== 'api' || (github !== 'linked' && github !== 'error')) redirect('/account')
  return (
    <Container>
      <GitHubLinkOutcome outcome={github} />
    </Container>
  )
}
