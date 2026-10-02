import type { Metadata, Viewport } from 'next'
import { Atkinson_Hyperlegible_Mono, Atkinson_Hyperlegible_Next, Source_Serif_4 } from 'next/font/google'
import { Providers } from './providers'
import { Header } from '@/components/shell/header'
import { Footer } from '@/components/shell/footer'
import { DemoBanner } from '@/components/shell/demo-banner'
import { SITE_URL } from '@/lib/site'
import { auth } from '@/auth'
import './globals.css'

const atkinson = Atkinson_Hyperlegible_Next({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-atkinson',
  display: 'swap',
})

const atkinsonMono = Atkinson_Hyperlegible_Mono({
  subsets: ['latin'],
  variable: '--font-atkinson-mono',
  display: 'swap',
})

const record = Source_Serif_4({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-record',
  axes: ['opsz'],
  style: ['normal', 'italic'],
  display: 'swap',
})

const description =
  'File one bounded, policy-versioned claim about an exact commit, fund a prediction market, and let independent investigators try to demonstrate a counterexample before a fixed UTC deadline.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'Pine Docket: put a claim about your code on the record', template: '%s | Pine Docket' },
  description,
  applicationName: 'Pine Docket',
  alternates: {
    types: {
      'application/atom+xml': [{ url: '/api/agent/v1/feed.xml', title: 'Pine Docket: newly opened claims' }],
      'text/plain': [{ url: '/llms.txt', title: 'llms.txt' }],
    },
  },
  openGraph: {
    type: 'website',
    siteName: 'Pine Docket',
    title: 'Pine Docket',
    description,
    url: '/',
  },
  twitter: { card: 'summary', title: 'Pine Docket', description },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  themeColor: '#4433a6',
  colorScheme: 'light',
  width: 'device-width',
  initialScale: 1,
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth().catch(() => null)
  return (
    <html lang="en" className={`${atkinson.variable} ${atkinsonMono.variable} ${record.variable}`}>
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only z-50 bg-flag px-4 py-3 font-bold text-ink focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to main content
        </a>
        <Providers session={session}>
          <DemoBanner />
          <Header />
          <div className="flex flex-1 flex-col">{children}</div>
          <Footer />
        </Providers>
      </body>
    </html>
  )
}
