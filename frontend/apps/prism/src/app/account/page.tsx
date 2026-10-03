import type { Metadata } from 'next'
import { readPineEnv } from '@pine/data'
import { AccountView } from './AccountView'
import { ApiAccountView } from './ApiAccountView'
import { Container, PageHeader } from '@/components/ui/primitives'

// `api` mode: the Pine backend's wallet session is the account (Sign-In with Ethereum), GitHub is linked to it.
const backendIdentity = readPineEnv().dataSource === 'api'

export const metadata: Metadata = {
  title: 'Account',
  description: backendIdentity
    ? 'Sign in with your wallet, link GitHub through a zero-permission app, and read your notifications.'
    : 'GitHub sign-in with the read:user scope, wallet linking with Sign-In with Ethereum, defaults, notifications, export and deletion.',
  robots: { index: false },
}

export default function AccountPage() {
  return (
    <Container>
      <PageHeader
        title="Account"
        lead={backendIdentity ? 'Your wallet sign-in, linked GitHub account, terms and notifications.' : 'Your GitHub identity, linked wallets and defaults.'}
      />
      {backendIdentity ? <ApiAccountView /> : <AccountView />}
    </Container>
  )
}
