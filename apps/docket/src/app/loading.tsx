import { Skeleton } from '@/components/ui/layout'

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="mx-auto w-full max-w-[86rem] space-y-5 px-4 pt-10 sm:px-6 lg:px-10">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-10 w-2/3 max-w-xl" />
      <Skeleton className="h-5 w-1/2 max-w-lg" />
      <div className="space-y-3 pt-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  )
}
