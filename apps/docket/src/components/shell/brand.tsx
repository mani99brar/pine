import { cn } from '@/lib/cn'

/**
 * The Docket mark: a pine made of ruled lines, like entries on a register page.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" aria-hidden className={cn('size-7', className)}>
      <rect width="28" height="28" rx="3" fill="var(--color-violet)" />
      <g stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
        <path d="M12 7.2h4" />
        <path d="M10 11.6h8" />
        <path d="M8 16h12" />
        <path d="M6 20.4h16" />
      </g>
      <path d="M14 22.6v2.2" stroke="var(--color-flag)" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <BrandMark />
      <span className="text-[1.2rem] leading-none font-[800] tracking-[-0.02em]">
        Pine <span className="font-[500] text-graphite">Docket</span>
      </span>
    </span>
  )
}
