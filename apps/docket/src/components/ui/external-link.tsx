import { ExternalLink as ExternalIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Every link that leaves Pine goes through here: new tab, no referrer, no follow.
 * `href` may come from untrusted content, so only http(s) and ipfs gateways are kept clickable.
 */
export function ExternalLink({
  href,
  children,
  className,
  icon = true,
}: {
  href: string | undefined | null
  children: ReactNode
  className?: string
  icon?: boolean
}) {
  const safe = safeHref(href)
  if (!safe) return <span className={cn('untrusted', className)}>{children}</span>
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer nofollow" className={cn('link inline', className)}>
      {children}
      {icon ? (
        <>
          <ExternalIcon aria-hidden className="ml-1 inline size-[0.85em] -translate-y-px align-baseline" />
          <span className="sr-only"> (opens in a new tab)</span>
        </>
      ) : null}
    </a>
  )
}

export function safeHref(href: string | undefined | null): string | null {
  if (!href) return null
  try {
    const url = new URL(href)
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString()
    return null
  } catch {
    return null
  }
}
