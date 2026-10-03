import type { Metadata } from 'next'
import Link from 'next/link'
import { CrystalGlyph } from '@/components/crystal/CrystalGlyph'
import { Container } from '@/components/ui/primitives'

export const metadata: Metadata = { title: 'Nothing here', robots: { index: false } }

export default function NotFound() {
  return (
    <Container className="grid min-h-[60vh] items-center gap-10 py-16 md:grid-cols-[minmax(0,1fr)_auto]">
      <div>
        <p className="text-[0.9375rem] text-lumen-3">Error 404</p>
        <h1 className="t-h1 chroma mt-2 max-w-[16ch]">This beam hit nothing.</h1>
        <p className="t-lead mt-4 max-w-[52ch]">There is no page at this address. It may have been mistyped, or a claim may exist only in another browser&apos;s demo data.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/claims" className="btn btn-light">
            Open the light table
          </Link>
          <Link href="/" className="btn btn-glass">
            Go to the start
          </Link>
        </div>
      </div>
      <div className="hidden justify-center md:flex" aria-hidden>
        <CrystalGlyph seed="404:nothing" hue="#A69789" state="unlit" size={300} decorative />
      </div>
    </Container>
  )
}
