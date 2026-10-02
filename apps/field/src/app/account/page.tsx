import type { Metadata } from 'next'
import { AccountView } from './AccountView'

export const metadata: Metadata = {
  title: 'Account and settings',
  description: 'Sign in with GitHub (read-only public scope), link wallets with Sign-In with Ethereum, and set your defaults.',
  robots: { index: false },
}

export default function AccountPage() {
  return <AccountView />
}
