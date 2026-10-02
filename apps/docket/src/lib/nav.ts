export const PRIMARY_NAV = [
  { href: '/docket', label: 'Docket', match: ['/docket', '/claims'] },
  { href: '/my-docket', label: 'My docket', match: ['/my-docket', '/filings', '/activity'] },
  { href: '/repositories', label: 'Repositories', match: ['/repositories'] },
  { href: '/policies', label: 'Policies', match: ['/policies'] },
  { href: '/how-it-works', label: 'How it works', match: ['/how-it-works'] },
] as const

export const SECONDARY_NAV = [
  { href: '/filings', label: 'Drafts and filings' },
  { href: '/activity', label: 'Activity ledger' },
  { href: '/risks', label: 'Risks and launch gates' },
  { href: '/agents', label: 'For agents' },
  { href: '/account', label: 'Account' },
] as const

export function isActive(pathname: string, match: readonly string[]) {
  return match.some((m) => pathname === m || pathname.startsWith(`${m}/`))
}
