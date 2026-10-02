import type { Metadata } from 'next'
import { Settings } from '@/components/pages/settings'

export const metadata: Metadata = { title: 'Settings', description: 'GitHub sign-in, linked wallets, preferences and data export.' }

export default function SettingsPage() {
  return <Settings />
}
