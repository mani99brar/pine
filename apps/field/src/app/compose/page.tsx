import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ComposePage } from './ComposePage'

export const metadata: Metadata = {
  title: 'Put a claim on the board',
  description: 'Pin an exact commit, choose a policy, write one bounded claim, set the deadlines and fund its market under a spending limit.',
}

export default function Page() {
  return (
    <Suspense>
      <ComposePage />
    </Suspense>
  )
}
