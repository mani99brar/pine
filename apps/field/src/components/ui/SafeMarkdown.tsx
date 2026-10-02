import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import { cn } from '@/lib/cn'

const SAFE_PROTOCOLS = /^(https?:|mailto:|ipfs:|#|\/)/i

/**
 * Untrusted Markdown → sanitized React elements. Raw HTML is never rendered (react-markdown ignores
 * it by default and rehype-sanitize strips anything unexpected). Links open with
 * rel="noopener noreferrer nofollow"; javascript: and data: URLs are dropped.
 */
export function SafeMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('prose-field untrusted [white-space:normal]', className)}>
      <ReactMarkdown
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        urlTransform={(url) => (SAFE_PROTOCOLS.test(url.trim()) ? url : '')}
        components={{
          a: ({ href, children: c }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                {c}
              </a>
            ) : (
              <span>{c}</span>
            ),
          img: ({ alt }) => <span className="text-ink-3">[image omitted{alt ? `: ${alt}` : ''}]</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
