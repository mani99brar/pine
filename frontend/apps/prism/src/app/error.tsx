'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { RotateCw } from 'lucide-react'
import { Container } from '@/components/ui/primitives'

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])
  return (
    <Container className="py-20">
      <p className="text-[0.9375rem] text-lumen-3">Something broke on this page</p>
      <h1 className="t-h1 chroma mt-2 max-w-[18ch]">The light scattered.</h1>
      <p className="t-lead mt-4 max-w-[56ch]">This part of the page failed to render. Your drafts and transaction progress are saved in this browser, so you can try again without losing anything.</p>
      {error.digest && <p className="t-code mt-3 text-[0.78rem] text-lumen-3">Reference {error.digest}</p>}
      <div className="mt-8 flex flex-wrap gap-3">
        <button type="button" className="btn btn-light" onClick={reset}>
          <RotateCw size={15} aria-hidden /> Try again
        </button>
        <Link href="/" className="btn btn-glass">
          Go to the start
        </Link>
      </div>
    </Container>
  )
}
