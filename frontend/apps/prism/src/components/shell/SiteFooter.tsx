import Link from 'next/link'
import { COPY } from '@pine/core/copy'
import { readPineEnv } from '@pine/data'
import { PrismMark } from '@/components/icons'

interface FooterLink {
  href: string
  label: string
  /** A file or API document, not a page: a plain link (no client-side navigation). */
  file?: boolean
}

// `api` mode: the agent endpoints are the Pine backend's (same origin); there is no Atom feed.
const AGENT_LINKS: FooterLink[] =
  readPineEnv().dataSource === 'api'
    ? [
        { href: '/llms.txt', label: 'llms.txt', file: true },
        { href: '/.well-known/pine.json', label: 'pine.json', file: true },
        { href: '/api/v1/agents/claims', label: 'Claim feed (JSON)', file: true },
      ]
    : [
        { href: '/agents', label: 'Agent API guide' },
        { href: '/llms.txt', label: 'llms.txt' },
        { href: '/.well-known/pine.json', label: 'pine.json' },
        { href: '/api/agent/v1/feed.xml', label: 'Atom feed' },
      ]

const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: 'Use Pine',
    links: [
      { href: '/claims', label: 'Light table' },
      { href: '/compose', label: 'Compose a claim' },
      { href: '/repos', label: 'Repositories' },
      { href: '/drafts', label: 'Drafts' },
      { href: '/dashboard', label: 'Dashboard' },
    ],
  },
  {
    title: 'Rules',
    links: [
      { href: '/policies', label: 'Policies' },
      { href: '/risks', label: 'Risks and launch gates' },
      { href: '/activity', label: 'Activity ledger' },
      { href: '/account', label: 'Account' },
    ],
  },
  { title: 'For agents', links: AGENT_LINKS },
]

export function SiteFooter() {
  return (
    <footer className="relative mt-24 border-t border-edge bg-void">
      <div aria-hidden className="spectrum-line opacity-40" />
      <div className="mx-auto grid max-w-[1240px] gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.4fr_repeat(3,1fr)] lg:px-8">
        <div className="max-w-[28rem]">
          <p className="flex items-center gap-2.5 font-cut text-[1.15rem] font-medium">
            <PrismMark size={28} /> Pine Prism
          </p>
          <p className="mt-4 text-[0.875rem] leading-[1.6] text-lumen-3">{COPY.notAReview}</p>
          <p className="mt-3 text-[0.875rem] leading-[1.6] text-lumen-3">{COPY.noMergeAuthority}</p>
        </div>
        {COLUMNS.map((c) => (
          <nav key={c.title} aria-label={c.title}>
            <p className="text-[0.875rem] font-semibold text-lumen">{c.title}</p>
            <ul className="mt-3 grid gap-2">
              {c.links.map((l) => (
                <li key={l.href}>
                  {l.file ? (
                    <a href={l.href} className="text-[0.9rem] text-lumen-2 transition-colors hover:text-lumen">
                      {l.label}
                    </a>
                  ) : (
                    <Link href={l.href} className="text-[0.9rem] text-lumen-2 transition-colors hover:text-lumen" prefetch={false}>
                      {l.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
    </footer>
  )
}
