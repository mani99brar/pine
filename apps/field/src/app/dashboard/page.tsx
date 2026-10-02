import type { Metadata } from 'next'
import { DashboardView } from './DashboardView'

export const metadata: Metadata = {
  title: 'Your field',
  description: 'Your claims, positions, liquidity, redeemables and alerts.',
  robots: { index: false },
}

export default function DashboardPage() {
  return <DashboardView />
}
