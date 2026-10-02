'use client'

import '@rainbow-me/rainbowkit/styles.css'
import type { ReactNode } from 'react'
import type { Session } from 'next-auth'
import { lightTheme } from '@rainbow-me/rainbowkit'
import { PineProviders, setDemoTxDelays } from '@pine/react'
import { Toaster } from 'sonner'
import { TipProvider } from '@/components/ui/interactive'

// Screenshot QA: `?qa=1` makes simulated demo transactions near-instant for this browser session.
if (typeof window !== 'undefined') {
  try {
    if (new URLSearchParams(window.location.search).has('qa')) sessionStorage.setItem('pine-field:qa', '1')
    if (sessionStorage.getItem('pine-field:qa') === '1') setDemoTxDelays({ signatureMs: 60, pendingMs: [90, 140], offchainMs: 60, switchMs: 60 })
  } catch {
    /* storage unavailable: keep realistic delays */
  }
}

const rainbowTheme = lightTheme({
  accentColor: '#161a33',
  accentColorForeground: '#ffffff',
  borderRadius: 'small',
  fontStack: 'system',
  overlayBlur: 'small',
})

export function Providers({ children, session }: { children: ReactNode; session?: Session | null }) {
  return (
    <PineProviders appName="Pine Field" session={session} rainbowTheme={rainbowTheme}>
      <TipProvider delayDuration={250}>
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            classNames: {
              toast: '!rounded-[4px] !border-[1.5px] !border-[var(--ink)] !bg-[var(--sheet)] !text-[var(--ink)] !font-sans',
              description: '!text-[var(--ink-2)]',
            },
          }}
        />
      </TipProvider>
    </PineProviders>
  )
}
