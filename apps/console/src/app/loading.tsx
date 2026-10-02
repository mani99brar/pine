import { Skeleton } from '@/components/ui/skeleton'

export default function Loading() {
  return (
    <div role="status" aria-label="Loading">
      <div className="border-b border-line bg-surface px-4 pb-5 pt-6 sm:px-8">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-3 h-4 w-[min(520px,90%)]" />
      </div>
      <div className="space-y-3 bg-surface px-4 py-6 sm:px-8">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  )
}
