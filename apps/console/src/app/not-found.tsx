import type { Metadata } from 'next'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'

export const metadata: Metadata = { title: 'Not found' }

export default function NotFound() {
  return (
    <div className="flex min-h-[calc(100dvh-48px-28px)] items-center bg-surface px-4 py-16 sm:px-8">
      <div className="mx-auto w-full max-w-[640px]">
        <div aria-hidden className="relative mb-8 h-6">
          <span className="graduation absolute inset-x-0 bottom-0 h-3 text-line-strong" style={{ ['--tick-gap' as string]: '10px' }} />
          <span className="absolute inset-x-0 bottom-0 h-px bg-line-strong" />
          <span className="absolute bottom-0 left-[62%] h-6 w-[2px] bg-flare" />
        </div>
        <p className="mono-cond text-[12px] text-muted">404</p>
        <h1 className="stretch-display mt-1 text-[32px] font-[750] leading-tight">Nothing is pinned at this path</h1>
        <p className="mt-3 text-[15px] leading-[1.6] text-muted">
          The page or claim you asked for does not exist here. Claim ids look like <span className="mono-cond text-[13px] text-bark">pine-0042</span>. Press <Kbd>⌘K</Kbd> to search
          everything, or paste a GitHub URL to start a verification.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button asChild variant="primary">
            <Link href="/claims">Browse claims</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/new">Verify a commit</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/">Console home</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
