import type { Metadata } from 'next'
import { Suspense } from 'react'
import { BoardView } from '@/components/board/BoardView'

export const metadata: Metadata = {
  title: 'The board: open claims',
  description:
    'Open code claims on Pine Field: market-implied chance of an accepted counterexample, time left in each evidence window and executable depth.',
  openGraph: { title: 'The board: open claims on Pine Field' },
}

export default function BoardPage() {
  return (
    <Suspense>
      <BoardView />
    </Suspense>
  )
}
