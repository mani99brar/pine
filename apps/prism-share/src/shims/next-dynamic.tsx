/**
 * `next/dynamic` for the static build: React.lazy + Suspense. Everything renders on the client, so
 * `ssr: false` needs no special handling; `loading` becomes the Suspense fallback. The import becomes a
 * separate chunk, exactly as in Prism (three.js stays out of the main bundle).
 */
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'

type Loaded<P> = ComponentType<P> | { default: ComponentType<P> }

export interface DynamicOptions {
  ssr?: boolean
  loading?: (props: { isLoading?: boolean; pastDelay?: boolean; error?: Error | null }) => ReactNode
}

export default function dynamic<P extends object>(loader: () => Promise<Loaded<P>>, options: DynamicOptions = {}): ComponentType<P> {
  const Lazy = lazy(async () => {
    const mod = await loader()
    const component = (typeof mod === 'object' && mod !== null && 'default' in mod ? mod.default : mod) as ComponentType<P>
    return { default: component }
  })
  const Loading = options.loading
  function DynamicComponent(props: P) {
    return (
      <Suspense fallback={Loading ? <Loading isLoading pastDelay error={null} /> : null}>
        <Lazy {...props} />
      </Suspense>
    )
  }
  DynamicComponent.displayName = 'Dynamic'
  return DynamicComponent
}
