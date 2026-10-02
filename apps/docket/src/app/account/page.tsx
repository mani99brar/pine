import type { Metadata } from 'next'
import { Page, PageHeader } from '@/components/ui/layout'
import { AccountView } from '@/components/account/account-view'
import { ClientOnly } from '@/components/ui/client-only'
import { ViewSkeleton } from '@/components/ui/view-skeleton'

export const metadata: Metadata = {
  title: 'Account',
  description: 'Sign in with GitHub, link wallets, set defaults and manage your data.',
  robots: { index: false },
}

export default function AccountPage() {
  return (
    <Page>
      <PageHeader title="Account" lead="Your GitHub identity, linked wallets and defaults." />
      <ClientOnly fallback={<ViewSkeleton />}>
        <AccountView />
      </ClientOnly>
    </Page>
  )
}
