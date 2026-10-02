import type { Metadata } from 'next'
import { ActivityView } from './ActivityView'

export const metadata: Metadata = {
  title: 'Activity and reconciliation',
  description: 'Transaction history behind the board, with funding and redemption reconciliation per claim.',
}

export default function ActivityPage() {
  return <ActivityView />
}
