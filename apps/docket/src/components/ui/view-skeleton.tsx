import { Skeleton } from './layout'

export function ViewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-4">
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  )
}
