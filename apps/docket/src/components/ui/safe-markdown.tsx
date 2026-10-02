import ReactMarkdown from 'react-markdown'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { cn } from '@/lib/cn'
import { safeHref } from './external-link'

const schema = {
  ...defaultSchema,
  // No images (tracking pixels, layout breakage) and no raw HTML ever reaches the DOM.
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => !['img', 'picture', 'source', 'video', 'audio', 'iframe', 'input'].includes(t)),
  protocols: { ...defaultSchema.protocols, href: ['http', 'https'] },
}

/**
 * Renders untrusted Markdown: raw HTML is not parsed (react-markdown default), output is sanitized,
 * links are forced to new-tab + noopener noreferrer nofollow and non-http(s) URLs are made inert.
 */
export function SafeMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('md untrusted', className)}>
      <ReactMarkdown
        skipHtml
        rehypePlugins={[[rehypeSanitize, schema]]}
        components={{
          a: ({ href, children: c }) => {
            const safe = safeHref(href)
            if (!safe) return <span className="text-graphite">{c}</span>
            return (
              <a href={safe} target="_blank" rel="noopener noreferrer nofollow">
                {c}
              </a>
            )
          },
          h1: ({ children: c }) => <p className="font-bold">{c}</p>,
          h2: ({ children: c }) => <p className="font-bold">{c}</p>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
