/** Absolute site URL used for metadata, JSON-LD and agent links. */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ??
  process.env.NEXT_PUBLIC_PINE_SITE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3002')
).replace(/\/$/, '')

export const APP_NAME = 'Pine Docket'
