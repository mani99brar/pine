import type { Metadata, Viewport } from 'next'
import { Azeret_Mono, Geologica, Instrument_Sans } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'
import { SiteHeader } from '@/components/shell/SiteHeader'
import { DemoBanner } from '@/components/shell/DemoBanner'
import { DevForkGuard } from '@/components/shell/DevForkGuard'
import { SiteFooter } from '@/components/shell/SiteFooter'
import { RouteProgress } from '@/components/shell/RouteProgress'
import { APP_DESCRIPTION, APP_NAME, siteUrl } from '@/lib/site'
import { readPineEnv } from '@pine/data'

// `api` mode: the agent endpoints are the Pine backend's (/.well-known/pine.json and /api/v1/agents/*, same origin).
const backendAgentLinks = readPineEnv().dataSource === 'api'

const geologica = Geologica({ subsets: ['latin'], axes: ['SHRP', 'CRSV'], variable: '--font-geologica', display: 'swap' })
const instrument = Instrument_Sans({ subsets: ['latin'], axes: ['wdth'], variable: '--font-instrument', display: 'swap' })
const azeret = Azeret_Mono({ subsets: ['latin'], variable: '--font-azeret', display: 'swap' })

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: `${APP_NAME}: hold your claim up to the light`, template: `%s | ${APP_NAME}` },
  description: APP_DESCRIPTION,
  applicationName: APP_NAME,
  openGraph: {
    type: 'website',
    siteName: APP_NAME,
    title: `${APP_NAME}: hold your claim up to the light`,
    description: APP_DESCRIPTION,
  },
  twitter: { card: 'summary_large_image', title: APP_NAME, description: APP_DESCRIPTION },
  alternates: {
    types: backendAgentLinks
      ? {
          'text/plain': '/llms.txt',
          'application/json': [
            { url: '/.well-known/pine.json', title: 'Pine deployment and agent conventions' },
            { url: '/api/v1/agents/claims', title: 'Claim feed' },
          ],
        }
      : {
          'text/plain': '/llms.txt',
          'application/atom+xml': '/api/agent/v1/feed.xml',
          'application/json': '/.well-known/pine.json',
        },
  },
}

export const viewport: Viewport = {
  themeColor: '#16110f',
  colorScheme: 'dark',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geologica.variable} ${instrument.variable} ${azeret.variable}`} suppressHydrationWarning>
      <body>
        <Providers>
          <a
            href="#main"
            className="cut-sm sr-only z-[95] bg-lumen px-3 py-2 font-semibold text-umbra focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
          >
            Skip to content
          </a>
          <RouteProgress />
          <div className="relative z-[1] flex min-h-dvh flex-col">
            <DemoBanner />
            <DevForkGuard />
            <SiteHeader />
            <main id="main" className="flex-1" tabIndex={-1}>
              {children}
            </main>
            <SiteFooter />
          </div>
        </Providers>
      </body>
    </html>
  )
}
