import { cn } from '@/lib/cn'

/** The mark is a tiny tension bar: two anchors, a hatched YES pull, a solid NO pull and the knot. */
export function LogoMark({ className, size = 28 }: { className?: string; size?: number }) {
  const h = Math.round(size * 0.5)
  return (
    <svg width={size} height={h} viewBox="0 0 28 14" aria-hidden className={cn('block shrink-0', className)}>
      <defs>
        <pattern id="pf-hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect width="3" height="3" fill="var(--flare)" />
          <rect width="1.1" height="3" fill="var(--hatch)" />
        </pattern>
      </defs>
      <rect x="0" y="1" width="1.6" height="12" fill="var(--ink)" />
      <rect x="2.4" y="4" width="8.2" height="6" fill="url(#pf-hatch)" />
      <rect x="13.4" y="4" width="12.2" height="6" fill="var(--cobalt)" />
      <rect x="10.9" y="0.5" width="2.2" height="13" fill="var(--ink)" />
      <rect x="26.4" y="1" width="1.6" height="12" fill="var(--ink)" />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="font-display text-[1.2rem] leading-none font-[800] tracking-[-0.01em] [font-stretch:128%]">
        Pine Field
      </span>
    </span>
  )
}
