import type { Metadata } from 'next'
import { AccountView } from './AccountView'
import { Container, PageHeader } from '@/components/ui/primitives'

export const metadata: Metadata = {
  title: 'Account',
  description: 'GitHub sign-in with the read:user scope, wallet linking with Sign-In with Ethereum, defaults, notifications, export and deletion.',
  robots: { index: false },
}

export default function AccountPage() {
  return (
    <Container>
      <PageHeader title="Account" lead="Your GitHub identity, linked wallets and defaults." />
      <AccountView />
    </Container>
  )
}
