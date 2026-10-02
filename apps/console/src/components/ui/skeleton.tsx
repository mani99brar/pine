import { cn } from '@/lib/cn'

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden className={cn('animate-pulse rounded-chip bg-sunken', className)} style={style} />
}

export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('divide-y divide-line', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex h-11 items-center gap-4 px-4">
          <Skeleton className="h-3 w-3 rounded-full" />
          <Skeleton className="h-3 w-[38%]" />
          <Skeleton className="h-3 w-[14%]" />
          <Skeleton className="ml-auto h-3 w-[10%]" />
          <Skeleton className="h-3 w-[8%]" />
        </div>
      ))}
    </div>
  )
}
