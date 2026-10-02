import Link from 'next/link'
import { COPY } from '@pine/core/copy'
import { Wordmark } from './Logo'

const groups = [
  {
    title: 'Use Pine Field',
    links: [
      ['/board', 'Browse open claims'],
      ['/compose', 'Put a claim on the board'],
      ['/repos', 'Browse repositories'],
      ['/drafts', 'Drafts and publications'],
      ['/dashboard', 'Dashboard'],
    ],
  },
  {
    title: 'Rules',
    links: [
      ['/policies', 'Policy catalog'],
      ['/risks', 'Risks and launch gates'],
      ['/activity', 'Activity and reconciliation'],
      ['/account', 'Account and settings'],
    ],
  },
  {
    title: 'For agents',
    links: [
      ['/agents', 'Agent API guide'],
      ['/llms.txt', 'llms.txt'],
      ['/.well-known/pine.json', 'Discovery descriptor'],
      ['/api/agent/v1/feed.xml', 'Atom feed of new claims'],
    ],
  },
] as const

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t-[3px] border-ink bg-sheet">
      <div className="mx-auto grid max-w-[1320px] gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[1.3fr_2fr]">
        <div className="max-w-[44ch]">
          <Wordmark />
          <p className="mt-4 text-[0.92rem] text-ink-2">{COPY.notAReview}</p>
          <p className="mt-3 text-[0.92rem] text-ink-2">{COPY.noIsNotSafety}</p>
          <p className="mt-3 text-[0.92rem] text-ink-2">{COPY.liquidityIsNotBounty}</p>
        </div>
        <div className="grid grid-cols-1 gap-8 xs:grid-cols-2 sm:grid-cols-3">
          {groups.map((g) => (
            <div key={g.title}>
              <p className="t-h3 text-[1rem]">{g.title}</p>
              <ul className="mt-3 space-y-2">
                {g.links.map(([href, label]) => (
                  <li key={href}>
                    <Link href={href} className="text-[0.92rem] text-ink-2 underline-offset-[3px] hover:text-ink hover:underline">
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-center justify-between gap-3 px-4 py-4 text-[0.8rem] text-ink-3 sm:px-6">
          <p>{COPY.noMergeAuthority}</p>
          <p>Seer markets, Reality.eth answers, Kleros arbitration. Integration not yet verified.</p>
        </div>
      </div>
    </footer>
  )
}
