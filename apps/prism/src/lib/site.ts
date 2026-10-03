/** Site-level constants shared by metadata, JSON-LD and agent links. */
export const APP_NAME = 'Pine Prism'

export const APP_DESCRIPTION =
  'Hold a claim about your code up to the light. Pin an exact commit, publish one bounded, policy-versioned claim, and fund a Seer market where anyone can try to demonstrate a reproducible counterexample before an absolute UTC deadline.'

export function siteUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_PINE_SITE_URL
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return 'http://localhost:3004'
}

export const NAV = [
  { href: '/claims', label: 'Light table' },
  { href: '/compose', label: 'Compose' },
  { href: '/repos', label: 'Repositories' },
  { href: '/policies', label: 'Policies' },
  { href: '/agents', label: 'Agents' },
] as const

export const SECONDARY_NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/drafts', label: 'Drafts' },
  { href: '/activity', label: 'Activity' },
  { href: '/account', label: 'Account' },
  { href: '/risks', label: 'Risks and launch gates' },
] as const
