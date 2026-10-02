import { ExternalLink as Icon } from 'lucide-react'
import { cn } from '@/lib/cn'

/** Every external link: new tab, no referrer, no follow. Only http(s) URLs are rendered as links. */
export function ExternalLink({
  href,
  children,
  className,
  icon = true,
}: {
  href: string | undefined
  children: React.ReactNode
  className?: string
  icon?: boolean
}) {
  const safe = href && /^https?:\/\//i.test(href) ? href : undefined
  if (!safe) return <span className={className}>{children}</span>
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={cn('relative inline-flex items-center gap-1 text-needle underline-offset-2 hover:underline', className)}
    >
      {children}
      {icon ? <Icon size={12} aria-hidden className="shrink-0 opacity-70" /> : null}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
