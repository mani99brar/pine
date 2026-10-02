import type { Metadata } from 'next'
import { Activity } from '@/components/pages/activity'

export const metadata: Metadata = { title: 'Activity', description: 'Transaction history with funding and redemption reconciliation.' }

export default function ActivityPage() {
  return <Activity />
}
