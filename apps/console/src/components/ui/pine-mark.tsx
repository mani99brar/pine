import { cn } from '@/lib/cn'

/** Pine mark: five graduation ticks of increasing length stacked into a pine, on a trunk. */
export function PineMark({ className, size = 20 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={cn('shrink-0', className)} aria-hidden>
      <g stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
        <line x1={9} x2={11} y1={2.5} y2={2.5} />
        <line x1={7.5} x2={12.5} y1={5.5} y2={5.5} />
        <line x1={6} x2={14} y1={8.5} y2={8.5} />
        <line x1={4.5} x2={15.5} y1={11.5} y2={11.5} />
        <line x1={3} x2={17} y1={14.5} y2={14.5} />
        <line x1={10} x2={10} y1={14.5} y2={18} />
      </g>
    </svg>
  )
}

export function GitHubMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}
