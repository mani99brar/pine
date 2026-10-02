import type { Metadata, Viewport } from 'next'
import { Archivo, Martian_Mono } from 'next/font/google'
import { cookies } from 'next/headers'
import { getOrigin } from '@/lib/server/data'
import { auth } from '@/auth'
import { THEME_COOKIE, parseTheme } from '@/lib/theme'
import { AppShell } from '@/components/shell/app-shell'
import { Providers } from './providers'
import '@rainbow-me/rainbowkit/styles.css'
import './globals.css'

const archivo = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--font-archivo', display: 'swap' })
const martian = Martian_Mono({ subsets: ['latin'], axes: ['wdth'], variable: '--font-martian', display: 'swap' })

export async function generateMetadata(): Promise<Metadata> {
  const origin = await getOrigin()
  return {
    metadataBase: new URL(origin),
    title: { default: 'Pine Console: adversarial verification for pinned commits', template: '%s | Pine Console' },
    description:
      'Pin an exact commit, publish one bounded claim about it, and fund a prediction market that rewards anyone who demonstrates a reproducible counterexample before a UTC deadline.',
    applicationName: 'Pine Console',
    alternates: { types: { 'application/json': '/.well-known/pine.json', 'application/atom+xml': '/api/agent/v1/feed.xml' } },
    openGraph: {
      type: 'website',
      siteName: 'Pine Console',
      title: 'Pine Console',
      description: 'Publish one bounded claim about a pinned commit and let a market look for the counterexample.',
    },
    twitter: { card: 'summary' },
  }
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f2f4f1' },
    { media: '(prefers-color-scheme: dark)', color: '#0d1615' },
  ],
  width: 'device-width',
  initialScale: 1,
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value)
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${martian.variable}`}
      data-theme={theme === 'system' ? undefined : theme}
      suppressHydrationWarning
    >
      <body>
        <Providers session={session} theme={theme}>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  )
}
