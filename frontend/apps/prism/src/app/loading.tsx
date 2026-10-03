import { Container, Skeleton } from '@/components/ui/primitives'

export default function Loading() {
  return (
    <Container className="pt-16">
      <Skeleton className="h-12 w-80" />
      <Skeleton className="mt-4 h-5 w-[32rem] max-w-full" />
      <Skeleton className="mt-10 h-72 w-full" />
      <span className="sr-only" role="status">
        Loading
      </span>
    </Container>
  )
}
