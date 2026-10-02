/** Site URL usable in client components: the configured public URL, or the current origin. */
export function siteUrlClient(): string {
  const env = process.env.NEXT_PUBLIC_SITE_URL
  if (typeof window !== 'undefined' && (!env || env.includes('localhost'))) return window.location.origin
  return (env ?? 'http://localhost:3003').replace(/\/$/, '')
}
