/** Site-level constants shared by metadata, JSON-LD and agent links. */
export const APP_NAME = 'Pine Field'

export function siteUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_PINE_SITE_URL
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return 'http://localhost:3003'
}

export const NAV = [
  { href: '/board', label: 'Board' },
  { href: '/repos', label: 'Repos' },
  { href: '/policies', label: 'Policies' },
  { href: '/agents', label: 'Agents' },
  { href: '/dashboard', label: 'Dashboard' },
] as const
