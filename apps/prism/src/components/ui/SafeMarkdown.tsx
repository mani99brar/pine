'use client'

import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import { cn } from '@/lib/cn'

const safeHref = (href: string | undefined) => (href && /^https:\/\//i.test(href) ? href : undefined)

/**
 * Untrusted Markdown, rendered inert: raw HTML is dropped, output is sanitized, only https links become
 * anchors (rel noopener noreferrer nofollow), images are shown as their text, and headings are flattened
 * so third-party text cannot impersonate the page's structure.
 */
const components: Components = {
  a: ({ href, children }) => {
    const ok = safeHref(href)
    if (!ok) return <span className="text-lumen-2">{children}</span>
    let host = ''
    try {
      host = new URL(ok).hostname
    } catch {
      return <span className="text-lumen-2">{children}</span>
    }
    // Link text is untrusted, so the real destination host is always printed next to it.
    return (
      <>
        <a href={ok} target="_blank" rel="noopener noreferrer nofollow" className="link break-all" title={ok}>
          {children}
        </a>
        <span className="t-code text-[0.8em] text-lumen-3"> ({host})</span>
      </>
    )
  },
  img: ({ alt }) => <span className="text-lumen-3">[image: {alt || 'no description'}]</span>,
  h1: ({ children }) => <p className="font-semibold text-lumen">{children}</p>,
  h2: ({ children }) => <p className="font-semibold text-lumen">{children}</p>,
  h3: ({ children }) => <p className="font-semibold text-lumen">{children}</p>,
  h4: ({ children }) => <p className="font-semibold text-lumen">{children}</p>,
  h5: ({ children }) => <p className="font-semibold text-lumen">{children}</p>,
  h6: ({ children }) => <p className="font-semibold text-lumen">{children}</p>,
  pre: ({ children }) => <pre className="t-code untrusted cut-sm my-2 border border-edge bg-void p-3 text-lumen-2">{children}</pre>,
  code: ({ children }) => <code className="t-code rounded-[3px] bg-void px-1 py-0.5 text-[0.8em] text-lumen">{children}</code>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  table: ({ children }) => <div className="overflow-x-auto"><table className="text-[0.85em]">{children}</table></div>,
}

export function SafeMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('untrusted text-[0.9375rem] leading-[1.6] text-lumen-2 [white-space:normal]', className)}>
      <ReactMarkdown skipHtml rehypePlugins={[rehypeSanitize]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
