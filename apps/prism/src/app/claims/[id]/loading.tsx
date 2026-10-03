import { Container, Skeleton } from '@/components/ui/primitives'

export default function Loading() {
  return (
    <Container wide className="pt-16">
      <div className="flex gap-6">
        <Skeleton className="h-44 w-28" />
        <div className="flex-1">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-4 h-12 w-3/4" />
        </div>
      </div>
      <Skeleton className="mt-10 h-80 w-full" />
      <span className="sr-only" role="status">
        Loading
      </span>
    </Container>
  )
}
