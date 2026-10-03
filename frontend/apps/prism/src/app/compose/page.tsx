import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ComposePage } from './ComposePage'

export const metadata: Metadata = {
  title: 'Compose a claim',
  description: 'Cut a claim facet by facet: pin an exact commit, choose a policy, state one bounded claim, pin the environment, set the deadline and oracle, and fund its market under a spending limit.',
  robots: { index: false },
}

export default function Page() {
  return (
    <Suspense>
      <ComposePage />
    </Suspense>
  )
}
