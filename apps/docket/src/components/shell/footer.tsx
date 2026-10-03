import Link from 'next/link'
import { COPY } from '@pine/core/copy'
import { Wordmark } from './brand'
import { DemoBannerRestore } from './demo-restore'

const COLUMNS = [
  {
    title: 'Procedure',
    links: [
      { href: '/how-it-works', label: 'How it works and glossary' },
      { href: '/policies', label: 'Policy catalog' },
      { href: '/risks', label: 'Risks and launch gates' },
    ],
  },
  {
    title: 'Your filings',
    links: [
      { href: '/file', label: 'File a verification' },
      { href: '/my-docket', label: 'My docket' },
      { href: '/filings', label: 'Drafts and filings' },
      { href: '/activity', label: 'Activity ledger' },
      { href: '/account', label: 'Account' },
    ],
  },
  {
    title: 'For investigators and agents',
    links: [
      { href: '/docket', label: 'Open claims' },
      { href: '/agents', label: 'Agent API guide' },
      { href: '/llms.txt', label: 'llms.txt', raw: true },
      { href: '/api/agent/v1/feed.xml', label: 'Atom feed of new claims', raw: true },
    ],
  },
]

export function Footer() {
  return (
    <footer className="mt-auto border-t border-rule bg-sheet print:hidden">
      <div className="mx-auto max-w-[86rem] px-4 py-12 sm:px-6 lg:px-10">
        <div className="grid gap-10 lg:grid-cols-[1.3fr_repeat(3,1fr)]">
          <div className="max-w-sm">
            <Wordmark />
            <p className="mt-4 text-sm text-graphite">{COPY.notAReview}</p>
            <p className="mt-3 text-sm text-graphite">{COPY.noMergeAuthority}</p>
          </div>
          {COLUMNS.map((col) => (
            <nav key={col.title} aria-label={`Footer: ${col.title}`}>
              <h2 className="text-base font-bold">{col.title}</h2>
              <ul className="mt-3 space-y-2 text-[15px]">
                {col.links.map((l) => (
                  <li key={l.href}>
                    {'raw' in l && l.raw ? (
                      <a href={l.href} className="link">
                        {l.label}
                      </a>
                    ) : (
                      <Link href={l.href} className="link">
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-10 flex flex-wrap items-start justify-between gap-4 border-t border-rule pt-6 text-sm text-graphite">
          <p className="max-w-[70ch]">{COPY.noIsNotSafety}</p>
          <DemoBannerRestore />
        </div>
      </div>
    </footer>
  )
}
