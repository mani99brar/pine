import type { Metadata, Viewport } from 'next'
import { Anybody, Archivo, JetBrains_Mono } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'
import { SiteHeader } from '@/components/shell/SiteHeader'
import { DemoBanner } from '@/components/shell/DemoBanner'
import { SiteFooter } from '@/components/shell/SiteFooter'
import { ThemeScript } from '@/components/shell/ThemeScript'
import { APP_NAME, siteUrl } from '@/lib/site'

const anybody = Anybody({ subsets: ['latin'], axes: ['wdth'], variable: '--font-anybody', display: 'swap' })
const archivo = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--font-archivo', display: 'swap' })
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' })

const description =
  'The open challenge board for code claims. Customers pin a commit and publish one bounded claim; investigators and agents try to demonstrate a reproducible counterexample before an absolute UTC deadline.'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: `${APP_NAME}: the open challenge board`, template: `%s | ${APP_NAME}` },
  description,
  applicationName: APP_NAME,
  openGraph: {
    type: 'website',
    siteName: APP_NAME,
    title: `${APP_NAME}: the open challenge board`,
    description,
  },
  twitter: { card: 'summary_large_image', title: APP_NAME, description },
  alternates: {
    types: {
      'text/plain': '/llms.txt',
      'application/atom+xml': '/api/agent/v1/feed.xml',
      'application/json': '/.well-known/pine.json',
    },
  },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ECEEF2' },
    { media: '(prefers-color-scheme: dark)', color: '#0E1330' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${anybody.variable} ${archivo.variable} ${jetbrains.variable}`} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-dvh">
        <Providers>
          <a
            href="#main"
            className="sr-only z-[70] rounded-[4px] bg-ink px-3 py-2 text-on-ink focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
          >
            Skip to content
          </a>
          <div className="flex min-h-dvh flex-col">
            <DemoBanner />
            <SiteHeader />
            <main id="main" className="flex-1">
              {children}
            </main>
            <SiteFooter />
          </div>
        </Providers>
      </body>
    </html>
  )
}
