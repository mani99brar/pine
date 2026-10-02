import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import { cn } from '@/lib/cn'

/**
 * Renders untrusted or policy Markdown. rehype-sanitize strips scripts/handlers;
 * links are forced to http(s) and open with rel="noopener noreferrer nofollow".
 */
export function SafeMarkdown({ children, className, compact }: { children: string; className?: string; compact?: boolean }) {
  return (
    <div className={cn('prose-pine wrap-anywhere min-w-0', compact && 'compact', className)}>
      <ReactMarkdown
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        urlTransform={(url) => (/^https?:\/\//i.test(url) || url.startsWith('#') ? url : '')}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span className="text-muted">[image: {alt || 'untitled'}]</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

/** Untrusted plain text: preserved whitespace, wraps anywhere, clipped height optional. */
export function PlainText({ children, className, clamp }: { children: string; className?: string; clamp?: boolean }) {
  return (
    <p className={cn('wrap-anywhere whitespace-pre-wrap', clamp && 'line-clamp-3', className)}>{children}</p>
  )
}
