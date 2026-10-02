import { Skeleton } from '@/components/ui/skeleton'

export default function ClaimLoading() {
  return (
    <div role="status" aria-label="Loading claim">
      <div className="border-b border-line bg-surface px-4 pb-3 pt-4 sm:px-6">
        <div className="flex gap-3">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-6 w-36" />
        </div>
        <Skeleton className="mt-3 h-7 w-[min(560px,90%)]" />
        <Skeleton className="mt-3 h-4 w-[min(420px,80%)]" />
        <div className="mt-4 flex gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-16" />
          ))}
        </div>
      </div>
      <div className="space-y-4 bg-surface p-6">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  )
}
