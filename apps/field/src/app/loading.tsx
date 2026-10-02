export default function Loading() {
  return (
    <div className="mx-auto max-w-[1320px] px-4 pt-10 sm:px-6" aria-busy>
      <span className="sr-only">Loading</span>
      <span className="skeleton block h-10 w-80" />
      <span className="skeleton mt-4 block h-5 w-[32rem] max-w-full" />
      <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <span key={i} className="skeleton block h-56" />
        ))}
      </div>
    </div>
  )
}
