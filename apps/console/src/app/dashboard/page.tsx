import type { Metadata } from 'next'
import { Dashboard } from '@/components/pages/dashboard'

export const metadata: Metadata = { title: 'Dashboard', description: 'Your claims, outcome positions, liquidity positions, redeemables and alerts.' }

export default function DashboardPage() {
  return <Dashboard />
}
